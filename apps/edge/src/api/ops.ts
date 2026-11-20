import { adminSqlClient, withSql } from '../lib/db.js'
import { countPending } from '../lib/health.js'
import { reconcileDay, replayPending, syncKv } from '../lib/cron.js'
import { authed, newApi, scope } from './app.js'

/** Operator endpoints used by the CLI (replay, doctor) and the Health screen. */
export const opsApi = newApi()
opsApi.use('*', authed, scope('domains:admin'))

opsApi.post('/replay', async (c) => {
  const runs = []
  for (let i = 0; i < 20; i++) {
    const r = await replayPending(c.env)
    runs.push(r)
    if (r.read === 0) break
  }
  return c.json({ runs, pending: await countPending(c.env) })
})

opsApi.post('/sync', async (c) => c.json(await syncKv(c.env)))

opsApi.post('/reconcile/:day', async (c) => {
  const day = c.req.param('day')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.json({ error: 'bad_day' }, 400)
  return c.json(await reconcileDay(c.env, day))
})

opsApi.get('/health', async (c) => {
  const out = await withSql(
    () => adminSqlClient(c.env),
    async (sql) => {
      const reconcile = await sql`select day::text, db_count::int, edge_count::int, diff::int, status, checked_at
                                  from shortener.reconcile_runs order by day desc limit 30`
      const size = await sql<{ bytes: string }[]>`
        select coalesce(sum(pg_total_relation_size(c.oid)), 0)::text as bytes
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'shortener' and c.relkind in ('r', 'p')`
      const db = await sql<{ bytes: string }[]>`select pg_database_size(current_database())::text as bytes`
      return { reconcile, schema_bytes: Number(size[0]!.bytes), database_bytes: Number(db[0]!.bytes) }
    },
  )
  return c.json({ ...out, r2_pending: await countPending(c.env), mode: c.env.MODE })
})

/** Rows for any (namespace, code), including codes with no link (used by smoke for /NOPE99). */
opsApi.get('/clicks', async (c) => {
  const namespace = c.req.query('namespace')
  const code = c.req.query('code')
  const since = c.req.query('since') ?? new Date(Date.now() - 3600_000).toISOString()
  if (!namespace || code == null || Number.isNaN(Date.parse(since))) return c.json({ error: 'bad_query' }, 400)
  const rows = await withSql(
    () => adminSqlClient(c.env),
    (sql) => sql`
      select id, ts, host, outcome, scheme, is_bot, ray_id, source from shortener.clicks
      where namespace = ${namespace} and code = ${code} and ts >= ${since}::timestamptz
      order by ts desc limit 100`,
  )
  return c.json({ items: rows })
})
