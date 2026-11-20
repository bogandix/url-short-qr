import { kvKey, type KvLinkValue } from '@shortener/shared'
import type { Env } from '../env.js'

const MISS_MS = 60_000
const MISS_MAX = 10_000
const unknownCache = new Map<string, number>()

/** KV lookup (edge-cached 60 s). Unknown codes are remembered in-isolate for 60 s. */
export async function lookupLink(env: Env, namespace: string, code: string): Promise<KvLinkValue | null> {
  const key = kvKey(namespace, code)
  const missAt = unknownCache.get(key)
  if (missAt && Date.now() - missAt < MISS_MS) return null

  const raw = await env.LINKS.get<KvLinkValue>(key, { type: 'json', cacheTtl: 60 })
  if (!raw) {
    if (unknownCache.size >= MISS_MAX) unknownCache.clear()
    unknownCache.set(key, Date.now())
    return null
  }
  unknownCache.delete(key)
  return raw
}

export function clearUnknownCache(): void {
  unknownCache.clear()
}

export function linkToKv(row: {
  id: string
  target_url: string
  status: string
  expires_at: Date | string | null
  fallback_url: string | null
  utm: Record<string, string> | string | null
  append_utm: boolean
  version: number
}): KvLinkValue {
  const utm = typeof row.utm === 'string' ? (JSON.parse(row.utm) as Record<string, string>) : (row.utm ?? {})
  const x = row.expires_at == null ? null : new Date(row.expires_at).toISOString()
  return {
    id: row.id,
    t: row.target_url,
    s: row.status as KvLinkValue['s'],
    x,
    f: row.fallback_url,
    u: utm,
    a: row.append_utm,
    v: row.version,
  }
}
