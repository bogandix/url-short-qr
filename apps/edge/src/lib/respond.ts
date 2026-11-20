import { mergeUtm, type ClickOutcome, type KvLinkValue } from '@shortener/shared'
import { noStoreHeaders } from './log.js'

/** Always 302, never 301: a cached 301 would skip the Worker (no log, target frozen). */
export function redirectNoStore(url: string): Response {
  return new Response(null, { status: 302, headers: noStoreHeaders({ Location: url }) })
}

export type RespondOpts = {
  homeUrl?: string | null
  notFoundUrl?: string | null
  shortUrl?: string
  /** Browsers get a styled page; scripts and bots get plain text. */
  wantsHtml?: boolean
}

/** Plain text for scripts, a style-guide page for browsers. Never cached either way. */
function message(status: number, title: string, body: string, opts: RespondOpts): Response {
  if (!opts.wantsHtml) {
    return new Response(title, { status, headers: noStoreHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }) })
  }
  return new Response(page(title, `<h1>${esc(title)}</h1>${body}`), {
    status,
    headers: noStoreHeaders({ 'Content-Type': 'text/html; charset=utf-8' }),
  })
}

export function respondForOutcome(outcome: ClickOutcome, link: KvLinkValue | null, opts: RespondOpts = {}): Response {
  const code = opts.shortUrl ? `<p class="code">${esc(opts.shortUrl)}</p>` : ''
  switch (outcome) {
    case 'redirect':
      if (!link) return message(404, 'Not found', '<p>This short link does not exist.</p>', opts)
      return redirectNoStore(mergeUtm(link.t, link.u ?? {}, !!link.a))
    case 'home':
      return opts.homeUrl
        ? redirectNoStore(opts.homeUrl)
        : message(200, 'Short links', '<p>Scan a code or open a short link to continue.</p>', opts)
    case 'paused':
    case 'expired': {
      const fb = link?.f || opts.notFoundUrl
      if (fb) return redirectNoStore(fb)
      return outcome === 'paused'
        ? message(410, 'This link is paused', `${code}<p>The owner has paused it for now. Try again later.</p>`, opts)
        : message(410, 'This link has expired', `${code}<p>It is no longer active.</p>`, opts)
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
      return opts.notFoundUrl
        ? redirectNoStore(opts.notFoundUrl)
        : message(404, 'Link not found', `${code}<p>Check the code and try again. Letters O and I are read as 0 and 1.</p>`, opts)
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** Minimal page in the style guide: light page, Manrope, soft card, gradient bar. No logo artwork. */
function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#081226"><meta name="color-scheme" content="light">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&display=swap&subset=latin-ext" rel="stylesheet">
<style>
:root{color-scheme:light;--night:#081226;--ink:#0f172a;--body:#334155;--muted:#64748b;--line:#e2e8f0;--soft:#f4f6fb;--blue:#2563eb;
--gradient:linear-gradient(100deg,#3b82f6 0%,#6d4aef 55%,#9333ea 100%);--shadow-card:0 1px 2px rgb(15 23 42/.06),0 12px 32px -12px rgb(15 23 42/.18)}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;background:linear-gradient(180deg,#eff6ff 0%,#fff 40%,#faf5ff 100%);
font:400 16px/24px Manrope,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--body)}
.card{width:min(440px,100%);background:#fff;border-radius:16px;box-shadow:var(--shadow-card);padding:32px 24px;text-align:center}
.bar{width:64px;height:5px;border-radius:999px;background:var(--gradient);margin:0 auto 20px}
h1{margin:0 0 8px;color:var(--ink);font-size:22px;line-height:28px;font-weight:700;letter-spacing:-.02em}
p{margin:8px 0 0}
.code{display:inline-block;margin:4px 0 4px;padding:6px 12px;border-radius:12px;background:var(--soft);color:var(--ink);font-weight:800;letter-spacing:.03em}
.t{word-break:break-all;font-weight:700}
a{color:var(--blue)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:20px;padding:0 24px;border-radius:999px;
background:linear-gradient(90deg,#2563eb,#9333ea);color:#fff;font-weight:700;text-decoration:none;box-shadow:0 12px 22px -12px rgb(37 99 235/.55)}
.btn:active{transform:scale(.98)}
@media (prefers-reduced-motion:reduce){.btn:active{transform:none}}
</style></head>
<body><main class="card"><div class="bar"></div>${inner}</main></body></html>`
}

function previewHtml(link: KvLinkValue | null, shortUrl: string): string {
  const live = link && link.s === 'active' && !(link.x && Date.parse(link.x) < Date.now())
  const target = link ? mergeUtm(link.t, link.u ?? {}, !!link.a) : null
  const body = !link
    ? '<p>This short link does not exist.</p>'
    : live
      ? `<p>This link goes to:</p><p class="t">${esc(target!)}</p><a class="btn" href="${esc(target!)}" rel="nofollow noopener">Continue</a>`
      : '<p>This link is not active.</p>'
  return page('Link preview', `<h1>Link preview</h1><p class="code">${esc(shortUrl)}</p>${body}`)
}
