import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('postgres', async () => (await import('./fakes.js')).postgresMock)

import { handleRequest } from '../src/router.js'
import { replayPending } from '../src/lib/cron.js'
import { resetDomainMemory } from '../src/lib/domains.js'
import { clearUnknownCache } from '../src/lib/lookup.js'
import { resetRateLimits } from '../src/lib/ratelimit.js'
import { clickRows, ctx, db, domain, link, makeEnv } from './fakes.js'

const api = vi.fn(async () => new Response('api'))
const NO_STORE = 'private, no-store, max-age=0'

const domains = [
  domain({ apex: 'short.example', is_admin_host: true, home_url: 'https://home.example/' }),
  domain({ apex: 'tenant.example', wildcard: true, wildcard_mode: 'namespace' }),
]
const links = {
  'short.example/A7K2': link({ t: 'https://target.example/a' }),
  'short.example/PAUSED': link({ s: 'paused' }),
  'short.example/01D': link({ x: '2000-01-01T00:00:00.000Z' }), // stored normalized
  'short.example/GONE': link({ s: 'archived' }),
  'short.example/UTM': link({ t: 'https://t.example/?utm_source=keep', u: { utm_source: 'x', utm_medium: 'qr' }, a: true }),
  'acme.tenant.example/X1': link({ t: 'https://acme.example/' }),
  'beta.tenant.example/X1': link({ t: 'https://beta.example/' }),
}

function req(url: string, init: RequestInit & { ua?: string } = {}) {
  const headers = new Headers(init.headers)
  headers.set('cf-connecting-ip', '203.0.113.9')
  headers.set('user-agent', init.ua ?? 'Mozilla/5.0 (Macintosh) Safari/605')
  return new Request(url, { ...init, headers })
}

beforeEach(() => {
  db.reset()
  resetDomainMemory()
  clearUnknownCache()
  resetRateLimits()
  api.mockClear()
})

describe('status and headers per outcome', () => {
  const cases: [string, number, string][] = [
    ['https://short.example/A7K2', 302, 'redirect'],
    ['https://short.example/a7k2', 302, 'redirect'], // lowercase
    ['https://short.example/A7K2/', 302, 'redirect'], // trailing slash
    ['https://short.example/NOPE99', 404, 'not_found'],
    ['https://short.example/PAUSED', 410, 'paused'],
    ['https://short.example/old', 410, 'expired'], // o→0, l→1: /old reads as 01D
    ['https://short.example/GONE', 404, 'not_found'],
    ['https://short.example/A7K2+', 200, 'preview'],
    ['https://short.example/', 302, 'home'],
    ['https://short.example/_/nothing', 404, 'invalid'],
    ['https://unknown.example/A7K2', 404, 'invalid'],
  ]
  for (const [url, status, outcome] of cases) {
    it(`${url} → ${status} ${outcome}`, async () => {
      const { env } = makeEnv(domains, links)
      const res = await handleRequest(req(url), env, ctx, api)
      expect(res.status).toBe(status)
      expect(res.status).not.toBe(301)
      expect(res.headers.get('cache-control')).toBe(NO_STORE)
      expect(res.headers.get('x-robots-tag')).toBe('noindex')
      expect(res.headers.get('set-cookie')).toBeNull()
      const rows = clickRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.outcome).toBe(outcome)
    })
  }

  it('redirect target and UTM merge', async () => {
    const { env } = makeEnv(domains, links)
    const r1 = await handleRequest(req('https://short.example/A7K2'), env, ctx, api)
    expect(r1.headers.get('location')).toBe('https://target.example/a')
    const r2 = await handleRequest(req('https://short.example/UTM'), env, ctx, api)
    const loc = new URL(r2.headers.get('location')!)
    expect(loc.searchParams.get('utm_source')).toBe('keep')
    expect(loc.searchParams.get('utm_medium')).toBe('qr')
  })

  it('http:// is served, logged with scheme http', async () => {
    const { env } = makeEnv(domains, links)
    const res = await handleRequest(req('http://short.example/A7K2'), env, ctx, api)
    expect(res.status).toBe(302)
    expect(clickRows()[0]!.scheme).toBe('http')
  })

  it('rate limited → 429, logged', async () => {
    const { env } = makeEnv(domains, links, { RATE_LIMIT: { limit: async () => ({ success: false }) } })
    const res = await handleRequest(req('https://short.example/A7K2'), env, ctx, api)
    expect(res.status).toBe(429)
    expect(res.headers.get('cache-control')).toBe(NO_STORE)
    expect(clickRows()[0]!.outcome).toBe('rate_limited')
  })

  it('bots are redirected and logged as bots', async () => {
    const { env } = makeEnv(domains, links)
    const res = await handleRequest(req('https://short.example/A7K2', { ua: 'Slackbot-LinkExpanding 1.0' }), env, ctx, api)
    expect(res.status).toBe(302)
    expect(clickRows()[0]!.is_bot).toBe(true)
  })
})

