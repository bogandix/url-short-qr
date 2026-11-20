/**
 * End-to-end through the real code paths: Hono API + router + crons → postgres.js →
 * PGlite (real Postgres in WASM) over a socket. KV/R2/AE are in-memory fakes.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// PGlite's socket server takes one connection at a time; production opens a short-lived
// client per request (Hyperdrive pools). Share one real client here and make end() a no-op.
vi.mock('postgres', async () => {
  const real = (await vi.importActual<typeof import('postgres')>('postgres')).default
  let shared: ReturnType<typeof real> | null = null
  const make = (url: string, opts: Parameters<typeof real>[1]) => {
    shared ??= real(url, { ...opts, max: 1, idle_timeout: 0 })
    return new Proxy(shared, {
      get: (t, k) => (k === 'end' ? async () => {} : Reflect.get(t, k)),
      apply: (t, self, args) => Reflect.apply(t as never, self, args),
    })
  }
  return { default: make }
})
import { api } from '../apps/edge/src/api/index.js'
import { clearAuthCaches, sha256Hex } from '../apps/edge/src/lib/auth.js'
import { hashPassword } from '../packages/shared/src/index.js'
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
    expect(r.body.short_url).toBe(`HTTPS://SHORT.EXAMPLE/${code}`)
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

  it('accepts an uppercase scheme (e.g. a pasted short URL) and stores it lowercase', async () => {
    const r = await call<{ target_url: string; fallback_url: string }>('POST', '/links', {
      namespace: 'short.example',
      target_url: 'HTTPS://VV1.EU/VHTV',
      fallback_url: 'Https://Example.com/Path',
    })
    expect(r.status).toBe(201)
    expect(r.body.target_url).toBe('https://VV1.EU/VHTV')
    expect(r.body.fallback_url).toBe('https://Example.com/Path')
  })

  it('database constraint errors become 4xx with a reason, not 500', async () => {
    await pg.exec(`alter table shortener.links add constraint tmp_no_zzz check (title is distinct from 'zzz')`)
    const r = await call<{ error: string; detail: string }>('POST', '/links', { namespace: 'short.example', target_url: 'https://x.example', title: 'zzz' })
    await pg.exec(`alter table shortener.links drop constraint tmp_no_zzz`)
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: 'invalid_value', detail: 'tmp_no_zzz' })
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

describe('integration API (vrumvrum)', () => {
  it('external_id makes create idempotent per owner; lookup by external id', async () => {
    const body = { namespace: 'short.example', target_url: 'https://vrumvrum.example/anunt/1', owner: 'vrumvrum:garage:7', external_id: 'listing-1', metadata: { listing: 1 } }
    const a = await call<{ code: string; existed?: boolean; metadata: Record<string, unknown> }>('POST', '/links', body)
    expect(a.status).toBe(201)
    expect(a.body.metadata).toEqual({ listing: 1 })
    const b = await call<{ code: string; existed?: boolean }>('POST', '/links', { ...body, target_url: 'https://other.example/' })
    expect(b.status).toBe(200)
    expect(b.body).toMatchObject({ code: a.body.code, existed: true })
    const other = await call('POST', '/links', { ...body, owner: 'vrumvrum:garage:8' })
    expect(other.status).toBe(201) // same external id, different owner
    const found = await call<{ code: string }>('GET', '/links/by-external/listing-1?owner=vrumvrum:garage:7')
    expect(found.body.code).toBe(a.body.code)
    expect((await call('GET', '/links/by-external/nope?owner=vrumvrum:garage:7')).status).toBe(404)
    const listed = await call<{ items: unknown[] }>('GET', '/links?external_id=listing-1')
    expect(listed.body.items).toHaveLength(2)
    const patched = await call<{ metadata: Record<string, unknown> }>('PATCH', `/links/short.example/${a.body.code}`, { metadata: { listing: 1, sold: true } })
    expect(patched.body.metadata).toEqual({ listing: 1, sold: true })
  })

  it('overview returns series, totals, top links and breakdowns', async () => {
    const r = await call<{
      totals: { clicks: number; requests: number }
      series: { day: string }[]
      top: { code: string; clicks: number }[]
      breakdowns: Record<string, { key: string; n: number }[]>
      outcomes: { outcome: string; n: number }[]
    }>('GET', '/stats/overview?namespace=short.example')
    expect(r.status).toBe(200)
    expect(r.body.totals.requests).toBeGreaterThan(0)
    expect(r.body.top[0]!.code).toBe('STAT1')
    expect(r.body.breakdowns.device!.map((x) => x.key)).toContain('mobile')
    expect(r.body.breakdowns.referer!.map((x) => x.key)).toContain('direct')
    expect(r.body.outcomes.map((x) => x.outcome)).toContain('redirect')
    expect((await call('GET', '/stats/overview?from=2026-02-01&to=2026-01-01')).status).toBe(400)
  })

  it('openapi document is public', async () => {
    const r = await api.fetch(new Request('https://short.example/_/api/openapi.json'), env, ctx)
    const j = (await r.json()) as { openapi: string; paths: Record<string, unknown> }
    expect(j.openapi).toBe('3.1.0')
    expect(j.paths).toHaveProperty('/links/by-external/{external_id}')
  })
})

describe('built-in admin login', () => {
  const post = async (path: string, body: unknown, token?: string) => {
    const r = await api.fetch(
      new Request(`https://short.example/_/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.50', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    )
    return { status: r.status, body: (await r.json()) as Record<string, unknown> }
  }

  it('temporary password → must change → full access; old sessions die', async () => {
    await pg.query(`insert into shortener.admins (email, password_hash, must_change_password) values ($1, $2, true)`, [
      'boss@example.com',
      await hashPassword('Temp-Password-1'),
    ])
    expect((await post('/auth/login', { email: 'boss@example.com', password: 'nope' })).status).toBe(401)
    const login = await post('/auth/login', { email: 'BOSS@example.com', password: 'Temp-Password-1' })
    expect(login.status).toBe(200)
    expect(login.body.must_change_password).toBe(true)
    const temp = login.body.token as string
    clearAuthCaches()
    expect((await call('GET', '/links', undefined, temp)).status).toBe(403) // no scopes until changed

    expect((await post('/auth/password', { current_password: 'Temp-Password-1', new_password: 'short' }, temp)).status).toBe(400)
    const changed = await post('/auth/password', { current_password: 'Temp-Password-1', new_password: 'A-much-better-password' }, temp)
    expect(changed.status).toBe(200)
    expect(changed.body.must_change_password).toBe(false)
    clearAuthCaches()
    expect((await call('GET', '/links', undefined, changed.body.token as string)).status).toBe(200)
    expect((await call('GET', '/links', undefined, temp)).status).toBe(401) // epoch bumped
    expect((await post('/auth/login', { email: 'boss@example.com', password: 'Temp-Password-1' })).status).toBe(401)
  })

  it('locks the account after 10 failures', async () => {
    await pg.query(`insert into shortener.admins (email, password_hash) values ($1, $2)`, ['lock@example.com', await hashPassword('Right-Password-1')])
    for (let i = 0; i < 10; i++) await post('/auth/login', { email: 'lock@example.com', password: `wrong-${i}` })
    expect((await post('/auth/login', { email: 'lock@example.com', password: 'Right-Password-1' })).status).toBe(429)
  })

  it('a forged session token is rejected', async () => {
    const forged = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ typ: 'adm', sub: 'boss@example.com', ep: 1, mc: false, iat: 1, exp: 9e9 })).toString('base64url') + '.AAAA'
    expect((await call('GET', '/links', undefined, forged)).status).toBe(401)
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
    expect(await r.json()).toMatchObject({ auth: { provider: 'password' } })
  })
})
