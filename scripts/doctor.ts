import postgres from 'postgres'
import { CF } from '../setup/lib/cf.js'
import { loadState } from '../setup/lib/state.js'
import { zoneDrift, type DriftItem } from '../setup/lib/zone.js'
import { Api, adminHost } from './lib/client.js'

/**
 * Exits non-zero on drift. Needs CLOUDFLARE_API_TOKEN. Optional:
 *   SHORTENER_API_KEY     storage, reconcile history, R2 pending via the admin API
 *   SHORTENER_DATABASE_URL / SUPABASE_ACCESS_TOKEN   roles and exposed-schema checks
 */
const s = loadState()
const results: (DriftItem & { scope: string })[] = []
const add = (scope: string, items: DriftItem[]) => results.push(...items.map((i) => ({ ...i, scope })))
const skip = (scope: string, check: string, why: string) => results.push({ scope, check, ok: true, detail: `skipped: ${why}` })

async function cloudflare() {
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) return add('cloudflare', [{ ok: false, check: 'zones, bindings, crons', detail: 'CLOUDFLARE_API_TOKEN not set — cannot check for drift' }])
  const cf = new CF(token, process.env.CLOUDFLARE_ACCOUNT_ID ?? s.accountId)
  if (!cf.accountId) throw new Error('no account id (state or CLOUDFLARE_ACCOUNT_ID)')

  for (const d of Object.values(s.domains)) {
    if (!d.zoneId) {
      add(d.apex, [{ ok: false, check: 'zone created', detail: 'not yet — re-run domain:add' }])
      continue
    }
    add(d.apex, await zoneDrift(cf, d.zoneId, { wildcard: d.wildcard, apex: d.apex }))
  }

  const settings = await cf.get<{ bindings: { name: string; type: string }[] }>(`${cf.acct}/workers/scripts/shortener-edge/settings`)
  const have = new Set(settings.bindings.map((b) => b.name))
  const need = ['LINKS', ...(s.resources?.r2Bucket ? ['FALLBACK'] : []), 'DB', 'DB_ADMIN', 'CLICKS_AE', 'SECRET_SALT', 'CF_ANALYTICS_TOKEN', 'ASSETS', ...(s.mode === 'paid' ? ['CLICKS'] : [])]
  add('worker', need.map((n) => ({ ok: have.has(n), check: `binding ${n}` })))
  const mode = settings.bindings.find((b) => b.name === 'MODE') as { text?: string } | undefined
  add('worker', [{ ok: mode?.text === s.mode, check: `MODE = ${s.mode}`, detail: mode?.text }])

  const sched = await cf.get<{ schedules: { cron: string }[] }>(`${cf.acct}/workers/scripts/shortener-edge/schedules`)
  const crons = new Set(sched.schedules.map((x) => x.cron))
  add('worker', ['*/5 * * * *', '15 0 * * *', '0 */6 * * *'].map((c) => ({ ok: crons.has(c), check: `cron ${c}` })))

  if (s.mode === 'paid') {
    const cs = await cf.get<{ bindings: { name: string }[] }>(`${cf.acct}/workers/scripts/shortener-consumer/settings`).catch(() => null)
    add('consumer', [{ ok: !!cs?.bindings.some((b) => b.name === 'DB'), check: 'shortener-consumer deployed with DB' }])
  }
}

async function health() {
  let host: string
  try {
    host = adminHost(s)
  } catch (err) {
    return skip('health', '/_/health', (err as Error).message)
  }
  const r = await fetch(`https://${host}/_/health`).catch(() => null)
  const h = (await r?.json().catch(() => null)) as {
    kv?: string
    db?: string
    salt?: string
    r2_pending?: number
    last_reconcile?: { day: string; diff: string; status: string } | null
  } | null
  if (!h) return add('health', [{ ok: false, check: `https://${host}/_/health reachable` }])
  add('health', [
    { ok: h.kv === 'ok', check: 'KV reachable' },
    { ok: h.db === 'ok', check: 'database reachable' },
    { ok: h.salt === 'set', check: 'SECRET_SALT set' },
    { ok: (h.r2_pending ?? 0) < 1000, check: 'R2 pending < 1000', detail: String(h.r2_pending) },
  ])
  const last = h.last_reconcile
  if (!last) skip('health', 'last reconcile', 'no run yet (daily 00:15 UTC)')
  else {
    const ageDays = (Date.now() - Date.parse(last.day)) / 864e5
    add('health', [
      { ok: last.status === 'ok' && Number(last.diff) === 0, check: `reconcile ${last.day} diff 0`, detail: `${last.status}, diff ${last.diff}` },
      { ok: ageDays < 3, check: 'reconcile ran in the last 2 days' },
    ])
  }

  const key = process.env.SHORTENER_API_KEY
  if (!key) return skip('storage', 'storage quota', 'SHORTENER_API_KEY not set')
  const ops = await new Api(host, key).call<{ database_bytes: number }>('GET', '/ops/health')
  if (ops.status !== 200) return add('storage', [{ ok: false, check: 'ops/health', detail: `HTTP ${ops.status}` }])
  const quota = Number(process.env.SHORTENER_STORAGE_QUOTA_MB ?? (s.database?.provider === 'supabase' ? 500 : s.database?.provider === 'neon' ? 512 : 0)) * 1048576
  if (!quota) skip('storage', 'storage < 70% of quota', 'set SHORTENER_STORAGE_QUOTA_MB')
  else {
    const pct = (ops.body.database_bytes / quota) * 100
    add('storage', [{ ok: pct < 70, check: 'storage < 70% of quota', detail: `${pct.toFixed(1)}% of ${quota / 1048576} MB` }])
  }
}

