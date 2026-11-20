-- Richer click data: location detail, network, device, client hints, source/UTM.
-- Coordinates are Cloudflare's city-level estimate, rounded to 2 decimals (~1 km).
alter table shortener.clicks
  add column if not exists continent text,
  add column if not exists postal_code text,
  add column if not exists metro_code text,
  add column if not exists latitude numeric(5, 2),
  add column if not exists longitude numeric(5, 2),
  add column if not exists is_eu boolean,
  add column if not exists http_protocol text,
  add column if not exists tls_version text,
  add column if not exists client_rtt_ms int,
  add column if not exists device_vendor text,
  add column if not exists device_model text,
  add column if not exists browser_major text,
  add column if not exists engine text,
  add column if not exists cpu_arch text,
  add column if not exists ch_platform text,
  add column if not exists ch_mobile boolean,
  add column if not exists ch_model text,
  add column if not exists lang_primary text,
  add column if not exists dnt boolean,
  add column if not exists referer_host text,
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists utm_term text,
  add column if not exists utm_content text;

-- Backfill what can be derived from rows logged before this migration.
update shortener.clicks set
  referer_host = coalesce(referer_host, nullif(lower(substring(referer from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/:?#]+)')), '')),
  lang_primary = coalesce(lang_primary, nullif(lower(split_part(split_part(split_part(lang, ',', 1), ';', 1), '-', 1)), ''))
where referer is not null or lang is not null;

-- Rollups gain language and traffic source (utm_source, else referrer host, else "direct").
alter table shortener.clicks_daily add column if not exists by_language jsonb not null default '{}';
alter table shortener.clicks_daily add column if not exists by_source jsonb not null default '{}';

create or replace function shortener.traffic_source(utm text, ref_host text)
returns text language sql immutable as $$
  select coalesce(nullif(lower(utm), ''), nullif(ref_host, ''), 'direct')
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
                                      by_country, by_city, by_device, by_os, by_browser, by_referer, by_language, by_source)
  with base as (
    select namespace, code, outcome, link_id, visitor_hash, is_bot, country, city, device, os, browser,
           coalesce(referer_host, shortener.referer_host(referer)) as ref,
           lang_primary as language,
           shortener.traffic_source(utm_source, coalesce(referer_host, shortener.referer_host(referer))) as src
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
    select namespace, code, outcome, country, city, device, os, browser, ref, language, src, count(*)::int as n,
           grouping(country) as gc, grouping(city) as gi, grouping(device) as gd, grouping(os) as go,
           grouping(browser) as gb, grouping(ref) as gr, grouping(language) as gl, grouping(src) as gs
    from base
    where not is_bot
    group by grouping sets ((namespace, code, outcome, country), (namespace, code, outcome, city),
                            (namespace, code, outcome, device), (namespace, code, outcome, os),
                            (namespace, code, outcome, browser), (namespace, code, outcome, ref),
                            (namespace, code, outcome, language), (namespace, code, outcome, src))
  ),
  j as (
    select namespace, code, outcome,
      coalesce(jsonb_object_agg(country, n) filter (where gc = 0 and country is not null), '{}') as by_country,
      coalesce(jsonb_object_agg(city, n)    filter (where gi = 0 and city is not null), '{}')    as by_city,
      coalesce(jsonb_object_agg(device, n)  filter (where gd = 0 and device is not null), '{}')  as by_device,
      coalesce(jsonb_object_agg(os, n)      filter (where go = 0 and os is not null), '{}')      as by_os,
      coalesce(jsonb_object_agg(browser, n) filter (where gb = 0 and browser is not null), '{}') as by_browser,
      coalesce(jsonb_object_agg(ref, n)     filter (where gr = 0 and ref is not null), '{}')     as by_referer,
      coalesce(jsonb_object_agg(language, n) filter (where gl = 0 and language is not null), '{}') as by_language,
      coalesce(jsonb_object_agg(src, n)     filter (where gs = 0 and src is not null), '{}')     as by_source
    from dims group by 1, 2, 3
  )
  select d, a.namespace, a.code, a.outcome, a.link_id, a.clicks, a.uniques, a.bots,
         coalesce(j.by_country, '{}'), coalesce(j.by_city, '{}'), coalesce(j.by_device, '{}'), coalesce(j.by_os, '{}'),
         coalesce(j.by_browser, '{}'), coalesce(j.by_referer, '{}'), coalesce(j.by_language, '{}'), coalesce(j.by_source, '{}')
  from agg a left join j using (namespace, code, outcome);
end;
$$;

revoke all on function shortener.rollup_day(date) from public;
grant execute on function shortener.rollup_day(date) to shortener_edge, shortener_admin;
grant execute on function shortener.traffic_source(text, text) to shortener_admin;

-- Fast "recent clicks" and per-owner dashboards.
create index if not exists clicks_ts_idx on shortener.clicks (ts desc);
