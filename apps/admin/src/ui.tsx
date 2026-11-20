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

export function Top({ title, counts }: { title: string; counts: Record<string, number> }) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8)
  const total = rows.reduce((n, [, v]) => n + v, 0) || 1
  return (
    <div class="top">
      <h3>{title}</h3>
      {rows.length === 0 && <p class="muted">—</p>}
      {rows.map(([k, v]) => (
        <div class="toprow" key={k}>
          <span>{k || 'unknown'}</span>
          <span class="num">{v}</span>
          <div class="meter" style={{ width: `${(v / total) * 100}%` }} />
        </div>
      ))}
    </div>
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