describe('tracking detail', () => {
  it('captures location, network, device, client hints, language, referrer and UTM', async () => {
    const { env } = makeEnv(domains, links)
    const r = new Request('https://short.example/A7K2?utm_source=flyer&utm_medium=qr&utm_campaign=sample-1', {
      headers: {
        'cf-connecting-ip': '203.0.113.9',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
        'accept-language': 'ro-RO,ro;q=0.9,en;q=0.8',
        referer: 'https://www.facebook.com/some/post?x=1',
        'sec-ch-ua-platform': '"iOS"',
        'sec-ch-ua-mobile': '?1',
        'sec-gpc': '1',
      },
    })
    Object.defineProperty(r, 'cf', {
      value: {
        country: 'RO', city: 'Bucharest', region: 'Bucharest', regionCode: 'B', timezone: 'Europe/Bucharest', colo: 'OTP',
        continent: 'EU', postalCode: '010011', latitude: '44.43225', longitude: '26.10626', isEUCountry: '1',
        asn: 8708, asOrganization: 'DIGI ROMANIA S.A.', httpProtocol: 'HTTP/3', tlsVersion: 'TLSv1.3', clientTcpRtt: 23,
      },
    })
    expect((await handleRequest(r, env, ctx, api)).status).toBe(302)
    expect(clickRows()[0]).toMatchObject({
      outcome: 'redirect', country: 'RO', city: 'Bucharest', continent: 'EU', postal_code: '010011',
      latitude: 44.43, longitude: 26.11, is_eu: true, asn: 8708, http_protocol: 'HTTP/3', tls_version: 'TLSv1.3', client_rtt_ms: 23,
      device: 'mobile', device_vendor: 'Apple', device_model: 'iPhone', os: 'iOS 18.1', browser: 'Mobile Safari', browser_major: '18',
      engine: 'WebKit', ch_platform: 'iOS', ch_mobile: true, lang_primary: 'ro', dnt: true,
      referer_host: 'www.facebook.com', utm_source: 'flyer', utm_medium: 'qr', utm_campaign: 'sample-1', is_bot: false,
    })
  })
})

describe('wildcard namespaces', () => {
  it('a.<apex>/X and b.<apex>/X resolve to different links', async () => {
    const { env } = makeEnv(domains, links)
    const a = await handleRequest(req('https://acme.tenant.example/X1'), env, ctx, api)
    const b = await handleRequest(req('https://beta.tenant.example/X1'), env, ctx, api)
    expect(a.headers.get('location')).toBe('https://acme.example/')
    expect(b.headers.get('location')).toBe('https://beta.example/')
    expect(clickRows().map((r) => r.namespace).sort()).toEqual(['acme.tenant.example', 'beta.tenant.example'])
  })
})

describe('admin host and QR', () => {
  it('/_/api answers only on the admin host, unlogged', async () => {
    const { env } = makeEnv(domains, links)
    const r = await handleRequest(req('https://short.example/_/api/links'), env, ctx, api)
    expect(await r.text()).toBe('api')
    expect(clickRows()).toHaveLength(0)
    const r2 = await handleRequest(req('https://acme.tenant.example/_/api/links'), env, ctx, api)
    expect(r2.status).toBe(404)
    expect(api).toHaveBeenCalledTimes(1)
    expect(clickRows()[0]!.outcome).toBe('invalid')
  })

  it('QR svg/png are edge-cacheable and not logged', async () => {
    const { env, ae } = makeEnv(domains, links)
    const svg = await handleRequest(req('https://short.example/_/qr/a7k2.svg?size=256'), env, ctx, api)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    expect(svg.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await svg.text()).toContain('<svg')
    const png = await handleRequest(req('https://short.example/_/qr/A7K2.png'), env, ctx, api)
    const bytes = new Uint8Array(await png.arrayBuffer())
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(new DataView(bytes.buffer).getUint32(16)).toBeGreaterThan(100) // width
    expect(clickRows()).toHaveLength(0)
    expect(ae.points).toHaveLength(0)
  })
})

