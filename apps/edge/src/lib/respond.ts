import { mergeUtm, type ClickOutcome, type KvLinkValue } from '@shortener/shared'
import { noStoreHeaders } from './log.js'

/** Always 302, never 301: a cached 301 would skip the Worker (no log, target frozen). */
export function redirectNoStore(url: string): Response {
  return new Response(null, { status: 302, headers: noStoreHeaders({ Location: url }) })
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: noStoreHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }) })
}

export type RespondOpts = {
  homeUrl?: string | null
  notFoundUrl?: string | null
  shortUrl?: string
}

export function respondForOutcome(outcome: ClickOutcome, link: KvLinkValue | null, opts: RespondOpts = {}): Response {
  switch (outcome) {
    case 'redirect':
      if (!link) return text('Not found', 404)
      return redirectNoStore(mergeUtm(link.t, link.u ?? {}, !!link.a))
    case 'home':
      return opts.homeUrl ? redirectNoStore(opts.homeUrl) : text('OK', 200)
    case 'paused':
    case 'expired': {
      const fb = link?.f || opts.notFoundUrl
      return fb ? redirectNoStore(fb) : text(outcome === 'paused' ? 'This link is paused' : 'This link has expired', 410)
    }
    case 'preview':
      return new Response(previewHtml(link, opts.shortUrl ?? ''), {
        status: link ? 200 : 404,
        headers: noStoreHeaders({ 'Content-Type': 'text/html; charset=utf-8' }),
      })
    case 'rate_limited':
      return new Response('Too Many Requests', { status: 429, headers: noStoreHeaders({ 'Retry-After': '60' }) })
    case 'not_found':
    case 'invalid':
    default:
      return opts.notFoundUrl ? redirectNoStore(opts.notFoundUrl) : text('Not found', 404)
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function previewHtml(link: KvLinkValue | null, shortUrl: string): string {
  const live = link && link.s === 'active' && !(link.x && Date.parse(link.x) < Date.now())
  const target = link ? mergeUtm(link.t, link.u ?? {}, !!link.a) : null
  const body = !link
    ? '<p>This short link does not exist.</p>'
    : live
      ? `<p>This link goes to:</p><p class="t"><a href="${esc(target!)}" rel="nofollow noopener">${esc(target!)}</a></p>`
      : '<p>This link is not active.</p>'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Link preview</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#111;background:#fff}
.t{word-break:break-all;font-weight:600}code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}code{background:#222}a{color:#8ab4ff}}</style></head>
<body><h1>Link preview</h1><p><code>${esc(shortUrl)}</code></p>${body}</body></html>`
}
