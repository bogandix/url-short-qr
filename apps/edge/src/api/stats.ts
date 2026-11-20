import { adminSqlClient, pgArray, withSql } from '../lib/db.js'
import { authed, newApi, scope } from './app.js'

export const statsApi = newApi()
statsApi.use('*', authed, scope('stats:read'))

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

statsApi.get('/summary', async (c) => {
  const auth = c.get('auth')
  const namespace = c.req.query('namespace') ?? null
  const owner = c.req.query('owner') ?? null
  const from = c.req.query('from') ?? new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)
  const to = c.req.query('to') ?? new Date().toISOString().slice(0, 10)
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) return c.json({ error: 'bad_range' }, 400)
  const nsAllow = pgArray(auth.namespaces?.length ? auth.namespaces : null)
  const ownerPrefix = auth.ownerPrefix
  const out = await withSql(
    () => adminSqlClient(c.env),
    async (sql) => {
      const days = await sql`
        select d.day::text,
               sum(d.clicks) filter (where d.outcome = 'redirect')::int as redirects,
               sum(d.clicks)::int as requests,
               sum(d.uniques) filter (where d.outcome = 'redirect')::int as uniques,
               sum(d.bots)::int as bots
        from shortener.clicks_daily d
        left join shortener.links l on l.namespace = d.namespace and l.code = d.code
        where d.day >= ${from}::date and d.day <= ${to}::date
          and (${namespace}::text is null or d.namespace = ${namespace})
          and (${owner}::text is null or l.owner = ${owner})
          and (${nsAllow}::text[] is null or d.namespace = any(${nsAllow}::text[]))
          and (${ownerPrefix}::text is null or l.owner like ${(ownerPrefix ?? '').replace(/[%_\\]/g, '\\$&')} || '%')
        group by d.day order by d.day`
      const outcomes = await sql`
        select d.outcome, sum(d.clicks)::int as n
        from shortener.clicks_daily d
        left join shortener.links l on l.namespace = d.namespace and l.code = d.code
        where d.day >= ${from}::date and d.day <= ${to}::date
          and (${namespace}::text is null or d.namespace = ${namespace})
          and (${owner}::text is null or l.owner = ${owner})
          and (${nsAllow}::text[] is null or d.namespace = any(${nsAllow}::text[]))
          and (${ownerPrefix}::text is null or l.owner like ${(ownerPrefix ?? '').replace(/[%_\\]/g, '\\$&')} || '%')
        group by 1 order by 2 desc`
      return { from, to, days, outcomes }
    },
  )
  return c.json(out)
})
