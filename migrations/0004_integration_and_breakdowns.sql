-- Integration fields for client services (e.g. vrumvrum) and richer rollups.

-- external_id: the caller's own id for the thing the link points at; unique per owner,
-- which makes POST /links idempotent. metadata: free-form JSON the caller wants back.
alter table shortener.links add column if not exists external_id text;
alter table shortener.links add column if not exists metadata jsonb not null default '{}';
create unique index if not exists links_owner_external_idx
  on shortener.links (coalesce(owner, ''), external_id) where external_id is not null;

alter table shortener.clicks_daily add column if not exists by_browser jsonb not null default '{}';
alter table shortener.clicks_daily add column if not exists by_referer jsonb not null default '{}';

-- Referrer host only ('' = direct / none), so the rollup never stores full URLs.
create or replace function shortener.referer_host(r text)
returns text language sql immutable as $$
  select case when r is null or r = '' then 'direct'
              else coalesce(lower(substring(r from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/:?#]+)')), 'other') end
$$;

create or replace function shortener.rollup_day(d date)
returns void
language plpgsql
security definer
set search_path = shortener, pg_temp
as $$
begin
  delete from shortener.clicks_daily where day = d;

  insert into shortener.clicks_daily (day, namespace, code, outcome, link_id, clicks, uniques, bots,
                                      by_country, by_city, by_device, by_os, by_browser, by_referer)
  with base as (
    select namespace, code, outcome, link_id, visitor_hash, is_bot, country, city, device, os, browser,
           shortener.referer_host(referer) as ref
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
    select namespace, code, outcome, country, city, device, os, browser, ref, count(*)::int as n,
           grouping(country) as gc, grouping(city) as gi, grouping(device) as gd, grouping(os) as go,
           grouping(browser) as gb, grouping(ref) as gr
    from base
    where not is_bot
    group by grouping sets ((namespace, code, outcome, country), (namespace, code, outcome, city),
                            (namespace, code, outcome, device), (namespace, code, outcome, os),
                            (namespace, code, outcome, browser), (namespace, code, outcome, ref))
  ),
  j as (
    select namespace, code, outcome,
      coalesce(jsonb_object_agg(country, n) filter (where gc = 0 and country is not null), '{}') as by_country,
      coalesce(jsonb_object_agg(city, n)    filter (where gi = 0 and city is not null), '{}')    as by_city,
      coalesce(jsonb_object_agg(device, n)  filter (where gd = 0 and device is not null), '{}')  as by_device,
      coalesce(jsonb_object_agg(os, n)      filter (where go = 0 and os is not null), '{}')      as by_os,
      coalesce(jsonb_object_agg(browser, n) filter (where gb = 0 and browser is not null), '{}') as by_browser,
      coalesce(jsonb_object_agg(ref, n)     filter (where gr = 0 and ref is not null), '{}')     as by_referer
    from dims group by 1, 2, 3
  )
  select d, a.namespace, a.code, a.outcome, a.link_id, a.clicks, a.uniques, a.bots,
         coalesce(j.by_country, '{}'), coalesce(j.by_city, '{}'), coalesce(j.by_device, '{}'), coalesce(j.by_os, '{}'),
         coalesce(j.by_browser, '{}'), coalesce(j.by_referer, '{}')
  from agg a left join j using (namespace, code, outcome);
end;
$$;

revoke all on function shortener.rollup_day(date) from public;
grant execute on function shortener.rollup_day(date) to shortener_edge, shortener_admin;
grant execute on function shortener.referer_host(text) to shortener_admin;
