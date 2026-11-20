import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'

export function useRoute(): string[] {
  const read = () => (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/').map(decodeURIComponent)
  const [r, setR] = useState(read)
  useEffect(() => {
    const f = () => setR(read())
    addEventListener('hashchange', f)
    return () => removeEventListener('hashchange', f)
  }, [])
  return r
}

export function go(path: string) {
  location.hash = `#/${path}`
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; error?: Error; loading: boolean; reload: () => void } {
  const [state, set] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true })
  const [n, setN] = useState(0)
  useEffect(() => {
    let live = true
    set((s) => ({ ...s, loading: true }))
    fn().then(
      (data) => live && set({ data, loading: false }),
      (error: Error) => live && set({ error, loading: false }),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n])
  return { ...state, reload: () => setN((x) => x + 1) }
}

export function Status({ s }: { s: string }) {
  return <span class={`badge b-${s}`}>{s.replace('_', ' ')}</span>
}

export function ErrorBox({ error }: { error?: Error }) {
  return error ? <p class="error" role="alert">{error.message}</p> : null
}

export function Card({ title, children, actions }: { title?: string; children: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <section class="card">
      {(title || actions) && (
        <header>
          {title && <h2>{title}</h2>}
          <div class="row">{actions}</div>
        </header>
      )}
      {children}
    </section>
  )
}

/** Small dependency-free bar chart for daily counts. */
export function Bars({ data }: { data: { label: string; value: number; sub?: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.value))
  if (data.length === 0) return <p class="muted">No data in this range.</p>
  return (
    <div class="bars" role="img" aria-label="Clicks per day">
      {data.map((d) => (
        <div class="bar" key={d.label} title={`${d.label}: ${d.value}${d.sub != null ? ` (${d.sub} unique)` : ''}`}>
          <div class="fill" style={{ height: `${(d.value / max) * 100}%` }}>
            {d.sub != null && <div class="sub" style={{ height: `${d.value ? (d.sub / d.value) * 100 : 0}%` }} />}
          </div>
          <span>{d.label.slice(5)}</span>
        </div>
      ))}
    </div>
  )
}

export function Top({ title, counts, label }: { title: string; counts: Record<string, number>; label?: (k: string) => string }) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8)
  const total = rows.reduce((n, [, v]) => n + v, 0) || 1
  return (
    <div class="top">
      <h3>{title}</h3>
      {rows.length === 0 && <p class="muted small">No data yet</p>}
      {rows.map(([k, v]) => (
        <div class="toprow" key={k}>
          <span>{label ? label(k) : k || 'unknown'}</span>
          <span class="num">{v}</span>
          <div class="meter" style={{ width: `${(v / total) * 100}%` }} />
        </div>
      ))}
    </div>
  )
}

// ───────────── small helpers ─────────────

const ICONS: Record<string, string> = {
  dashboard: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z',
  links: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  plus: 'M12 5v14M5 12h14',
  qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM18 18h3v3h-3zM14 20h2M20 14v2',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  key: 'M15 7a4 4 0 1 1-3.9 4.9L3 20v-3h3v-3h3l2.1-2.1A4 4 0 0 1 15 7zM16 8h.01',
  pulse: 'M3 12h4l3 8 4-16 3 8h4',
  out: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
}

export function Icon({ name }: { name: keyof typeof ICONS | string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={ICONS[name] ?? ''} />
    </svg>
  )
}

/** Country flag emoji from an ISO code ("RO" → 🇷🇴); "" for unknown/T1 (Tor). */
export function flag(cc?: string | null): string {
  if (!cc || !/^[A-Z]{2}$/.test(cc) || cc === 'XX' || cc === 'T1') return ''
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' })
  } catch {
    return null
  }
})()
export function countryName(cc?: string | null): string {
  if (!cc) return 'Unknown'
  try {
    return regionNames?.of(cc) ?? cc
  } catch {
    return cc
  }
}

