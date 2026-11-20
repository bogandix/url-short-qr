-- Partition helpers and the daily rollup. SECURITY DEFINER with a pinned search_path;
-- EXECUTE is granted explicitly in 0003 (revoked from PUBLIC here).

create or replace function shortener.ensure_partitions(months_ahead int default 2)
returns void
language plpgsql
security definer
set search_path = shortener, pg_temp
as $$
declare
  start_month date := date_trunc('month', now())::date;
  i int;
  from_ts timestamptz;
  to_ts timestamptz;
  part_name text;
begin
  for i in 0..months_ahead loop
    from_ts := (start_month + make_interval(months => i))::timestamptz;
    to_ts := (start_month + make_interval(months => i + 1))::timestamptz;
    part_name := 'clicks_' || to_char(from_ts at time zone 'UTC', 'YYYY_MM');
    if to_regclass('shortener.' || part_name) is null then
      begin
        execute format(
          'create table shortener.%I partition of shortener.clicks for values from (%L) to (%L)',
          part_name, from_ts, to_ts);
      exception when others then
        -- e.g. rows for that month already sit in clicks_default; leave them, report, continue
        raise warning 'ensure_partitions: % not created: %', part_name, sqlerrm;
      end;
    end if;
  end loop;
end;
$$;

create or replace function shortener.drop_partitions_older_than(months int default 13)
returns int
language plpgsql
security definer
set search_path = shortener, pg_temp
as $$
declare
  cutoff date := (date_trunc('month', now()) - make_interval(months => months))::date;
  r record;
  dropped int := 0;
begin
  for r in
    select c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_inherits i on i.inhrelid = c.oid
    join pg_class p on p.oid = i.inhparent
    where n.nspname = 'shortener' and p.relname = 'clicks'
      and c.relname ~ '^clicks_[0-9]{4}_[0-9]{2}$'
  loop
    if to_date(substring(r.name from 8), 'YYYY_MM') < cutoff then
      execute format('drop table if exists shortener.%I', r.name);
      dropped := dropped + 1;
    end if;
  end loop;
  -- raw rows that fell into the default partition age out too
  delete from shortener.clicks_default where ts < cutoff;
  return dropped;
end;
$$;

-- One row per (day, namespace, code, outcome). Bots are counted in `clicks` and `bots`;
-- `uniques` and the by_* breakdowns count humans only.
create or replace function shortener.rollup_day(d date)
returns void
language plpgsql
security definer
set search_path = shortener, pg_temp
as $$
begin
  delete from shortener.clicks_daily where day = d;

  insert into shortener.clicks_daily (day, namespace, code, outcome, link_id, clicks, uniques, bots,
                                      by_country, by_city, by_device, by_os)
  with base as (
    select namespace, code, outcome, link_id, visitor_hash, is_bot, country, city, device, os
    from shortener.clicks
    where ts >= d::timestamp at time zone 'UTC' and ts < (d + 1)::timestamp at time zone 'UTC'
  ),
  agg as (
    select namespace, code, outcome,
           (array_agg(link_id) filter (where link_id is not null))[1] as link_id,
           count(*)::int as clicks,
           (count(distinct visitor_hash) filter (where not is_bot))::int as uniques,
           (count(*) filter (where is_bot))::int as bots
    from base group by 1, 2, 3
  ),
  dims as (
    select namespace, code, outcome, country, city, device, os, count(*)::int as n,
           grouping(country) as gc, grouping(city) as gi, grouping(device) as gd, grouping(os) as go
    from base
    where not is_bot
    group by grouping sets ((namespace, code, outcome, country), (namespace, code, outcome, city),
                            (namespace, code, outcome, device), (namespace, code, outcome, os))
  ),
  j as (
    select namespace, code, outcome,
      coalesce(jsonb_object_agg(country, n) filter (where gc = 0 and country is not null), '{}') as by_country,
      coalesce(jsonb_object_agg(city, n)    filter (where gi = 0 and city is not null), '{}')    as by_city,
      coalesce(jsonb_object_agg(device, n)  filter (where gd = 0 and device is not null), '{}')  as by_device,
      coalesce(jsonb_object_agg(os, n)      filter (where go = 0 and os is not null), '{}')      as by_os
    from dims group by 1, 2, 3
  )
  select d, a.namespace, a.code, a.outcome, a.link_id, a.clicks, a.uniques, a.bots,
         coalesce(j.by_country, '{}'), coalesce(j.by_city, '{}'), coalesce(j.by_device, '{}'), coalesce(j.by_os, '{}')
  from agg a left join j using (namespace, code, outcome);
end;
$$;

revoke all on function shortener.ensure_partitions(int) from public;
revoke all on function shortener.drop_partitions_older_than(int) from public;
revoke all on function shortener.rollup_day(date) from public;

select shortener.ensure_partitions(3);
