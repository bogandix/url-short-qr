import { readCode, resolveHost, shortUrl, type ClickOutcome, type DomainRow, type KvLinkValue } from '@shortener/shared'
import type { Env } from './env.js'
import { buildEvent } from './lib/event.js'
import { loadDomains } from './lib/domains.js'
import { lookupLink } from './lib/lookup.js'
import { noStoreHeaders, persistClick, strictLogging, unavailable } from './lib/log.js'
import { checkRateLimit } from './lib/ratelimit.js'
import { respondForOutcome } from './lib/respond.js'
import { parseQrOptions, QR_RENDER_VERSION, qrPng, qrSvg, shortPayload } from './lib/qr.js'
import { health } from './lib/health.js'

export type ApiHandler = (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response> | Response

const QR_RE = /^\/_\/qr\/([^/]+)\.(svg|png)$/i

export async function handleRequest(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  api: ApiHandler,
): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  // ── Not logged: QR images (an image is not an access) ──
  const qr = QR_RE.exec(path)
  if (qr) return qrResponse(url, qr[1]!, qr[2]!.toLowerCase() as 'svg' | 'png', ctx)

  let domains: DomainRow[]
  try {
    domains = await loadDomains(env)
  } catch (err) {
    console.error('domains-unavailable', String(err))
    domains = []
  }
  const res = resolveHost(url.hostname, domains)

  if (path === '/_/health') return health(env)

  // ── Not logged: admin API and admin UI, admin host only ──
  const isAdmin = res.kind === 'ok' && res.isAdminHost
  if (isAdmin && (path.startsWith('/_/api/') || path === '/_/admin' || path.startsWith('/_/admin/'))) {
    if (url.protocol === 'http:') {
      url.protocol = 'https:'
      return Response.redirect(url.toString(), 308)
    }
    if (path.startsWith('/_/api/')) return api(req, env, ctx)
    return adminAssets(req, env)
  }

  // ── Everything else is one logged event ──
  let outcome: ClickOutcome
  let code = ''
  let link: KvLinkValue | null = null

  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
  if (!(await checkRateLimit(env, ip))) {
    outcome = 'rate_limited'
    code = codeForLog(path)
  } else if (res.kind === 'invalid' || domains.length === 0) {
    outcome = 'invalid'
    code = codeForLog(path)
  } else if (path === '/' || path === '') {
    outcome = 'home'
  } else if (path.startsWith('/_/')) {
    outcome = 'invalid'
    code = codeForLog(path)
  } else {
    let seg = safeDecode(path.slice(1))
    const preview = seg.endsWith('+')
    if (preview) seg = seg.slice(0, -1)
    const parsed = readCode(seg)
    code = parsed ?? codeForLog(path)
    if (!parsed) outcome = 'not_found'
    else {
      try {
        link = await lookupLink(env, res.namespace, parsed)
      } catch (err) {
        console.error('kv-lookup-failed', String(err))
        link = null
      }
      outcome = preview ? 'preview' : linkOutcome(link)
    }
  }

  const namespace = res.namespace || url.hostname.toLowerCase()
  const ev = await buildEvent(req, env, {
    host: url.hostname.toLowerCase(),
    namespace,
    code,
    linkId: link?.id ?? null,
    outcome,
  })
  const stored = await persistClick(env, ev)
  if (!stored && strictLogging(env)) return unavailable()

  const domain = res.domain
  return respondForOutcome(outcome, link, {
    homeUrl: domain?.home_url,
    notFoundUrl: res.kind === 'ok' ? domain?.not_found_url : null,
    shortUrl: code ? shortUrl(url.hostname, code) : undefined,
    wantsHtml: req.method === 'GET' && (req.headers.get('accept') ?? '').includes('text/html'),
  })
}

export function linkOutcome(link: KvLinkValue | null, now = Date.now()): ClickOutcome {
  if (!link || link.s === 'archived') return 'not_found'
  if (link.s === 'paused') return 'paused'
  if (link.x && Date.parse(link.x) <= now) return 'expired'
  return 'redirect'
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Code column for rows that did not parse: the raw first segment, bounded. */
function codeForLog(path: string): string {
  return safeDecode(path.replace(/^\/+/, '')).slice(0, 64)
}

/**
 * QR images: public, immutable, and cached in Cloudflare's edge cache (Worker responses are
 * not cached automatically). The cache key is a canonical URL built from the parsed options,
 * so equivalent requests share one entry; QR_RENDER_VERSION in the key retires old renders.
 */
async function qrResponse(url: URL, rawCode: string, fmt: 'svg' | 'png', ctx: ExecutionContext): Promise<Response> {
  const code = readCode(safeDecode(rawCode))
  if (!code) return new Response('Bad code', { status: 400, headers: noStoreHeaders() })
  const host = url.hostname.toLowerCase()
  const opts = parseQrOptions(url.searchParams)
  const key = new Request(
    `https://${host}/_/qr/${code}.${fmt}?` +
      new URLSearchParams({ size: String(opts.size), ecc: opts.ecc, margin: String(opts.margin), fg: opts.fg.slice(1), bg: opts.bg.slice(1), r: QR_RENDER_VERSION }),
  )
  const cache = typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null
  const hit = await cache?.match(key).catch(() => undefined)
  if (hit) return hit

  const payload = shortPayload(host, code)
  const headers = {
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  }
  const res =
    fmt === 'svg'
      ? new Response(qrSvg(payload, opts), { headers: { ...headers, 'Content-Type': 'image/svg+xml; charset=utf-8' } })
      : new Response(await qrPng(payload, opts), { headers: { ...headers, 'Content-Type': 'image/png' } })
  if (cache) ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}))
  return res
}

async function adminAssets(req: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) return new Response('Admin UI not built', { status: 404 })
  const res = await env.ASSETS.fetch(req)
  if (res.status !== 404) {
    if (!new URL(req.url).pathname.startsWith('/_/admin/assets/')) return res
    const out = new Response(res.body, res) // hashed filenames: cache forever
    out.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    return out
  }
  // SPA fallback
  const url = new URL(req.url)
  url.pathname = '/_/admin/index.html'
  const index = await env.ASSETS.fetch(new Request(url.toString(), req))
  const out = new Response(index.body, index)
  out.headers.set('Cache-Control', 'no-cache')
  return out
}
