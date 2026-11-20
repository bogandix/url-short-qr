import { adminSqlClient, pgArray, withSql, type Sql } from '../lib/db.js'
import { authed, newApi, scope, type Ctx } from './app.js'

export const statsApi = newApi()
statsApi.use('*', authed, scope('stats:read'))

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const DIMS = ['country', 'city', 'device', 'os', 'browser', 'referer', 'language', 'source'] as const

/** Raw-row expression for each breakdown (days not rolled up yet). */
const RAW_DIM: Record<(typeof DIMS)[number], string> = {
  country: 'c.country',
  city: 'c.city',
  device: 'c.device',
  os: 'c.os',
  browser: 'c.browser',
  referer: 'coalesce(c.referer_host, shortener.referer_host(c.referer))',
  language: 'c.lang_primary',
  source: 'shortener.traffic_source(c.utm_source, coalesce(c.referer_host, shortener.referer_host(c.referer)))',
}

type Filters = { from: string; to: string; namespace: string | null; owner: string | null; nsAllow: string | null; ownerLike: string | null }

function filters(c: Ctx): Filters | null {
  const auth = c.get('auth')
  const from = c.req.query('from') ?? new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10)
  const to = c.req.query('to') ?? new Date().toISOString().slice(0, 10)
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) return null
  return {
    from,
    to,
    namespace: c.req.query('namespace') ?? null,
    owner: c.req.query('owner') ?? null,
    nsAllow: pgArray(auth.namespaces?.length ? auth.namespaces : null),
    ownerLike: auth.ownerPrefix ? auth.ownerPrefix.replace(/[%_\\]/g, '\\$&') + '%' : null,
  }
}

/** First day not yet in clicks_daily: raw rows from here on are counted live. */
async function liveFrom(sql: Sql, f: Filters): Promise<string> {
  const r = await sql<{ d: string }[]>`
    select greatest(${f.from}::date, coalesce(max(day) + 1, ${f.from}::date))::text as d from shortener.clicks_daily`
  return r[0]!.d
}

// Shared WHERE fragments (link join gives owner filtering).
const where = (sql: Sql, f: Filters, alias: 'd' | 'c') => sql`
  (${f.namespace}::text is null or ${sql(alias)}.namespace = ${f.namespace})
  and (${f.owner}::text is null or l.owner = ${f.owner})
  and (${f.nsAllow}::text[] is null or ${sql(alias)}.namespace = any(${f.nsAllow}::text[]))
  and (${f.ownerLike}::text is null or l.owner like ${f.ownerLike})`

/**
 * Dashboard overview: per-day series, totals, outcomes, top links and breakdowns
 * (country, city, device, os, browser, referrer host). Rolled-up days come from
 * clicks_daily; days not rolled up yet (today) are counted from raw rows.
 */
