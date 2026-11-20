import { describe, expect, it } from 'vitest'
import { sameNs } from '../registrars/types.js'
import { tokenPageUrl } from './cf.js'
import { rolePasswordSql } from './migrate.js'
import { lit } from './sql.js'
import { defaultState, type DomainState } from './state.js'
import { edgeConfig } from './wrangler.js'

const dom = (apex: string, over: Partial<DomainState> = {}): DomainState => ({
  apex, registrar: 'manual', serveWww: true, wildcard: false, wildcardMode: 'namespace', isAdminHost: false,
  codeLength: 4, zoneId: `z-${apex}`, done: { active: 'x' }, ...over,
})

describe('edge wrangler config', () => {
  it('routes: custom domains for apex/www, zone route for wildcard; inactive zones skipped', () => {
    const s = defaultState()
    s.accountId = 'acc'
    s.resources = { kvId: 'kv', r2Bucket: 'b', hyperdriveEdgeId: 'h1', hyperdriveAdminId: 'h2', aeDataset: 'shortener_clicks' }
    s.domains = {
      'short.example': dom('short.example', { isAdminHost: true }),
      'tenant.example': dom('tenant.example', { serveWww: false, wildcard: true }),
      'pending.example': dom('pending.example', { done: {} }),
    }
    const cfg = edgeConfig(s) as { routes: unknown[]; hyperdrive: { binding: string }[]; vars: Record<string, string>; queues?: unknown }
    expect(cfg.routes).toEqual([
      { pattern: 'short.example', custom_domain: true },
      { pattern: 'www.short.example', custom_domain: true },
      { pattern: 'tenant.example', custom_domain: true },
      { pattern: '*.tenant.example/*', zone_id: 'z-tenant.example' },
    ])
    expect(cfg.hyperdrive.map((h) => h.binding)).toEqual(['DB', 'DB_ADMIN'])
    expect(cfg.vars).toMatchObject({ MODE: 'free', CF_ACCOUNT_ID: 'acc', STRICT_LOGGING: 'false' })
    expect(cfg.queues).toBeUndefined()
    expect(JSON.stringify(cfg)).not.toMatch(/password|secret|sk_live/i)
    s.mode = 'paid'
    s.resources.queue = 'shortener-clicks'
    expect((edgeConfig(s) as { queues: unknown }).queues).toEqual({ producers: [{ binding: 'CLICKS', queue: 'shortener-clicks' }] })
  })
})

describe('helpers', () => {
  it('token page is pre-filled', () => {
    const u = new URL(tokenPageUrl())
    expect(u.host).toBe('dash.cloudflare.com')
    expect(JSON.parse(u.searchParams.get('permissionGroupKeys')!)).toContainEqual({ key: 'hyperdrive', type: 'edit' })
  })
  it('sql literals and role passwords are safe', () => {
    expect(lit("o'brien")).toBe("'o''brien'")
    expect(lit(null)).toBe('null')
    expect(() => rolePasswordSql('shortener_edge', "x'; drop table y; --aaaaaaaaaaaaaaa")).toThrow()
    expect(rolePasswordSql('shortener_edge', 'A'.repeat(32))).toContain("login password 'AAAA")
  })
  it('nameserver comparison ignores case, order and trailing dots', () => {
    expect(sameNs(['B.ns.cloudflare.com.', 'a.ns.cloudflare.com'], ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'])).toBe(true)
  })
})
