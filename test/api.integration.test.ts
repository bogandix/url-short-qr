/**
 * End-to-end through the real code paths: Hono API + router + crons → postgres.js →
 * PGlite (real Postgres in WASM) over a socket. KV/R2/AE are in-memory fakes.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { api } from '../apps/edge/src/api/index.js'
import { clearAuthCaches, sha256Hex } from '../apps/edge/src/lib/auth.js'
import { reconcileDay, syncKv, dailyJob } from '../apps/edge/src/lib/cron.js'
import { resetDomainMemory } from '../apps/edge/src/lib/domains.js'
import { clearUnknownCache } from '../apps/edge/src/lib/lookup.js'
import { handleRequest } from '../apps/edge/src/router.js'
import { ctx, domain, makeEnv } from '../apps/edge/test/fakes.js'
import type { Env } from '../apps/edge/src/env.js'

const PORT = 54329
let pg: PGlite
let server: PGLiteSocketServer
let env: Env
let kv: ReturnType<typeof makeEnv>['kv']
let ae: ReturnType<typeof makeEnv>['ae']
const KEY = 'sk_live_' + 'a'.repeat(48)
const LIMITED = 'sk_live_' + 'b'.repeat(48)

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, key = KEY) {
  const r = await api.fetch(
    new Request(`https://short.example/_/api${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    ctx,
  )
  return { status: r.status, body: (await r.json()) as T, headers: r.headers }
}

beforeAll(async () => {
  pg = new PGlite()
  for (const f of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join('migrations', f), 'utf8'))
  }
  await pg.exec(`
    insert into shortener.domains (apex, is_admin_host, status, home_url) values ('short.example', true, 'active', 'https://home.example/');
    insert into shortener.domains (apex, wildcard, wildcard_mode, status) values ('tenant.example', true, 'namespace', 'active');
    insert into shortener.api_keys (name, key_hash, scopes) values
      ('all', '${await sha256Hex(KEY)}', array['links:read','links:write','stats:read','domains:admin','keys:admin']),
      ('limited', '${await sha256Hex(LIMITED)}', array['links:read','links:write','stats:read']);
    update shortener.api_keys set namespaces = array['acme.tenant.example'], owner_prefix = 'tenant:' where name = 'limited';
  `)
  server = new PGLiteSocketServer({ db: pg, port: PORT, host: '127.0.0.1' })
  await server.start()
  const conn = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`
  const made = makeEnv(
    [
      domain({ apex: 'short.example', is_admin_host: true }),
      domain({ apex: 'tenant.example', wildcard: true }),
    ],
    {},
    { DB: { connectionString: conn } as Hyperdrive, DB_ADMIN: { connectionString: conn } as Hyperdrive },
  )
  env = made.env
  kv = made.kv
  ae = made.ae
}, 60_000)

afterAll(async () => {
  await server?.stop()
  await pg?.close()
})

describe('links API', () => {
  let code = ''

  it('rejects missing/invalid keys', async () => {
    expect((await call('GET', '/links', undefined, 'sk_live_nope')).status).toBe(401)
  })

  it('creates a random-code link, writes KV and audit', async () => {
    const r = await call<{ code: string; short_url: string; qr: { svg: string; payload: string }; version: number }>('POST', '/links', {
      namespace: 'short.example',
      target_url: 'https://target.example/a',
      tags: ['launch'],
      utm: { utm_medium: 'qr' },
      append_utm: true,
    })
    expect(r.status).toBe(201)
    expect(r.body.code).toMatch(/^[0-9A-HJKMNP-Z]{4}$/)
    code = r.body.code
    expect(r.body.short_url).toBe(`https://short.example/${code}`)
    expect(r.body.qr.payload).toBe(`HTTPS://SHORT.EXAMPLE/${code}`)
    expect(r.headers.get('cache-control')).toContain('no-store')
    const v = JSON.parse(kv.map.get(`short.example/${code}`)!)
    expect(v).toMatchObject({ t: 'https://target.example/a', s: 'active', u: { utm_medium: 'qr' }, a: true, v: 1 })
    const audit = await pg.query(`select action from shortener.audit where code = $1`, [code])
    expect(audit.rows).toEqual([{ action: 'link.create' }])
  })

  it('vanity codes are normalised and unique per namespace', async () => {
    const a = await call<{ code: string }>('POST', '/links', { namespace: 'short.example', target_url: 'https://x.example', code: 'promo-24' })
    expect(a.status).toBe(201)
    expect(a.body.code).toBe('PR0M0-24')
    const dup = await call('POST', '/links', { namespace: 'short.example', target_url: 'https://y.example', code: 'PR0M0-24' })
    expect(dup.status).toBe(409)
    const other = await call('POST', '/links', { namespace: 'acme.tenant.example', target_url: 'https://y.example', code: 'PROMO-24' })
    expect(other.status).toBe(201)
  })

  it('rejects unknown namespaces, bad URLs and reserved codes', async () => {
    expect((await call('POST', '/links', { namespace: 'nope.example', target_url: 'https://x.example' })).status).toBe(400)
    expect((await call('POST', '/links', { namespace: 'short.example', target_url: 'javascript:alert(1)' })).status).toBe(400)
    expect((await call('POST', '/links', { namespace: 'short.example', target_url: 'https://x.example', code: 'robots.txt' })).status).toBe(400)
  })

  it('bulk is all or nothing', async () => {
    const before = (await pg.query<{ n: number }>(`select count(*)::int n from shortener.links`)).rows[0]!.n
    const bad = await call<{ detail: { index: number } }>('POST', '/links/bulk', {
      items: [
        { namespace: 'short.example', target_url: 'https://1.example', code: 'BULK-1' },
        { namespace: 'short.example', target_url: 'https://2.example', code: 'PR0M0-24' }, // taken
      ],
    })
    expect(bad.status).toBe(409)
    expect(bad.body.detail.index).toBe(1)
    expect((await pg.query<{ n: number }>(`select count(*)::int n from shortener.links`)).rows[0]!.n).toBe(before)
    const ok = await call<{ items: unknown[] }>('POST', '/links/bulk', {
      items: [1, 2, 3].map((i) => ({ namespace: 'short.example', target_url: `https://${i}.example`, tags: ['bulk'] })),
    })
    expect(ok.status).toBe(201)
    expect(ok.body.items).toHaveLength(3)
  })

  it('lists with filters and keyset pagination', async () => {
    const p1 = await call<{ items: { code: string }[]; next_cursor: string }>('GET', '/links?tag=bulk&limit=2')
    expect(p1.body.items).toHaveLength(2)
    const p2 = await call<{ items: { code: string }[]; next_cursor: string | null }>('GET', `/links?tag=bulk&limit=2&cursor=${encodeURIComponent(p1.body.next_cursor)}`)
    expect(p2.body.items).toHaveLength(1)
    const all = new Set([...p1.body.items, ...p2.body.items].map((x) => x.code))
    expect(all.size).toBe(3)
    const q = await call<{ items: unknown[] }>('GET', '/links?q=target.example')
    expect(q.body.items).toHaveLength(1)
  })

  it('pause / resume / patch bumps version, writes KV and audit', async () => {
    const r = await call<{ status: string; version: number; title: string | null }>('PATCH', `/links/short.example/${code}`, { status: 'paused', title: 'T' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ status: 'paused', version: 2, title: 'T' })
    expect(JSON.parse(kv.map.get(`short.example/${code}`)!).s).toBe('paused')
    const cleared = await call<{ title: string | null; status: string }>('PATCH', `/links/short.example/${code.toLowerCase()}`, { title: null, status: 'active' })
    expect(cleared.body).toMatchObject({ title: null, status: 'active' })
    const d = await call<{ audit: { action: string }[] }>('GET', `/links/short.example/${code}`)
    expect(d.body.audit.map((a) => a.action)).toEqual(['link.resume', 'link.pause', 'link.create'])
    expect((await call('PATCH', `/links/short.example/${code}`, { bogus: 1 })).status).toBe(400)
  })

  it('archive is permanent; the code is not reused', async () => {
    const c = await call<{ code: string }>('POST', '/links', { namespace: 'short.example', target_url: 'https://z.example', code: 'ARCH1' })
    expect((await call('DELETE', `/links/short.example/${c.body.code}`)).status).toBe(200)
    expect(JSON.parse(kv.map.get(`short.example/ARCH1`)!).s).toBe('archived')
    expect((await call('PATCH', `/links/short.example/ARCH1`, { status: 'active' })).status).toBe(409)
    expect((await call('POST', '/links', { namespace: 'short.example', target_url: 'https://z.example', code: 'ARCH1' })).status).toBe(409)
  })

  it('restricted keys see only their namespace and owner prefix', async () => {
    expect((await call('POST', '/links', { namespace: 'short.example', target_url: 'https://x.example', owner: 'tenant:1' }, LIMITED)).status).toBe(403)
    expect((await call('POST', '/links', { namespace: 'acme.tenant.example', target_url: 'https://x.example', owner: 'other' }, LIMITED)).status).toBe(403)
    const ok = await call('POST', '/links', { namespace: 'acme.tenant.example', target_url: 'https://x.example', owner: 'tenant:1' }, LIMITED)
    expect(ok.status).toBe(201)
    const list = await call<{ items: { namespace: string; owner: string }[] }>('GET', '/links', undefined, LIMITED)
    expect(list.body.items.length).toBe(1)
    expect(list.body.items[0]!.owner).toBe('tenant:1')
    expect((await call('GET', `/links/short.example/${code}`, undefined, LIMITED)).status).toBe(404)
    expect((await call('GET', '/domains', undefined, LIMITED)).status).toBe(403)
  })
})

describe('router → Postgres, stats, crons', () => {
  it('logs every request; stats and clicks read them back', async () => {
    resetDomainMemory()
    clearUnknownCache()
    const created = await call<{ code: string }>('POST', '/links', { namespace: 'short.example', target_url: 'https://t.example/', code: 'STAT1' })
    expect(created.status).toBe(201)
    const ua = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1', 'cf-connecting-ip': '198.51.100.7' }
    const go = (u: string, h: Record<string, string> = ua) => handleRequest(new Request(u, { headers: h }), env, ctx, (r, e, c) => api.fetch(r, e, c))
    expect((await go('https://short.example/stat1')).status).toBe(302)
    expect((await go('http://short.example/STAT1')).status).toBe(302)
    expect((await go('https://short.example/STAT1', { ...ua, 'user-agent': 'TelegramBot' })).status).toBe(302)
    expect((await go('https://short.example/NOPE99')).status).toBe(404)
    expect((await go('https://short.example/')).status).toBe(200) // KV domain row has no home_url

    const rows = await pg.query<{ outcome: string; scheme: string; is_bot: boolean; device: string }>(
      `select outcome, scheme, is_bot, device from shortener.clicks where namespace = 'short.example' order by ts`,
    )
    expect(rows.rows.map((r) => r.outcome)).toEqual(['redirect', 'redirect', 'redirect', 'not_found', 'home'])
    expect(rows.rows[0]!.device).toBe('mobile')
    expect(rows.rows[1]!.scheme).toBe('http')
    expect(rows.rows[2]!.is_bot).toBe(true)
    expect(ae.points).toHaveLength(5)

    const stats = await call<{ live: { outcome: string; clicks: number; uniques: number; bots: number }[] }>('GET', '/links/short.example/STAT1/stats')
    expect(stats.status).toBe(200)
    const live = stats.body.live.find((l) => l.outcome === 'redirect')!
    expect(live).toMatchObject({ clicks: 3, uniques: 1, bots: 1 })

    const clicks = await call<{ items: Record<string, unknown>[] }>('GET', '/links/short.example/STAT1/clicks?limit=2')
    expect(clicks.body.items).toHaveLength(2)
    expect(clicks.body.items[0]).not.toHaveProperty('ip_hash')
    expect(clicks.body.items[0]).not.toHaveProperty('visitor_hash')

    // /NOPE99 is read as N0PE99 (O→0)
    const ops = await call<{ items: unknown[] }>('GET', '/ops/clicks?namespace=short.example&code=N0PE99')
    expect(ops.body.items).toHaveLength(1)
  })

  it('reconcile: equal counts → ok; a missing row → mismatch + alert', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const groups = new Map<string, number>()
    for (const p of ae.points) {
      if (p.blobs[4] !== day) continue
      const k = `${p.blobs[0]}|${p.blobs[1]}|${p.blobs[2]}`
      groups.set(k, (groups.get(k) ?? 0) + 1)
    }
    const aeResponse = (extra = 0) =>
      Response.json({
        data: [...groups].map(([k, n], i) => {
          const [namespace, code, outcome] = k.split('|')
          return { namespace, code, outcome, n: String(n + (i === 0 ? extra : 0)) }
        }),
      })
    const e2 = { ...env, CF_ACCOUNT_ID: 'acc', CF_ANALYTICS_TOKEN: 'tok', ALERT_WEBHOOK_URL: 'https://hook.example/x' } as Env
    // Other tests inserted rows without AE points (via pg directly / other namespaces): count only what AE saw.
    await pg.exec(`delete from shortener.clicks where namespace <> 'short.example'`)
    fetchSpy.mockImplementation(async (input) => (String(input).includes('analytics_engine') ? aeResponse(0) : new Response('ok')))
    const ok = await reconcileDay(e2, day)
    expect(ok).toMatchObject({ status: 'ok', diff: 0, db_count: 5, edge_count: 5 })

    fetchSpy.mockImplementation(async (input) => (String(input).includes('analytics_engine') ? aeResponse(1) : new Response('ok')))
    const bad = await reconcileDay(e2, day)
    expect(bad).toMatchObject({ status: 'mismatch', diff: 1 })
    expect(fetchSpy.mock.calls.some(([u]) => String(u) === 'https://hook.example/x')).toBe(true)
    const run = await pg.query(`select status, diff::int from shortener.reconcile_runs where day = $1`, [day])
    expect(run.rows[0]).toEqual({ status: 'mismatch', diff: 1 })
    fetchSpy.mockRestore()
  })

  it('daily job rolls up yesterday; sync pushes changed links to KV', async () => {
    const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10)
    await pg.query(
      `insert into shortener.clicks (id, ts, host, namespace, code, outcome, ip_hash, visitor_hash)
       values (gen_random_uuid(), $1::date + interval '12 hours', 'short.example', 'short.example', 'STAT1', 'redirect', 'h', 'v')`,
      [y],
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: [] }))
    await dailyJob({ ...env, CF_ACCOUNT_ID: 'a', CF_ANALYTICS_TOKEN: 't' } as Env, Date.now())
    fetchSpy.mockRestore()
    const daily = await pg.query(`select clicks from shortener.clicks_daily where day = $1 and code = 'STAT1'`, [y])
    expect(daily.rows).toEqual([{ clicks: 1 }])

    kv.map.delete('short.example/STAT1')
    kv.map.delete('__domains_all')
    const r = await syncKv(env)
    expect(r.links).toBeGreaterThan(0)
    expect(JSON.parse(kv.map.get('short.example/STAT1')!).t).toBe('https://t.example/')
    expect(JSON.parse(kv.map.get('__domains_all')!)).toHaveLength(2)
    expect(kv.map.has('__domain/tenant.example')).toBe(true)
  })
})

describe('keys, domains, summary, health', () => {
  it('creates a key once, uses it, revokes it', async () => {
    const r = await call<{ id: string; key: string }>('POST', '/keys', { name: 'ci', scopes: ['links:read'] })
    expect(r.status).toBe(201)
    expect(r.body.key).toMatch(/^sk_live_[0-9a-f]{48}$/)
    expect((await call('GET', '/links', undefined, r.body.key)).status).toBe(200)
    expect((await call('POST', '/links', { namespace: 'short.example', target_url: 'https://x.example' }, r.body.key)).status).toBe(403)
    const list = await call<{ items: Record<string, unknown>[] }>('GET', '/keys')
    expect(list.body.items.every((k) => !('key_hash' in k))).toBe(true)
    expect((await call('DELETE', `/keys/${r.body.id}`)).status).toBe(200)
    clearAuthCaches()
    expect((await call('GET', '/links', undefined, r.body.key)).status).toBe(401)
  })

  it('domains upsert and patch republish KV', async () => {
    const r = await call<{ id: string; status: string }>('POST', '/domains', { apex: 'Go.Other.Example', status: 'active' })
    expect(r.status).toBe(201)
    expect(JSON.parse(kv.map.get('__domains_all')!).map((d: { apex: string }) => d.apex)).toContain('go.other.example')
    const p = await call<{ home_url: string }>('PATCH', `/domains/${r.body.id}`, { home_url: 'https://home2.example/' })
    expect(p.body.home_url).toBe('https://home2.example/')
    expect((await call('POST', '/domains', { apex: 'not a domain' })).status).toBe(400)
  })

  it('summary and ops health', async () => {
    const s = await call<{ days: unknown[] }>('GET', '/stats/summary?namespace=short.example')
    expect(s.status).toBe(200)
    expect(s.body.days.length).toBeGreaterThan(0)
    const h = await call<{ database_bytes: number; r2_pending: number }>('GET', '/ops/health')
    expect(h.status).toBe(200)
    expect(h.body.database_bytes).toBeGreaterThan(0)
    expect(h.body.r2_pending).toBe(0)
  })

  it('public config endpoint', async () => {
    const r = await api.fetch(new Request('https://short.example/_/api/config'), env, ctx)
    expect(await r.json()).toMatchObject({ auth: { provider: 'api_key' } })
  })
})
