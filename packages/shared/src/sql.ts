import type { ClickEvent } from './events.js'

export const INSERT_CLICK_SQL = `
INSERT INTO shortener.clicks (
  id, ts, host, namespace, code, link_id, outcome,
  method, path, query, scheme,
  country, region, region_code, city, timezone, colo,
  asn, as_org,
  ua, device, os, browser, browser_version, lang, referer,
  ip_hash, visitor_hash, is_bot, bot_name, ray_id, source
) VALUES (
  $1, $2::timestamptz, $3, $4, $5, $6, $7,
  $8, $9, $10, $11,
  $12, $13, $14, $15, $16, $17,
  $18, $19,
  $20, $21, $22, $23, $24, $25, $26,
  $27, $28, $29, $30, $31, $32
)
ON CONFLICT (id, ts) DO NOTHING
`

export function clickParams(ev: ClickEvent): unknown[] {
  return [
    ev.id,
    ev.ts,
    ev.host,
    ev.namespace,
    ev.code,
    ev.link_id,
    ev.outcome,
    ev.method,
    ev.path,
    ev.query,
    ev.scheme,
    ev.country,
    ev.region,
    ev.region_code,
    ev.city,
    ev.timezone,
    ev.colo,
    ev.asn,
    ev.as_org,
    ev.ua,
    ev.device,
    ev.os,
    ev.browser,
    ev.browser_version,
    ev.lang,
    ev.referer,
    ev.ip_hash,
    ev.visitor_hash,
    ev.is_bot,
    ev.bot_name,
    ev.ray_id,
    ev.source,
  ]
}

export function buildBulkInsert(events: ClickEvent[]): { sql: string; params: unknown[] } {
  if (events.length === 0) return { sql: '', params: [] }
  const cols = 32
  const values: string[] = []
  const params: unknown[] = []
  events.forEach((ev, i) => {
    const base = i * cols
    const placeholders = Array.from({ length: cols }, (_, j) => `$${base + j + 1}`).join(', ')
    // ts cast
    const parts = placeholders.split(', ')
    parts[1] = `${parts[1]}::timestamptz`
    values.push(`(${parts.join(', ')})`)
    params.push(...clickParams(ev))
  })
  const sql = `
INSERT INTO shortener.clicks (
  id, ts, host, namespace, code, link_id, outcome,
  method, path, query, scheme,
  country, region, region_code, city, timezone, colo,
  asn, as_org,
  ua, device, os, browser, browser_version, lang, referer,
  ip_hash, visitor_hash, is_bot, bot_name, ray_id, source
) VALUES ${values.join(',\n')}
ON CONFLICT (id, ts) DO NOTHING
`
  return { sql, params }
}