export function ago(ts: string | Date): string {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export const OUTCOME_LABEL: Record<string, string> = {
  redirect: 'Opened',
  not_found: 'Unknown code',
  paused: 'Paused link',
  expired: 'Expired link',
  preview: 'Preview',
  rate_limited: 'Rate limited',
  home: 'Home page',
  invalid: 'Invalid',
}

/** One click/scan with an expandable full detail view. */
export type ClickRow = Record<string, unknown> & { ts: string; outcome: string; code?: string; namespace?: string }

export function FeedItem({ c, showLink = true }: { c: ClickRow; showLink?: boolean }) {
  const s = (k: string) => (c[k] == null || c[k] === '' ? null : String(c[k]))
  const where = [s('city'), s('region') !== s('city') ? s('region') : null, countryName(s('country'))].filter(Boolean).join(', ')
  const dev = [s('device_vendor'), s('device_model') ?? s('device'), s('os'), s('browser') && `${s('browser')}${s('browser_major') ? ' ' + s('browser_major') : ''}`]
    .filter(Boolean)
    .join(' · ')
  const src = s('utm_source') ?? s('referer_host') ?? 'direct'
  const rows: [string, string | null][] = [
    ['Time', new Date(c.ts).toLocaleString()],
    ['Outcome', OUTCOME_LABEL[c.outcome] ?? c.outcome],
    ['Location', where || null],
    ['Postal code', s('postal_code')],
    ['Coordinates', s('latitude') && s('longitude') ? `${s('latitude')}, ${s('longitude')} (approx.)` : null],
    ['Timezone', s('timezone')],
    ['Network', [s('as_org'), s('asn') && `AS${s('asn')}`].filter(Boolean).join(' · ') || null],
    ['Connection', [s('http_protocol'), s('tls_version'), s('client_rtt_ms') && `${s('client_rtt_ms')} ms RTT`, s('colo') && `edge ${s('colo')}`].filter(Boolean).join(' · ') || null],
    ['Device', dev || null],
    ['Engine / CPU', [s('engine'), s('cpu_arch')].filter(Boolean).join(' · ') || null],
    ['Language', s('lang')],
    ['Source', src],
    ['Referrer', s('referer')],
    ['Campaign', [s('utm_medium'), s('utm_campaign'), s('utm_term'), s('utm_content')].filter(Boolean).join(' · ') || null],
    ['Bot', c.is_bot ? s('bot_name') ?? 'yes' : null],
    ['Privacy signal', c.dnt ? 'Do Not Track / GPC' : null],
    ['Request', [s('method'), s('scheme'), s('path')].filter(Boolean).join(' ') || null],
  ]
  return (
    <li>
      <span class="dot" aria-hidden="true">{flag(s('country')) || (c.is_bot ? '🤖' : '🌐')}</span>
      <span class="what">
        {showLink && c.code ? <code>{String(c.code) || '/'}</code> : null} {OUTCOME_LABEL[c.outcome] ?? c.outcome}
        {c.is_bot ? <span class="tag bot">bot</span> : null}
      </span>
      <span class="when">{ago(c.ts)}</span>
      <details class="detail click-detail">
        <summary>{[where, dev, src].filter(Boolean).join(' · ') || '—'}</summary>
        <dl class="kv">
          {rows.filter(([, v]) => v).map(([k, v]) => (
            <>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </>
          ))}
        </dl>
      </details>
    </li>
  )
}

/** Matches QR_RENDER_VERSION in the Worker; changing it makes browsers fetch fresh QR images. */
export const QR_VERSION = '2'

/** Add/replace query parameters on an absolute URL (keeps any existing ones, e.g. v=2). */
export function withQuery(url: string, params: Record<string, string | number>): string {
  const u = new URL(url, location.origin)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v))
  if (!u.searchParams.has('v')) u.searchParams.set('v', QR_VERSION)
  return u.toString()
}
