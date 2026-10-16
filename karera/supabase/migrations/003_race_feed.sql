-- Live bets for the shared race. Anyone in the app can read the feed.
-- Inserts go through post_race_bet so the phone comes from the session.

create table if not exists public.race_feed (
  id uuid primary key default gen_random_uuid(),
  race_number int not null,
  phone text not null,
  horse int not null,
  horse_name text not null,
  amount numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists race_feed_race_idx on public.race_feed (race_number, created_at);

alter table public.race_feed enable row level security;

drop policy if exists race_feed_read on public.race_feed;
create policy race_feed_read on public.race_feed
  for select to anon, authenticated
  using (true);

grant select on public.race_feed to anon, authenticated;

create or replace function public.race_bets(p_race int)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(json_agg(json_build_object(
    'id', id,
    'phone', phone,
    'horse', horse,
    'horse_name', horse_name,
    'amount', amount
  ) order by created_at), '[]'::json)
  from public.race_feed
  where race_number = p_race;
$$;

create or replace function public.post_race_bet(
  p_token text,
  p_race int,
  p_horse int,
  p_name text,
  p_amount numeric
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  who text;
  row public.race_feed;
begin
  who := public.session_phone(p_token);
  if who is null then
    raise exception 'Not signed in';
  end if;
  if p_horse < 0 or p_horse > 7 or p_amount is null or p_amount <= 0 then
    raise exception 'Bad bet';
  end if;
  insert into public.race_feed (race_number, phone, horse, horse_name, amount)
  values (p_race, who, p_horse, left(coalesce(p_name, ''), 40), round(p_amount, 2))
  returning * into row;
  return json_build_object(
    'id', row.id,
    'phone', row.phone,
    'horse', row.horse,
    'horse_name', row.horse_name,
    'amount', row.amount
  );
end;
$$;

create or replace function public.clear_race_bets(p_token text, p_race int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  who text;
begin
  who := public.session_phone(p_token);
  if who is null then
    raise exception 'Not signed in';
  end if;
  delete from public.race_feed
  where race_number = p_race and phone = who;
end;
$$;

revoke all on function public.race_bets(int) from public;
revoke all on function public.post_race_bet(text, int, int, text, numeric) from public;
revoke all on function public.clear_race_bets(text, int) from public;
grant execute on function public.race_bets(int) to anon, authenticated;
grant execute on function public.post_race_bet(text, int, int, text, numeric) to anon, authenticated;
grant execute on function public.clear_race_bets(text, int) to anon, authenticated;

do $$
begin
  alter publication supabase_realtime add table public.race_feed;
exception
  when duplicate_object then null;
end $$;
