/**
 * Outage buffer for click events: R2 when the FALLBACK bucket is bound, otherwise KV
 * (keys under `pending/` in the LINKS namespace). KV is fully free on the Workers Free
 * plan but allows ~1,000 writes/day there; R2 allows ~1M writes/month.
 */
import type { Env } from '../env.js'

export type PendingPage = { keys: string[]; truncated: boolean; cursor?: string }

export interface FallbackStore {
  kind: 'r2' | 'kv'
  put(key: string, body: string): Promise<void>
  get(key: string): Promise<string | null>
  delete(keys: string[]): Promise<void>
  list(prefix: string, limit: number, cursor?: string): Promise<PendingPage>
}

export function fallbackStore(env: Env): FallbackStore {
  const r2 = env.FALLBACK
  if (r2) {
    return {
      kind: 'r2',
      async put(key, body) {
        await r2.put(key, body, { httpMetadata: { contentType: 'application/json' } })
      },
      async get(key) {
        const o = await r2.get(key)
        return o ? o.text() : null
      },
      async delete(keys) {
        if (keys.length) await r2.delete(keys)
      },
      async list(prefix, limit, cursor) {
        const p = await r2.list({ prefix, limit, cursor })
        return { keys: p.objects.map((o) => o.key), truncated: p.truncated, cursor: p.truncated ? p.cursor : undefined }
      },
    }
  }
  const kv = env.LINKS
  return {
    kind: 'kv',
    async put(key, body) {
      await kv.put(key, body, { expirationTtl: 30 * 86400 })
    },
    async get(key) {
      return kv.get(key)
    },
    async delete(keys) {
      await Promise.all(keys.map((k) => kv.delete(k)))
    },
    async list(prefix, limit, cursor) {
      const p = await kv.list({ prefix, limit, cursor })
      return { keys: p.keys.map((k) => k.name), truncated: !p.list_complete, cursor: p.list_complete ? undefined : p.cursor }
    },
  }
}
