import { INSERT_CLICK_SQL, clickParams, type ClickEvent } from '@shortener/shared'
import type { Env } from '../env.js'
import { sqlClient, withSql } from './db.js'

export const NO_STORE = 'private, no-store, max-age=0'

export function noStoreHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Cache-Control': NO_STORE, 'X-Robots-Tag': 'noindex', ...extra }
}

export function unavailable(): Response {
  return new Response('Service temporarily unavailable', {
    status: 503,
    headers: noStoreHeaders({ 'Retry-After': '30' }),
  })
}

export function fallbackKey(ev: ClickEvent): string {
  return `pending/${ev.ts.slice(0, 10)}/${ev.id}.json`
}

export async function insertClick(env: Env, ev: ClickEvent): Promise<void> {
  await withSql(
    () => sqlClient(env),
    (sql) => sql.unsafe(INSERT_CLICK_SQL, clickParams(ev) as never[]),
  )
}

async function putFallback(env: Env, ev: ClickEvent): Promise<boolean> {
  try {
    await env.FALLBACK.put(fallbackKey(ev), JSON.stringify(ev), {
      httpMetadata: { contentType: 'application/json' },
    })
    return true
  } catch (err) {
    console.error('fallback-put-failed', ev.id, String(err))
    return false
  }
}

/** Independent counter for reconcile. blob5 = event day so midnight edges reconcile exactly. */
export function writeAnalytics(env: Env, ev: ClickEvent): void {
  try {
    env.CLICKS_AE?.writeDataPoint({
      indexes: [ev.namespace.slice(0, 96)],
      blobs: [ev.namespace, ev.code, ev.outcome, ev.id, ev.ts.slice(0, 10)],
      doubles: [1],
    })
  } catch (err) {
    console.error('ae-write-failed', ev.id, String(err))
  }
}

/**
 * Store one event durably: Postgres (free) or Queue (paid), R2 as fallback.
 * Returns false only when both stores failed.
 */
export async function persistClick(env: Env, ev: ClickEvent): Promise<boolean> {
  let stored = false
  try {
    if (env.MODE === 'paid' && env.CLICKS) await env.CLICKS.send(ev, { contentType: 'json' })
    else await insertClick(env, ev)
    stored = true
  } catch (err) {
    console.warn('primary-store-failed', ev.id, String(err))
    stored = await putFallback(env, ev)
  }

  writeAnalytics(env, ev)

  if (!stored) console.error('click-lost', JSON.stringify(ev))
  return stored
}

export function strictLogging(env: Env): boolean {
  return env.STRICT_LOGGING === 'true'
}