statsApi.get('/overview', async (c) => {
  const f = filters(c)
  if (!f) return c.json({ error: 'bad_range' }, 400)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('top') ?? 10) || 10))
  const out = await withSql(
    () => adminSqlClient(c.env),
    async (sql) => {
      const live = await liveFrom(sql, f)
      const series = await sql<{ day: string; clicks: number; uniques: number; bots: number; not_found: number; requests: number }[]>`
        with rolled as (
          select d.day, d.outcome, d.clicks, d.uniques, d.bots
          from shortener.clicks_daily d left join shortener.links l on l.namespace = d.namespace and l.code = d.code
          where d.day >= ${f.from}::date and d.day < ${live}::date and ${where(sql, f, 'd')}
        ),
        raw as (
          select c.ts::date as day, c.outcome, 1 as clicks, c.visitor_hash, c.is_bot, c.namespace, c.code
          from shortener.clicks c left join shortener.links l on l.namespace = c.namespace and l.code = c.code
          where c.ts >= ${live}::date and c.ts < ${f.to}::date + 1 and ${where(sql, f, 'c')}
        ),
        unioned as (
          select day, outcome, clicks, uniques, bots from rolled
          union all
          select day, outcome, count(*)::int, (count(distinct visitor_hash || namespace || code) filter (where not is_bot))::int,
                 (count(*) filter (where is_bot))::int
          from raw group by day, outcome
        )
        select day::text,
               coalesce(sum(clicks - bots) filter (where outcome = 'redirect'), 0)::int as clicks,
               coalesce(sum(uniques) filter (where outcome = 'redirect'), 0)::int as uniques,
               coalesce(sum(bots), 0)::int as bots,
               coalesce(sum(clicks) filter (where outcome = 'not_found'), 0)::int as not_found,
               coalesce(sum(clicks), 0)::int as requests
        from unioned group by day order by day`
      const outcomes = await sql`
        select outcome, sum(n)::int as n from (
          select d.outcome, d.clicks as n from shortener.clicks_daily d
            left join shortener.links l on l.namespace = d.namespace and l.code = d.code
            where d.day >= ${f.from}::date and d.day < ${live}::date and ${where(sql, f, 'd')}
          union all
          select c.outcome, 1 from shortener.clicks c
            left join shortener.links l on l.namespace = c.namespace and l.code = c.code
            where c.ts >= ${live}::date and c.ts < ${f.to}::date + 1 and ${where(sql, f, 'c')}
        ) x group by 1 order by 2 desc`
      const top = await sql`
        select x.namespace, x.code, l.title, l.target_url, l.owner, l.external_id, sum(x.n)::int as clicks, sum(x.u)::int as uniques
        from (
          select d.namespace, d.code, d.clicks - d.bots as n, d.uniques as u from shortener.clicks_daily d
            left join shortener.links l on l.namespace = d.namespace and l.code = d.code
            where d.outcome = 'redirect' and d.day >= ${f.from}::date and d.day < ${live}::date and ${where(sql, f, 'd')}
          union all
          select c.namespace, c.code, 1, 0 from shortener.clicks c
            left join shortener.links l on l.namespace = c.namespace and l.code = c.code
            where c.outcome = 'redirect' and not c.is_bot and c.ts >= ${live}::date and c.ts < ${f.to}::date + 1 and ${where(sql, f, 'c')}
        ) x left join shortener.links l on l.namespace = x.namespace and l.code = x.code
        group by 1, 2, 3, 4, 5, 6 order by clicks desc limit ${limit}`
      const breakdowns: Record<string, { key: string; n: number }[]> = {}
      for (const dim of DIMS) {
        const col = `by_${dim}`
        const rawExpr = sql.unsafe(RAW_DIM[dim])
        breakdowns[dim] = await sql<{ key: string; n: number }[]>`
          select key, sum(n)::int as n from (
            select e.key, e.value::int as n from shortener.clicks_daily d
              left join shortener.links l on l.namespace = d.namespace and l.code = d.code
              cross join lateral jsonb_each_text(d.${sql(col)}) e
              where d.outcome = 'redirect' and d.day >= ${f.from}::date and d.day < ${live}::date and ${where(sql, f, 'd')}
            union all
            select ${rawExpr}, 1 from shortener.clicks c
              left join shortener.links l on l.namespace = c.namespace and l.code = c.code
              where c.outcome = 'redirect' and not c.is_bot and ${rawExpr} is not null
                and c.ts >= ${live}::date and c.ts < ${f.to}::date + 1 and ${where(sql, f, 'c')}
          ) x group by 1 order by 2 desc limit 25`
      }
      const totals = series.reduce(
        (t, d) => ({ clicks: t.clicks + d.clicks, uniques: t.uniques + d.uniques, bots: t.bots + d.bots, not_found: t.not_found + d.not_found, requests: t.requests + d.requests }),
        { clicks: 0, uniques: 0, bots: 0, not_found: 0, requests: 0 },
      )
      return { from: f.from, to: f.to, totals, series, outcomes, top, breakdowns }
    },
  )
  return c.json(out)
})

/** Kept for compatibility: per-day totals from rollups only. */
statsApi.get('/summary', async (c) => {
  const f = filters(c)
  if (!f) return c.json({ error: 'bad_range' }, 400)
  const out = await withSql(
    () => adminSqlClient(c.env),
    async (sql) => {
      const days = await sql`
        select d.day::text,
               coalesce(sum(d.clicks) filter (where d.outcome = 'redirect'), 0)::int as redirects,
               sum(d.clicks)::int as requests,
               coalesce(sum(d.uniques) filter (where d.outcome = 'redirect'), 0)::int as uniques,
               sum(d.bots)::int as bots
        from shortener.clicks_daily d
        left join shortener.links l on l.namespace = d.namespace and l.code = d.code
        where d.day >= ${f.from}::date and d.day <= ${f.to}::date and ${where(sql, f, 'd')}
        group by d.day order by d.day`
      return { from: f.from, to: f.to, days }
    },
  )
  return c.json(out)
})

/** Live feed: the most recent requests (all outcomes), newest first, without hashes. */
statsApi.get('/recent', async (c) => {
  const f = filters(c)
  if (!f) return c.json({ error: 'bad_range' }, 400)
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50))
  const humansOnly = c.req.query('humans') === '1'
  const rows = await withSql(
    () => adminSqlClient(c.env),
    (sql) => sql`
      select c.ts, c.host, c.namespace, c.code, c.outcome, c.scheme, c.country, c.city, c.region, c.continent,
             c.device, c.device_vendor, c.device_model, c.os, c.browser, c.browser_major, c.lang_primary,
             coalesce(c.referer_host, shortener.referer_host(c.referer)) as referer_host,
             c.utm_source, c.utm_medium, c.utm_campaign, c.as_org, c.http_protocol, c.is_bot, c.bot_name, l.title
      from shortener.clicks c
      left join shortener.links l on l.namespace = c.namespace and l.code = c.code
      where c.ts >= now() - interval '30 days' and ${where(sql, f, 'c')}
        and (${humansOnly} = false or not c.is_bot)
      order by c.ts desc
      limit ${limit}`,
  )
  return c.json({ items: rows })
})
