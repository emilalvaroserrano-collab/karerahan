-- Accounts in Postgres, plus the races/bets tables the betting server uses.
-- Browser roles cannot read password hashes. They call the functions below.
-- The service-role key (server only) writes races and bets.

create extension if not exists pgcrypto;

create table if not exists public.players (
  phone text primary key,
  pass_hash text not null,
  role text not null check (role in ('admin', 'player')),
  balance numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.house (
  id int primary key default 1 check (id = 1),
  balance numeric not null default 0
);

insert into public.house (id, balance)
values (1, 0)
on conflict (id) do nothing;

create table if not exists public.sessions (
  token text primary key,
  phone text not null references public.players (phone) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.races (
  id uuid primary key default gen_random_uuid(),
  race_number int not null,
  phase text not null default 'betting',
  countdown_start_ms bigint,
  created_at timestamptz not null default now()
);

create table if not exists public.bets (
  id uuid primary key default gen_random_uuid(),
  race_id uuid not null references public.races (id) on delete cascade,
  phone text not null,
  kind text not null,
  a int not null,
  b int not null default -1,
  amount numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists bets_race_id_idx on public.bets (race_id);

insert into public.players (phone, pass_hash, role, balance)
values
  ('admin', encode(digest('karera::admin', 'sha256'), 'hex'), 'admin', 0),
  ('09123456789', encode(digest('karera::1234', 'sha256'), 'hex'), 'player', 1000)
on conflict (phone) do update set pass_hash = excluded.pass_hash, role = excluded.role;

alter table public.players enable row level security;
alter table public.house enable row level security;
alter table public.sessions enable row level security;
alter table public.races enable row level security;
alter table public.bets enable row level security;

revoke all on public.players, public.house, public.sessions from anon, authenticated, public;

create or replace function public.player_json(p public.players)
returns json
language sql
immutable
as $$
  select json_build_object(
    'phone', p.phone,
    'role', p.role,
    'balance', p.balance,
    'createdAt', (extract(epoch from p.created_at) * 1000)::bigint
  );
$$;

create or replace function public.session_phone(p_token text)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select phone from public.sessions where token = p_token;
$$;

create or replace function public.login(p_phone text, p_pass_hash text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  u public.players;
  tok text;
begin
  select * into u
  from public.players
  where phone = btrim(p_phone) and pass_hash = p_pass_hash;
  if not found then
    return null;
  end if;
  tok := encode(gen_random_bytes(24), 'hex');
  insert into public.sessions (token, phone) values (tok, u.phone);
  return (public.player_json(u)::jsonb || jsonb_build_object('token', tok))::json;
end;
$$;

create or replace function public.session_bundle(p_token text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  u public.players;
  users_json json;
begin
  select p.* into u
  from public.sessions s
  join public.players p on p.phone = s.phone
  where s.token = p_token;
  if not found then
    return json_build_object('house', 0, 'me', null, 'users', null);
  end if;
  if u.role = 'admin' then
    select coalesce(json_agg(public.player_json(p) order by p.created_at), '[]'::json)
    into users_json
    from public.players p;
  else
    users_json := json_build_array(public.player_json(u));
  end if;
  return json_build_object(
    'house', (select balance from public.house where id = 1),
    'me', public.player_json(u),
    'users', users_json
  );
end;
$$;

create or replace function public.create_player(
  p_token text,
  p_phone text,
  p_pass_hash text,
  p_balance numeric,
  p_role text default 'player'
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  admin_phone text;
  u public.players;
begin
  select p.phone into admin_phone
  from public.sessions s
  join public.players p on p.phone = s.phone
  where s.token = p_token and p.role = 'admin';
  if admin_phone is null then
    raise exception 'Admin only';
  end if;
  if p_role is distinct from 'player' and p_role is distinct from 'admin' then
    raise exception 'Invalid role';
  end if;
  if p_role = 'player' and btrim(p_phone) !~ '^09[0-9]{9}$' then
    raise exception 'Phone must be 09XXXXXXXXX (11 digits).';
  end if;
  if coalesce(btrim(p_phone), '') = '' then
    raise exception 'Username required.';
  end if;
  if p_balance < 0 then
    raise exception 'Balance must be 0 or more.';
  end if;
  insert into public.players (phone, pass_hash, role, balance)
  values (btrim(p_phone), p_pass_hash, p_role, round(p_balance, 2))
  returning * into u;
  return public.player_json(u);
exception
  when unique_violation then
    raise exception 'Account already exists.';
end;
$$;

create or replace function public.adjust_balance(p_token text, p_phone text, p_delta numeric)
returns numeric
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_balance numeric;
begin
  if not exists (
    select 1
    from public.sessions s
    join public.players p on p.phone = s.phone
    where s.token = p_token and p.role = 'admin'
  ) then
    raise exception 'Admin only';
  end if;
  update public.players
  set balance = greatest(0, round(balance + p_delta, 2))
  where phone = btrim(p_phone)
  returning balance into new_balance;
  if new_balance is null then
    raise exception 'Account not found.';
  end if;
  return new_balance;
end;
$$;

create or replace function public.persist_balance(p_token text, p_balance numeric)
returns numeric
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_balance numeric;
begin
  update public.players
  set balance = greatest(0, round(p_balance, 2))
  where phone = public.session_phone(p_token)
  returning balance into new_balance;
  if new_balance is null then
    raise exception 'Not signed in';
  end if;
  return new_balance;
end;
$$;

create or replace function public.credit_house(p_token text, p_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_balance numeric;
begin
  if public.session_phone(p_token) is null then
    raise exception 'Not signed in';
  end if;
  if p_amount <= 0 then
    return (select balance from public.house where id = 1);
  end if;
  update public.house
  set balance = round(balance + p_amount, 2)
  where id = 1
  returning balance into new_balance;
  return new_balance;
end;
$$;

revoke all on function public.player_json(public.players) from public, anon, authenticated;
revoke all on function public.session_phone(text) from public, anon, authenticated;
revoke all on function public.login(text, text) from public;
revoke all on function public.session_bundle(text) from public;
revoke all on function public.create_player(text, text, text, numeric, text) from public;
revoke all on function public.adjust_balance(text, text, numeric) from public;
revoke all on function public.persist_balance(text, numeric) from public;
revoke all on function public.credit_house(text, numeric) from public;

grant execute on function public.login(text, text) to anon, authenticated;
grant execute on function public.session_bundle(text) to anon, authenticated;
grant execute on function public.create_player(text, text, text, numeric, text) to anon, authenticated;
grant execute on function public.adjust_balance(text, text, numeric) to anon, authenticated;
grant execute on function public.persist_balance(text, numeric) to anon, authenticated;
grant execute on function public.credit_house(text, numeric) to anon, authenticated;
