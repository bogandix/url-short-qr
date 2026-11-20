import {
  detectBot,
  ipHash,
  visitorHash,
  utcDay,
  type ClickEvent,
  type ClickOutcome,
} from '@shortener/shared'
import { parseUa } from './ua.js'
import type { Env } from '../env.js'

type CfLike = IncomingRequestCfProperties | undefined

export async function buildEvent(
  req: Request,
  env: Env,
  opts: {
    host: string
    namespace: string
    code: string
    linkId: string | null
    outcome: ClickOutcome
    source?: 'live' | 'replay'
  },
): Promise<ClickEvent> {
  const url = new URL(req.url)
  const ua = req.headers.get('user-agent')
  const lang = req.headers.get('accept-language')
  const referer = req.headers.get('referer')
  const ip =
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  const day = utcDay()
  const bot = detectBot(req.method, ua)
  const parsed = parseUa(ua)
  const cf = req.cf as CfLike

  return {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    host: opts.host,
    namespace: opts.namespace,
    code: opts.code,
    link_id: opts.linkId,
    outcome: opts.outcome,
    method: req.method,
    path: url.pathname,
    query: url.search ? url.search.slice(1) : null,
    scheme: url.protocol === 'http:' ? 'http' : 'https',
    country: (cf?.country as string) ?? null,
    region: (cf?.region as string) ?? null,
    region_code: (cf?.regionCode as string) ?? null,
    city: (cf?.city as string) ?? null,
    timezone: (cf?.timezone as string) ?? null,
    colo: (cf?.colo as string) ?? null,
    asn: typeof cf?.asn === 'number' ? cf.asn : null,
    as_org: (cf?.asOrganization as string) ?? null,
    ua,
    device: parsed.device,
    os: parsed.os,
    browser: parsed.browser,
    browser_version: parsed.browser_version,
    lang,
    referer,
    ip_hash: await ipHash(env.SECRET_SALT || 'dev-salt', day, ip),
    visitor_hash: await visitorHash(env.SECRET_SALT || 'dev-salt', day, ip, ua ?? '', lang ?? ''),
    is_bot: bot.isBot,
    bot_name: bot.botName,
    ray_id: req.headers.get('cf-ray'),
    source: opts.source ?? 'live',
  }
}
