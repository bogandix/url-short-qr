import type { Env } from '../env.js'

/** In-isolate fallback when the Rate Limiting binding is absent: 120 burst, 2 req/s per IP. */
const CAPACITY = 120
const REFILL_PER_SEC = 2
const MAX_KEYS = 50_000
const buckets = new Map<string, { tokens: number; updated: number }>()

export async function checkRateLimit(env: Env, key: string): Promise<boolean> {
  if (env.RATE_LIMIT) {
    try {
      return (await env.RATE_LIMIT.limit({ key })).success
    } catch {
      /* binding error: fall back to the local bucket */
    }
  }
  const now = Date.now()
  let b = buckets.get(key)
  if (!b) {
    if (buckets.size >= MAX_KEYS) buckets.clear()
    b = { tokens: CAPACITY, updated: now }
    buckets.set(key, b)
  }
  b.tokens = Math.min(CAPACITY, b.tokens + ((now - b.updated) / 1000) * REFILL_PER_SEC)
  b.updated = now
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

export function resetRateLimits(): void {
  buckets.clear()
}
