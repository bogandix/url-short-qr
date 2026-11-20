import { z } from 'zod'

export const ClickOutcome = z.enum([
  'redirect',
  'not_found',
  'paused',
  'expired',
  'preview',
  'rate_limited',
  'home',
  'invalid',
])
export type ClickOutcome = z.infer<typeof ClickOutcome>

const s = () => z.string().nullable().default(null)
const n = () => z.number().nullable().default(null)
const b = () => z.boolean().nullable().default(null)

/**
 * One row of shortener.clicks. Fields added after v1 default to null so older events
 * waiting in the outage buffer or the queue still validate and insert.
 */
export const ClickEventSchema = z.object({
  id: z.string().uuid(),
  ts: z.string(),
  host: z.string(),
  namespace: z.string(),
  code: z.string(),
  link_id: z.string().uuid().nullable(),
  outcome: ClickOutcome,
  method: z.string(),
  path: z.string(),
  query: z.string().nullable(),
  scheme: z.enum(['http', 'https']),
  // location (Cloudflare request.cf)
  country: z.string().nullable(),
  region: z.string().nullable(),
  region_code: z.string().nullable(),
  city: z.string().nullable(),
  timezone: z.string().nullable(),
  colo: z.string().nullable(),
  continent: s(),
  postal_code: s(),
  metro_code: s(),
  latitude: n(), // city-level estimate, rounded to 2 decimals (~1 km)
  longitude: n(),
  is_eu: b(),
  // network
  asn: z.number().nullable(),
  as_org: z.string().nullable(),
  http_protocol: s(),
  tls_version: s(),
  client_rtt_ms: n(),
  // client
  ua: z.string().nullable(),
  device: z.string().nullable(),
  device_vendor: s(),
  device_model: s(),
  os: z.string().nullable(),
  browser: z.string().nullable(),
  browser_version: z.string().nullable(),
  browser_major: s(),
  engine: s(),
  cpu_arch: s(),
  ch_platform: s(), // Sec-CH-UA-Platform
  ch_mobile: b(), // Sec-CH-UA-Mobile
  ch_model: s(), // Sec-CH-UA-Model (when the browser sends it)
  lang: z.string().nullable(), // raw Accept-Language
  lang_primary: s(), // e.g. "ro", "en"
  dnt: b(), // DNT: 1 or Sec-GPC: 1
  // source
  referer: z.string().nullable(),
  referer_host: s(),
  utm_source: s(),
  utm_medium: s(),
  utm_campaign: s(),
  utm_term: s(),
  utm_content: s(),
  // identity (hashed) and classification
  ip_hash: z.string(),
  visitor_hash: z.string(),
  is_bot: z.boolean(),
  bot_name: z.string().nullable(),
  ray_id: z.string().nullable(),
  source: z.enum(['live', 'replay']),
})

export type ClickEvent = z.infer<typeof ClickEventSchema>

/** Column order used by every INSERT into shortener.clicks (single source of truth). */
export const CLICK_COLUMNS = Object.keys(ClickEventSchema.shape) as (keyof ClickEvent)[]

export type KvLinkValue = {
  id: string
  t: string
  s: 'active' | 'paused' | 'archived'
  x: string | null
  f: string | null
  u: Record<string, string>
  a?: boolean
  v: number
}

export function kvKey(namespace: string, code: string): string {
  return `${namespace}/${code}`
}

export function domainKvKey(apex: string): string {
  return `__domain/${apex}`
}
