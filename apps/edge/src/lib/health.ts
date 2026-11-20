import type { Env } from '../env.js'
import { adminSqlClient, withSql } from './db.js'
import { fallbackStore } from './fallback.js'

export async function health(env: Env): Promise<Response> {
  const out: Record<string, unknown> = { mode: env.MODE }
  const checks = await Promise.allSettled([
    env.LINKS.get('__health'),
    withSql(
      () => adminSqlClient(env),
      async (sql) => {
        await sql`select 1`
        const r = await sql<{ day: string; diff: string; status: string; checked_at: Date }[]>`
          select day::text, diff::text, status, checked_at from shortener.reconcile_runs order by day desc limit 1`
        return r[0] ?? null
      },
    ),
    countPending(env),
  ])
  out.kv = checks[0].status === 'fulfilled' ? 'ok' : 'error'
  out.db = checks[1].status === 'fulfilled' ? 'ok' : 'error'
  out.last_reconcile = checks[1].status === 'fulfilled' ? checks[1].value : null
  out.r2_pending = checks[2].status === 'fulfilled' ? checks[2].value : null
  out.salt = env.SECRET_SALT ? 'set' : 'missing'
  const ok = out.kv === 'ok' && out.db === 'ok'
  return Response.json(out, { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
}

/** Pending fallback objects, capped at 10,000 to keep the call cheap. */
export async function countPending(env: Env, cap = 10_000): Promise<number> {
  const store = fallbackStore(env)
  let n = 0
  let cursor: string | undefined
  do {
    const page = await store.list('pending/', 1000, cursor)
    n += page.keys.length
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor && n < cap)
  return n
}
