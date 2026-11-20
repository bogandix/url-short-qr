import type { ClickEvent, DomainRow, KvLinkValue } from '@shortener/shared'
import type { Env } from '../src/env.js'

/** Fake postgres.js client. Shared state lets tests take the database "down". */
export const db = {
  down: false,
  clicks: new Map<string, unknown[]>(),
  inserts: 0,
  reset() {
    this.down = false
    this.clicks.clear()
    this.inserts = 0
  },
}

const COLS = 32

function fakeSql() {
  const tag = (async () => {
    if (db.down) throw new Error('ECONNREFUSED')
    return Object.assign([], { count: 0 })
  }) as unknown as Record<string, unknown>
  tag.unsafe = async (text: string, params: unknown[]) => {
    if (db.down) throw new Error('ECONNREFUSED')
    db.inserts++
    let count = 0
    if (/INSERT INTO shortener\.clicks/i.test(text)) {
      for (let i = 0; i < params.length; i += COLS) {
        const row = params.slice(i, i + COLS)
        const key = `${row[0]}|${row[1]}`
        if (!db.clicks.has(key)) {
          db.clicks.set(key, row)
          count++
        }
      }
    }
    return Object.assign([], { count })
  }
  tag.end = async () => {}
  tag.begin = async (fn: (tx: unknown) => unknown) => fn(tag)
  return tag
}

export const postgresMock = { default: () => fakeSql() }

export function clickRows(): { outcome: string; source: string; scheme: string; code: string; namespace: string }[] {
  return [...db.clicks.values()].map((r) => ({
    code: r[4] as string,
    namespace: r[3] as string,
    outcome: r[6] as string,
    scheme: r[10] as string,
    source: r[31] as string,
  }))
}

export class FakeKV {
  map = new Map<string, string>()
  down = false
  async get(key: string, opts?: unknown) {
    if (this.down) throw new Error('kv down')
    const v = this.map.get(key)
    if (v == null) return null
    const type = typeof opts === 'string' ? opts : (opts as { type?: string } | undefined)?.type
    return type === 'json' ? JSON.parse(v) : v
  }
  async put(key: string, value: string) {
    if (this.down) throw new Error('kv down')
    this.map.set(key, value)
  }
  async delete(key: string) {
    this.map.delete(key)
  }
  async list(opts: { prefix?: string; limit?: number }) {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort()
    const limit = opts.limit ?? 1000
    return { keys: keys.slice(0, limit).map((name) => ({ name })), list_complete: keys.length <= limit, cursor: undefined }
  }
}

export class FakeR2 {
  objects = new Map<string, string>()
  down = false
  async put(key: string, value: string | ArrayBuffer) {
    if (this.down) throw new Error('r2 down')
    this.objects.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value))
    return {}
  }
  async get(key: string) {
    const v = this.objects.get(key)
    if (v == null) return null
    return { text: async () => v, arrayBuffer: async () => new TextEncoder().encode(v).buffer }
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k)
  }
  async list(opts: { prefix?: string; limit?: number }) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort()
    const limit = opts.limit ?? 1000
    return { objects: keys.slice(0, limit).map((key) => ({ key })), truncated: keys.length > limit, cursor: undefined }
  }
}

export class FakeAE {
  points: { blobs: string[] }[] = []
  writeDataPoint(p: { blobs: string[] }) {
    this.points.push(p)
  }
}

export function domain(over: Partial<DomainRow> & { apex: string }): DomainRow {
  return {
    id: crypto.randomUUID(),
    zone_id: null,
    registrar: null,
    serve_www: true,
    wildcard: false,
    wildcard_mode: 'namespace',
    home_url: null,
    not_found_url: null,
    code_length: 4,
    is_admin_host: false,
    status: 'active',
    ...over,
  }
}

export function makeEnv(domains: DomainRow[], links: Record<string, KvLinkValue> = {}, over: Partial<Env> = {}) {
  const kv = new FakeKV()
  kv.map.set('__domains_all', JSON.stringify(domains))
  for (const [k, v] of Object.entries(links)) kv.map.set(k, JSON.stringify(v))
  const r2 = new FakeR2()
  const ae = new FakeAE()
  const env = {
    LINKS: kv,
    FALLBACK: r2,
    DB: { connectionString: 'postgres://fake' },
    CLICKS_AE: ae,
    SECRET_SALT: 'test-salt',
    MODE: 'free',
    STRICT_LOGGING: 'false',
    ...over,
  } as unknown as Env
  return { env, kv, r2, ae }
}

export const ctx = {
  waitUntil(p: Promise<unknown>) {
    void p
  },
  passThroughOnException() {},
} as unknown as ExecutionContext

export function link(over: Partial<KvLinkValue> = {}): KvLinkValue {
  return { id: crypto.randomUUID(), t: 'https://target.example/page', s: 'active', x: null, f: null, u: {}, v: 1, ...over }
}

export type { ClickEvent }
