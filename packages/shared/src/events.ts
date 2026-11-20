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
  country: z.string().nullable(),
  region: z.string().nullable(),
  region_code: z.string().nullable(),
  city: z.string().nullable(),
  timezone: z.string().nullable(),
  colo: z.string().nullable(),
  asn: z.number().nullable(),
  as_org: z.string().nullable(),
  ua: z.string().nullable(),
  device: z.string().nullable(),
  os: z.string().nullable(),
  browser: z.string().nullable(),
  browser_version: z.string().nullable(),
  lang: z.string().nullable(),
  referer: z.string().nullable(),
  ip_hash: z.string(),
  visitor_hash: z.string(),
  is_bot: z.boolean(),
  bot_name: z.string().nullable(),
  ray_id: z.string().nullable(),
  source: z.enum(['live', 'replay']),
})

export type ClickEvent = z.infer<typeof ClickEventSchema>

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