async function database() {
  let query: ((q: string) => Promise<Record<string, unknown>[]>) | null = null
  let close = async () => {}
  if (process.env.SHORTENER_DATABASE_URL) {
    const sql = postgres(process.env.SHORTENER_DATABASE_URL, { max: 1, onnotice: () => {} })
    query = async (q) => [...(await sql.unsafe(q))] as Record<string, unknown>[]
    close = () => sql.end({ timeout: 5 })
  } else if (process.env.SUPABASE_ACCESS_TOKEN && s.database?.projectRef) {
    const ref = s.database.projectRef
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, {
        method,
        headers: { authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!r.ok) throw new Error(`supabase ${path}: ${r.status}`)
      return r.json()
    }
    query = async (q) => (await call('POST', '/database/query', { query: q })) as Record<string, unknown>[]
    const pg = (await call('GET', '/postgrest')) as { db_schema: string }
    add('database', [{ ok: !pg.db_schema.split(',').map((x) => x.trim()).includes('shortener'), check: 'schema not exposed via REST', detail: pg.db_schema }])
  }
  if (!query) return skip('database', 'roles, RLS', 'SHORTENER_DATABASE_URL or SUPABASE_ACCESS_TOKEN not set')
  try {
    const roles = await query(`select rolname, rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname in ('shortener_edge','shortener_admin')`)
    for (const r of ['shortener_edge', 'shortener_admin']) {
      const row = roles.find((x) => x.rolname === r)
      add('database', [{ ok: !!row?.rolcanlogin && !row.rolsuper && !row.rolbypassrls, check: `role ${r} can log in, no superuser/bypassrls` }])
    }
    const rls = await query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'shortener' and c.relkind in ('r','p') and not c.relrowsecurity and c.relname not like 'clicks\\_%' and c.relname <> 'schema_migrations'`)
    add('database', [{ ok: rls.length === 0, check: 'RLS on every table', detail: rls.map((x) => x.relname).join(', ') || undefined }])
    const pub = await query(`select count(*)::int as n from information_schema.role_table_grants
      where table_schema = 'shortener' and grantee in ('PUBLIC','anon','authenticated')`)
    add('database', [{ ok: Number(pub[0]?.n ?? 0) === 0, check: 'no grants to public/anon/authenticated' }])
    const parts = await query(`select count(*)::int as n from pg_inherits i join pg_class p on p.oid = i.inhparent
      join pg_class c on c.oid = i.inhrelid where p.relname = 'clicks' and c.relname = 'clicks_' || to_char(now() + interval '1 month', 'YYYY_MM')`)
    add('database', [{ ok: Number(parts[0]?.n ?? 0) === 1, check: "next month's clicks partition exists" }])
  } finally {
    await close()
  }
}

for (const [name, fn] of [['cloudflare', cloudflare], ['health', health], ['database', database]] as const) {
  try {
    await fn()
  } catch (err) {
    results.push({ scope: name, check: 'ran', ok: false, detail: (err as Error).message })
  }
}

let bad = 0
let scope = ''
for (const r of results) {
  if (r.scope !== scope) console.log(`\n${(scope = r.scope)}`)
  if (!r.ok) bad++
  console.log(`  ${r.ok ? (r.detail?.startsWith('skipped') ? '–' : '✓') : '✗'} ${r.check}${r.detail ? `  (${r.detail})` : ''}`)
}
console.log(bad ? `\n${bad} problem(s) found.` : '\nAll checks passed.')
process.exit(bad ? 1 : 0)
