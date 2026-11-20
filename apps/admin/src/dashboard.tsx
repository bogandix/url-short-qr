import { useState } from 'preact/hooks'
import { api, type Domain } from './api'
import { Bars, ErrorBox, FeedItem, Top, countryName, flag, go, useAsync, type ClickRow } from './ui'

type Dim = 'country' | 'city' | 'device' | 'os' | 'browser' | 'referer' | 'language' | 'source'
type Overview = {
  from: string
  to: string
  totals: { clicks: number; uniques: number; bots: number; not_found: number; requests: number }
  series: { day: string; clicks: number; uniques: number; bots: number; not_found: number; requests: number }[]
  outcomes: { outcome: string; n: number }[]
  top: { namespace: string; code: string; title: string | null; target_url: string | null; owner: string | null; clicks: number; uniques: number }[]
  breakdowns: Record<Dim, { key: string; n: number }[]>
}

const day = (offset: number) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10)

/** One bar per day, including empty days. */
function fill(series: Overview['series'], from: string, to: string) {
  const by = new Map(series.map((s) => [s.day, s]))
  const out: { label: string; value: number; sub: number }[] = []
  for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 864e5)) {
    const k = d.toISOString().slice(0, 10)
    const s = by.get(k)
    out.push({ label: k, value: s?.clicks ?? 0, sub: s?.uniques ?? 0 })
  }
  return out
}

const asCounts = (rows: { key: string; n: number }[] = []) => Object.fromEntries(rows.map((r) => [r.key, r.n]))
const LANG = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' })
  } catch {
    return null
  }
})()

const TITLES: [Dim, string][] = [
  ['country', 'Countries'],
  ['city', 'Cities'],
  ['source', 'Sources'],
  ['referer', 'Referrers'],
  ['device', 'Devices'],
  ['os', 'Operating systems'],
  ['browser', 'Browsers'],
  ['language', 'Languages'],
]

export function Dashboard() {
  const [days, setDays] = useState(30)
  const [ns, setNs] = useState('')
  const [owner, setOwner] = useState('')
  const [humans, setHumans] = useState(true)
  const domains = useAsync(() => api<{ items: Domain[] }>('/domains').catch(() => ({ items: [] as Domain[] })), [])
  const qs = new URLSearchParams({ from: day(days - 1), to: day(0), top: '10' })
  if (ns) qs.set('namespace', ns)
  if (owner) qs.set('owner', owner)
  const o = useAsync(() => api<Overview>(`/stats/overview?${qs}`), [qs.toString()])
  const feedQs = new URLSearchParams(qs)
  feedQs.set('limit', '25')
  if (humans) feedQs.set('humans', '1')
  const feed = useAsync(() => api<{ items: ClickRow[] }>(`/stats/recent?${feedQs}`), [feedQs.toString()])
  const d = o.data
  const t = d?.totals
  return (
    <>
      <div class="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Every scan and click, counted once. Bots are kept apart.</p>
        </div>
        <div class="seg" role="group" aria-label="Range">
          {[1, 7, 30, 90].map((n) => (
            <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>{n === 1 ? 'Today' : `${n}d`}</button>
          ))}
        </div>
      </div>
      <div class="filters" style={{ marginBottom: 0 }}>
        <select value={ns} onChange={(e) => setNs(e.currentTarget.value)} aria-label="Domain">
          <option value="">All domains</option>
          {domains.data?.items.map((x) => <option key={x.id} value={x.apex}>{x.apex}</option>)}
        </select>
        <input placeholder="Owner, e.g. vrumvrum:garage:42" value={owner} onChange={(e) => setOwner(e.currentTarget.value)} aria-label="Owner" />
      </div>
      <ErrorBox error={o.error} />
      <div class="stats summary">
        <div class="stat hero"><strong>{t?.clicks ?? '–'}</strong><span>scans & clicks by people</span></div>
        <div class="stat"><strong>{t?.uniques ?? '–'}</strong><span>unique visitors (per day)</span></div>
        <div class="stat"><strong>{t?.bots ?? '–'}</strong><span>bots & link previews</span></div>
        <div class="stat"><strong>{t?.not_found ?? '–'}</strong><span>unknown codes</span></div>
        <div class="stat"><strong>{t?.requests ?? '–'}</strong><span>requests logged</span></div>
      </div>
      <section class="card">
        <header><h2>Per day</h2><div class="legend"><span><i />Scans & clicks</span><span><i class="sub" />Unique visitors</span></div></header>
        {d && <Bars data={fill(d.series, d.from, d.to)} />}
      </section>
      <section class="card">
        <header><h2>Top links</h2><a class="btn small" href="#/links">All links</a></header>
        <table class="list">
          <thead><tr><th>Link</th><th>Goes to</th><th>Owner</th><th class="num">Scans</th><th class="num">Uniques</th></tr></thead>
          <tbody>
            {d?.top.map((l) => (
              <tr key={l.namespace + l.code} class="click" onClick={() => go(`link/${l.namespace}/${l.code}`)}>
                <td class="primary-cell" data-label="Link"><code>{l.namespace.toUpperCase()}/{l.code}</code>{l.title && <div class="muted small trunc">{l.title}</div>}</td>
                <td class="trunc wide" data-label="To">{l.target_url ?? '—'}</td>
                <td class="muted hide-sm">{l.owner ?? ''}</td>
                <td class="num metric status-cell"><b>{l.clicks}</b></td>
                <td class="num metric" data-label="Uniques">{l.uniques}</td>
              </tr>
            ))}
            {d && d.top.length === 0 && <tr><td colSpan={5} class="muted">No scans in this range yet.</td></tr>}
          </tbody>
        </table>
      </section>
      {d && (
        <section class="card">
          <header><h2>Audience</h2></header>
          <div class="tops">
            {TITLES.map(([k, title]) => (
              <Top
                key={k}
                title={title}
                counts={asCounts(d.breakdowns[k])}
                label={
                  k === 'country'
                    ? (c) => `${flag(c)} ${countryName(c)}`
                    : k === 'language'
                      ? (c) => {
                          try {
                            return LANG?.of(c) ?? c
                          } catch {
                            return c
                          }
                        }
                      : undefined
                }
              />
            ))}
            <Top title="All requests by outcome" counts={Object.fromEntries(d.outcomes.map((x) => [x.outcome, x.n]))} />
          </div>
        </section>
      )}
      <section class="card">
        <header>
          <h2>Live</h2>
          <div class="row">
            <label class="check"><input type="checkbox" checked={humans} onChange={(e) => setHumans(e.currentTarget.checked)} /> People only</label>
            <button class="small" onClick={() => feed.reload()}>Refresh</button>
          </div>
        </header>
        <ErrorBox error={feed.error} />
        <ul class="feed">
          {feed.data?.items.map((c, i) => <FeedItem key={`${c.ts}-${i}`} c={c} />)}
          {feed.data && feed.data.items.length === 0 && <li class="muted">Nothing yet.</li>}
        </ul>
        <p class="muted small">Tap a row for everything recorded: location, network, device, language, source and campaign.</p>
      </section>
    </>
  )
}