describe('logging guarantee', () => {
  it('every logged request writes one AE point', async () => {
    const { env, ae } = makeEnv(domains, links)
    for (const u of ['https://short.example/A7K2', 'https://short.example/NOPE', 'https://x.example/']) {
      await handleRequest(req(u), env, ctx, api)
    }
    expect(ae.points).toHaveLength(3)
    expect(clickRows()).toHaveLength(3)
  })

  it('database down → event lands in R2 → replay inserts it once', async () => {
    const { env, r2 } = makeEnv(domains, links)
    db.down = true
    const res = await handleRequest(req('https://short.example/A7K2'), env, ctx, api)
    expect(res.status).toBe(302) // redirect never fails
    expect(r2.objects.size).toBe(1)
    const [key] = [...r2.objects.keys()]
    expect(key).toMatch(/^pending\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.json$/)

    db.down = false
    const r = await replayPending(env)
    expect(r).toMatchObject({ read: 1, inserted: 1, deleted: 1 })
    expect(r2.objects.size).toBe(0)
    expect(clickRows()).toEqual([expect.objectContaining({ outcome: 'redirect', source: 'replay' })])

  })

  it('a duplicate event gives one row', async () => {
    const { env, r2 } = makeEnv(domains, links)
    db.down = true
    await handleRequest(req('https://short.example/A7K2'), env, ctx, api)
    const [[key, body]] = [...r2.objects.entries()] as [[string, string]]
    db.down = false
    await replayPending(env)
    r2.objects.set(key, body) // same object reappears
    const again = await replayPending(env)
    expect(again.inserted).toBe(0)
    expect(db.clicks.size).toBe(1)
  })

  it('without an R2 binding the outage buffer is KV, and replay drains it', async () => {
    const { env, kv } = makeEnv(domains, links, { FALLBACK: undefined })
    db.down = true
    expect((await handleRequest(req('https://short.example/A7K2'), env, ctx, api)).status).toBe(302)
    const pending = [...kv.map.keys()].filter((k) => k.startsWith('pending/'))
    expect(pending).toHaveLength(1)
    db.down = false
    expect(await replayPending(env)).toMatchObject({ read: 1, inserted: 1, deleted: 1 })
    expect([...kv.map.keys()].some((k) => k.startsWith('pending/'))).toBe(false)
  })

  it('STRICT_LOGGING=true with both stores down → 503', async () => {
    const { env, r2 } = makeEnv(domains, links, { STRICT_LOGGING: 'true' })
    db.down = true
    r2.down = true
    const res = await handleRequest(req('https://short.example/A7K2'), env, ctx, api)
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe(NO_STORE)
  })

  it('STRICT_LOGGING=false with both stores down still redirects', async () => {
    const { env, r2 } = makeEnv(domains, links)
    db.down = true
    r2.down = true
    const res = await handleRequest(req('https://short.example/A7K2'), env, ctx, api)
    expect(res.status).toBe(302)
  })

  it('paid mode sends to the queue; R2 fallback when the queue throws', async () => {
    const sent: unknown[] = []
    const { env, r2 } = makeEnv(domains, links, {
      MODE: 'paid',
      CLICKS: { send: async (m: unknown) => void sent.push(m) } as unknown as Queue,
    })
    await handleRequest(req('https://short.example/A7K2'), env, ctx, api)
    expect(sent).toHaveLength(1)
    expect(db.clicks.size).toBe(0)
    ;(env.CLICKS as unknown as { send: () => Promise<void> }).send = async () => {
      throw new Error('queue down')
    }
    await handleRequest(req('https://short.example/A7K2'), env, ctx, api)
    expect(r2.objects.size).toBe(1)
  })
})
