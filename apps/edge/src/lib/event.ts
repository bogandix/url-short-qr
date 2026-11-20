import { detectBot, ipHash, visitorHash, utcDay, type ClickEvent, type ClickOutcome } from '@shortener/shared'
import { parseUa } from './ua.js'
import type { Env } from '../env.js'

type Cf = Record<string, unknown> | undefined

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const round2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100)
/** Client-hint values arrive quoted: "macOS" → macOS. */
const unquote = (v: string | null) => (v ? v.replace(/^"|"$/g, '') : null)

/** Referrer host only (never the full path) for grouping; "direct" is left to queries. */
export function refererHost(referer: string | null): string | null {
  if (!referer) return null
  try {
    return new URL(referer).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/** First language tag of Accept-Language, lowercase base language: "ro-RO,ro;q=0.9" → "ro". */
export function primaryLang(accept: string | null): string | null {
  const first = accept?.split(',')[0]?.split(';')[0]?.trim()
  if (!first || first === '*') return null
  return first.split('-')[0]!.toLowerCase().slice(0, 8)
}

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
  const h = req.headers
  const ua = h.get('user-agent')
  const lang = h.get('accept-language')
  const referer = h.get('referer')
  const ip = h.get('cf-connecting-ip') || h.get('x-forwarded-for')?.split(',')[0]?.trim() || '0.0.0.0'
  const day = utcDay()
  const bot = detectBot(req.method, ua)
  const chMobile = h.get('sec-ch-ua-mobile')
  const hints = {
    platform: unquote(h.get('sec-ch-ua-platform')),
    mobile: chMobile == null ? null : chMobile === '?1',
    model: unquote(h.get('sec-ch-ua-model')),
  }
  const parsed = parseUa(ua, hints)
  const cf = req.cf as Cf
  const q = url.searchParams
  const salt = env.SECRET_SALT || 'dev-salt'

  return {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    host: opts.host,
    namespace: opts.namespace,
    code: opts.code,
    link_id: opts.linkId,
    outcome: opts.outcome,
    method: req.method,
    path: url.pathname.slice(0, 2048),
    query: url.search ? url.search.slice(1, 2048) : null,
    scheme: url.protocol === 'http:' ? 'http' : 'https',
    country: str(cf?.country, 2),
    region: str(cf?.region),
    region_code: str(cf?.regionCode),
    city: str(cf?.city),
    timezone: str(cf?.timezone),
    colo: str(cf?.colo),
    continent: str(cf?.continent, 2),
    postal_code: str(cf?.postalCode, 20),
    metro_code: str(cf?.metroCode, 10),
    latitude: round2(num(cf?.latitude)),
    longitude: round2(num(cf?.longitude)),
    is_eu: cf?.isEUCountry === '1' ? true : cf ? false : null,
    asn: num(cf?.asn),
    as_org: str(cf?.asOrganization),
    http_protocol: str(cf?.httpProtocol, 20),
    tls_version: str(cf?.tlsVersion, 20),
    client_rtt_ms: num(cf?.clientTcpRtt),
    ua: ua ? ua.slice(0, 1024) : null,
    device: parsed.device,
    device_vendor: parsed.device_vendor,
    device_model: parsed.device_model,
    os: parsed.os,
    browser: parsed.browser,
    browser_version: parsed.browser_version,
    browser_major: parsed.browser_major,
    engine: parsed.engine,
    cpu_arch: parsed.cpu_arch,
    ch_platform: hints.platform,
    ch_mobile: hints.mobile,
    ch_model: hints.model,
    lang: lang ? lang.slice(0, 200) : null,
    lang_primary: primaryLang(lang),
    dnt: h.get('dnt') === '1' || h.get('sec-gpc') === '1' ? true : null,
    referer: referer ? referer.slice(0, 2048) : null,
    referer_host: refererHost(referer),
    utm_source: str(q.get('utm_source')),
    utm_medium: str(q.get('utm_medium')),
    utm_campaign: str(q.get('utm_campaign')),
    utm_term: str(q.get('utm_term')),
    utm_content: str(q.get('utm_content')),
    ip_hash: await ipHash(salt, day, ip),
    visitor_hash: await visitorHash(salt, day, ip, ua ?? '', lang ?? ''),
    is_bot: bot.isBot,
    bot_name: bot.botName,
    ray_id: h.get('cf-ray'),
    source: opts.source ?? 'live',
  }
}
