-- Wallet changes are deltas on the stored balance. A client cannot
-- replace the balance with a guessed number (that was resetting loads).

create or replace function public.apply_wallet(p_token text, p_delta numeric)
returns numeric
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_balance numeric;
begin
  if p_delta is null or p_delta = 0 then
    select balance into new_balance
    from public.players
    where phone = public.session_phone(p_token);
    if new_balance is null then
      raise exception 'Not signed in';
    end if;
    return new_balance;
  end if;
  update public.players
  set balance = greatest(0, round(balance + p_delta, 2))
  where phone = public.session_phone(p_token)
  returning balance into new_balance;
  if new_balance is null then
    raise exception 'Not signed in';
  end if;
  return new_balance;
end;
$$;

-- Absolute writes are ignored. Old clients must not clobber the wallet.
create or replace function public.persist_balance(p_token text, p_balance numeric)
returns numeric
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_balance numeric;
begin
  select balance into new_balance
  from public.players
  where phone = public.session_phone(p_token);
  if new_balance is null then
    raise exception 'Not signed in';
  end if;
  return new_balance;
end;
$$;

create or replace function public.broadcast_wallet()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform realtime.send(
    jsonb_build_object('phone', new.phone, 'balance', new.balance),
    'balance',
    'wallet:' || new.phone,
    false
  );
  return new;
end;
$$;

drop trigger if exists players_broadcast_wallet on public.players;
create trigger players_broadcast_wallet
after update of balance on public.players
for each row
execute function public.broadcast_wallet();

revoke all on function public.apply_wallet(text, numeric) from public;
grant execute on function public.apply_wallet(text, numeric) to anon, authenticated;
