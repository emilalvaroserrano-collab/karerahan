-- Race pool readouts + durable payout records.
--
-- race_feed keeps one row per bet (who, which horse, how much). race_pool()
-- rolls those rows up so the live pool can be read in one call, and
-- race_payouts records what each player's race settled at, so a payout can
-- always be traced back to the stake and the pool it was paid from.
--
-- Additive and idempotent: safe to re-run against a live database.

create or replace function public.race_pool(p_race int)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'race', p_race,
    'total', coalesce(
      (select round(sum(amount), 2) from public.race_feed where race_number = p_race), 0),
    'players', (
      select count(distinct phone) from public.race_feed where race_number = p_race),
    'bets', (
      select count(*) from public.race_feed where race_number = p_race),
    'horses', coalesce((
      select json_agg(json_build_object(
        'horse', horse,
        'players', players,
        'bets', bets,
        'total', total
      ) order by horse)
      from (
        select horse,
               count(distinct phone) as players,
               count(*) as bets,
               round(sum(amount), 2) as total
        from public.race_feed
        where race_number = p_race
        group by horse
      ) h
    ), '[]'::json)
  );
$$;

create table if not exists public.race_payouts (
  id uuid primary key default gen_random_uuid(),
  race_number int not null,
  phone text not null,
  horse int not null,
  -- the player's whole win stake on the race, and the slice of it on the
  -- winner (the stake the dividend multiplies)
  stake numeric not null,
  stake_on_horse numeric not null,
  dividend numeric not null,
  payout numeric not null,
  -- the pool the payout was derived from
  pool_total numeric not null,
  horse_total numeric not null,
  created_at timestamptz not null default now(),
  unique (race_number, phone)
);

alter table public.race_payouts enable row level security;

drop policy if exists race_payouts_read on public.race_payouts;
create policy race_payouts_read on public.race_payouts
  for select to anon, authenticated
  using (true);

grant select on public.race_payouts to anon, authenticated;

create or replace function public.log_race_payout(
  p_token text,
  p_race int,
  p_horse int,
  p_stake numeric,
  p_stake_on_horse numeric,
  p_dividend numeric,
  p_payout numeric,
  p_pool_total numeric
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  who text;
  on_horse numeric;
  row public.race_payouts;
begin
  who := public.session_phone(p_token);
  if who is null then
    raise exception 'Not signed in';
  end if;
  if p_horse < 0 or p_horse > 7 then
    raise exception 'Bad horse';
  end if;
  -- The horse total is measured here, not taken from the client, so the
  -- saved payout can be re-derived from the database alone.
  select coalesce(round(sum(amount), 2), 0) into on_horse
  from public.race_feed
  where race_number = p_race and horse = p_horse;
  insert into public.race_payouts (
    race_number, phone, horse, stake, stake_on_horse,
    dividend, payout, pool_total, horse_total
  ) values (
    p_race, who, p_horse,
    round(coalesce(p_stake, 0), 2),
    round(coalesce(p_stake_on_horse, 0), 2),
    round(coalesce(p_dividend, 0), 2),
    round(coalesce(p_payout, 0), 2),
    round(coalesce(p_pool_total, 0), 2),
    on_horse
  )
  on conflict (race_number, phone) do update set
    horse = excluded.horse,
    stake = excluded.stake,
    stake_on_horse = excluded.stake_on_horse,
    dividend = excluded.dividend,
    payout = excluded.payout,
    pool_total = excluded.pool_total,
    horse_total = excluded.horse_total
  returning * into row;
  return json_build_object(
    'race', row.race_number,
    'phone', row.phone,
    'horse', row.horse,
    'stake', row.stake,
    'stake_on_horse', row.stake_on_horse,
    'dividend', row.dividend,
    'payout', row.payout,
    'pool_total', row.pool_total,
    'horse_total', row.horse_total
  );
end;
$$;

revoke all on function public.race_pool(int) from public;
revoke all on function public.log_race_payout(text, int, int, numeric, numeric, numeric, numeric, numeric) from public;
grant execute on function public.race_pool(int) to anon, authenticated;
grant execute on function public.log_race_payout(text, int, int, numeric, numeric, numeric, numeric, numeric) to anon, authenticated;
