import { buildBulkInsert, kvKey, type ClickEvent } from '@shortener/shared'
import type { Env } from '../env.js'
import { adminSqlClient, sqlClient, withSql } from './db.js'
import { publishDomains } from './domains.js'
import { linkToKv } from './lookup.js'

export const CRON_REPLAY = '*/5 * * * *'
export const CRON_DAILY = '15 0 * * *'
export const CRON_SYNC = '0 */6 * * *'

const INSERT_CHUNK = 100

// ───────────────────────── R2 replay ─────────────────────────

export type ReplayResult = { read: number; inserted: number; deleted: number; bad: number }

/** Move up to `max` pending events from R2 into Postgres (source = 'replay'), then delete them. */
export async function replayPending(env: Env, max = 1000): Promise<ReplayResult> {
  const result: ReplayResult = { read: 0, inserted: 0, deleted: 0, bad: 0 }
  const listing = await env.FALLBACK.list({ prefix: 'pending/', limit: Math.min(max, 1000) })
  if (listing.objects.length === 0) return result

  const events: { key: string; ev: ClickEvent }[] = []
  const badKeys: string[] = []
  for (let i = 0; i < listing.objects.length; i += 50) {
    const slice = listing.objects.slice(i, i + 50)
    const got = await Promise.all(
      slice.map(async (o) => {
        const obj = await env.FALLBACK.get(o.key)
        if (!obj) return null
        try {
          return { key: o.key, ev: { ...(JSON.parse(await obj.text()) as ClickEvent), source: 'replay' as const } }
        } catch {
          badKeys.push(o.key)
          return null
        }
      }),
    )
    for (const g of got) if (g) events.push(g)
  }
  result.read = events.length
  result.bad = badKeys.length

  // Insert in chunks; delete each chunk's objects only after its insert succeeded.
  await withSql(
    () => sqlClient(env),
    async (sql) => {
      for (let i = 0; i < events.length; i += INSERT_CHUNK) {
        const chunk = events.slice(i, i + INSERT_CHUNK)
        const { sql: text, params } = buildBulkInsert(chunk.map((c) => c.ev))
        const r = await sql.unsafe(text, params as never[])
        result.inserted += r.count
        await env.FALLBACK.delete(chunk.map((c) => c.key))
        result.deleted += chunk.length
      }
    },
  )
  // Unparseable objects are moved aside, never silently dropped.
  for (const key of badKeys) {
    const obj = await env.FALLBACK.get(key)
    if (obj) await env.FALLBACK.put(key.replace(/^pending\//, 'bad/'), await obj.arrayBuffer())
    await env.FALLBACK.delete(key)
  }
  return result
}

// ───────────────────────── daily: rollup, reconcile, partitions ─────────────────────────

export function previousUtcDay(at: number): string {
  return new Date(at - 86_400_000).toISOString().slice(0, 10)
}

export async function dailyJob(env: Env, scheduledTime: number): Promise<void> {
  const day = previousUtcDay(scheduledTime)
  // Drain the fallback first so late events for `day` are counted.
  for (let i = 0; i < 10; i++) {
    const r = await replayPending(env).catch(() => null)
    if (!r || r.read === 0) break
  }
  const retention = Number.parseInt(env.RETENTION_MONTHS ?? '13', 10) || 13
  await withSql(
    () => adminSqlClient(env),
    async (sql) => {
      await sql`select shortener.ensure_partitions(2)`
      await sql`select shortener.rollup_day(${day}::date)`
      await sql`select shortener.drop_partitions_older_than(${retention}::int)`
    },
  )
  await reconcileDay(env, day)
}

type GroupKey = string // namespace \u0000 code \u0000 outcome
const gk = (ns: string, code: string, outcome: string): GroupKey => `${ns}\u0000${code}\u0000${outcome}`

export type ReconcileResult = {
  day: string
  db_count: number
  edge_count: number
  diff: number
  status: 'ok' | 'mismatch' | 'error'
  mismatches: { namespace: string; code: string; outcome: string; db: number; edge: number }[]
}

export async function reconcileDay(env: Env, day: string): Promise<ReconcileResult> {
  const result: ReconcileResult = { day, db_count: 0, edge_count: 0, diff: 0, status: 'ok', mismatches: [] }

  const dbCounts = new Map<GroupKey, number>()
  await withSql(
    () => adminSqlClient(env),
    async (sql) => {
      const rows = await sql<{ namespace: string; code: string; outcome: string; n: string }[]>`
        select namespace, code, outcome, count(*)::text as n
        from shortener.clicks
        where ts >= ${day}::date and ts < ${day}::date + 1
        group by 1, 2, 3`
      for (const r of rows) dbCounts.set(gk(r.namespace, r.code, r.outcome), Number(r.n))
    },
  )

  let edgeCounts: Map<GroupKey, number> | null = null
  try {
    edgeCounts = await analyticsCounts(env, day)
  } catch (err) {
    console.error('reconcile-ae-failed', String(err))
  }

  for (const n of dbCounts.values()) result.db_count += n
  if (!edgeCounts) {
    result.status = 'error'
    result.diff = -1
  } else {
    for (const n of edgeCounts.values()) result.edge_count += n
    const keys = new Set([...dbCounts.keys(), ...edgeCounts.keys()])
    for (const k of keys) {
      const a = dbCounts.get(k) ?? 0
      const b = edgeCounts.get(k) ?? 0
      if (a !== b) {
        const [namespace, code, outcome] = k.split('\u0000') as [string, string, string]
        result.mismatches.push({ namespace, code, outcome, db: a, edge: b })
        result.diff += Math.abs(a - b)
      }
    }
    result.status = result.diff === 0 ? 'ok' : 'mismatch'
  }

  await withSql(
    () => adminSqlClient(env),
    (sql) => sql`
      insert into shortener.reconcile_runs (day, db_count, edge_count, diff, status, checked_at)
      values (${day}::date, ${result.db_count}, ${result.edge_count}, ${result.diff}, ${result.status}, now())
      on conflict (day) do update set db_count = excluded.db_count, edge_count = excluded.edge_count,
        diff = excluded.diff, status = excluded.status, checked_at = now()`,
  )

  if (result.status !== 'ok') await alert(env, result)
  return result
}

export async function analyticsCounts(env: Env, day: string): Promise<Map<GroupKey, number>> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) throw new Error('CF_ACCOUNT_ID / CF_ANALYTICS_TOKEN not set')
  const dataset = env.AE_DATASET ?? 'shortener_clicks'
  if (!/^[a-z0-9_]+$/i.test(dataset) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('bad input')
  const query = `
    SELECT blob1 AS namespace, blob2 AS code, blob3 AS outcome, SUM(_sample_interval) AS n
    FROM ${dataset}
    WHERE timestamp >= toDateTime('${day} 00:00:00') - INTERVAL '2' HOUR
      AND timestamp <  toDateTime('${day} 00:00:00') + INTERVAL '26' HOUR
      AND blob5 = '${day}'
    GROUP BY namespace, code, outcome
    FORMAT JSON`
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
    body: query,
  })
  if (!res.ok) throw new Error(`ae sql ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const body = (await res.json()) as { data: { namespace: string; code: string; outcome: string; n: number | string }[] }
  const out = new Map<GroupKey, number>()
  for (const r of body.data) out.set(gk(r.namespace, r.code, r.outcome), Math.round(Number(r.n)))
  return out
}

async function alert(env: Env, r: ReconcileResult): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL) return
  const text =
    r.status === 'error'
      ? `shortener reconcile ${r.day}: could not read Analytics Engine (db=${r.db_count})`
      : `shortener reconcile ${r.day}: diff=${r.diff} (db=${r.db_count}, edge=${r.edge_count}, groups=${r.mismatches.length})`
  await fetch(env.ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, content: text, ...r, mismatches: r.mismatches.slice(0, 50) }),
  }).catch((err) => console.error('alert-failed', String(err)))
}

// ───────────────────────── KV resync ─────────────────────────

export async function syncKv(env: Env): Promise<{ links: number; domains: number }> {
  return withSql(
    () => adminSqlClient(env),
    async (sql) => {
      const meta = await sql<{ value: string }[]>`select value from shortener.meta where key = 'last_sync'`
      const since = meta[0]?.value ?? '1970-01-01T00:00:00Z'
      // 10-minute overlap catches transactions that committed after the previous run read.
      const rows = await sql<
        {
          namespace: string
          code: string
          id: string
          target_url: string
          status: string
          expires_at: Date | null
          fallback_url: string | null
          utm: Record<string, string>
          append_utm: boolean
          version: number
          updated_at: Date
        }[]
      >`
        select namespace, code, id, target_url, status, expires_at, fallback_url, utm, append_utm, version, updated_at
        from shortener.links
        where updated_at > ${since}::timestamptz - interval '10 minutes'
        order by updated_at`
      for (let i = 0; i < rows.length; i += 50) {
        await Promise.all(
          rows.slice(i, i + 50).map((r) => env.LINKS.put(kvKey(r.namespace, r.code), JSON.stringify(linkToKv(r)))),
        )
      }
      const newest = rows.length ? rows[rows.length - 1]!.updated_at.toISOString() : since
      await sql`
        insert into shortener.meta (key, value, updated_at) values ('last_sync', ${newest}, now())
        on conflict (key) do update set value = excluded.value, updated_at = now()`
      const domains = await publishDomains(env, sql)
      return { links: rows.length, domains: domains.length }
    },
  )
}

export async function runScheduled(cron: string, env: Env, scheduledTime: number): Promise<void> {
  switch (cron) {
    case CRON_REPLAY:
      console.log('replay', JSON.stringify(await replayPending(env)))
      return
    case CRON_DAILY:
      await dailyJob(env, scheduledTime)
      return
    case CRON_SYNC:
      console.log('sync', JSON.stringify(await syncKv(env)))
      return
    default:
      console.warn('unknown cron', cron)
  }
}
