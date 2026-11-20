import { useState } from 'preact/hooks'
import { api, type Domain } from './api'
import { Bars, Card, ErrorBox, Top, go, useAsync } from './ui'

type Overview = {
  from: string
  to: string
  totals: { clicks: number; uniques: number; bots: number; not_found: number; requests: number }
  series: { day: string; clicks: number; uniques: number; bots: number; not_found: number; requests: number }[]
  outcomes: { outcome: string; n: number }[]
  top: { namespace: string; code: string; title: string | null; target_url: string | null; owner: string | null; clicks: number; uniques: number }[]
  breakdowns: Record<'country' | 'city' | 'device' | 'os' | 'browser' | 'referer', { key: string; n: number }[]>
}

const day = (offset: number) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10)

/** Fill missing days so the chart has a bar per day. */
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

export function Dashboard() {
  const [days, setDays] = useState(30)
  const [ns, setNs] = useState('')
  const [owner, setOwner] = useState('')
  const domains = useAsync(() => api<{ items: Domain[] }>('/domains').catch(() => ({ items: [] as Domain[] })), [])
  const qs = new URLSearchParams({ from: day(days - 1), to: day(0), top: '15' })
  if (ns) qs.set('namespace', ns)
  if (owner) qs.set('owner', owner)
  const o = useAsync(() => api<Overview>(`/stats/overview?${qs}`), [qs.toString()])
  const d = o.data
  const t = d?.totals
  return (
    <>
      <Card
        title="Dashboard"
        actions={
          <>
            <select value={ns} onChange={(e) => setNs(e.currentTarget.value)} aria-label="Domain">
              <option value="">All domains</option>
              {domains.data?.items.map((x) => <option key={x.id} value={x.apex}>{x.apex}</option>)}
            </select>
            <input placeholder="Owner (e.g. vrumvrum:…)" value={owner} onChange={(e) => setOwner(e.currentTarget.value)} style={{ width: '14rem' }} />
            <select value={days} onChange={(e) => setDays(Number(e.currentTarget.value))} aria-label="Range">
              <option value={1}>Today</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
            </select>
          </>
        }
      >
        <ErrorBox error={o.error} />
        <div class="stats">
          <div><strong>{t?.clicks ?? '–'}</strong><span>human clicks</span></div>
          <div><strong>{t?.uniques ?? '–'}</strong><span>unique visitors (per day)</span></div>
          <div><strong>{t?.bots ?? '–'}</strong><span>bots & link previews</span></div>
          <div><strong>{t?.not_found ?? '–'}</strong><span>unknown codes</span></div>
          <div><strong>{t?.requests ?? '–'}</strong><span>requests logged</span></div>
        </div>
        {d && <Bars data={fill(d.series, d.from, d.to)} />}
        <p class="muted small">Dark: human clicks · light: unique visitors. Every request is logged; bots are counted apart.</p>
      </Card>
      <Card title="Top links">
        <div class="tablewrap">
          <table>
            <thead><tr><th>Link</th><th>Target</th><th>Owner</th><th class="num">Clicks</th><th class="num">Uniques</th></tr></thead>
            <tbody>
              {d?.top.map((l) => (
                <tr key={l.namespace + l.code} class="click" onClick={() => go(`link/${l.namespace}/${l.code}`)}>
                  <td><code>{l.namespace}/{l.code}</code>{l.title && <div class="muted">{l.title}</div>}</td>
                  <td class="trunc">{l.target_url ?? '—'}</td>
                  <td class="muted">{l.owner ?? ''}</td>
                  <td class="num">{l.clicks}</td>
                  <td class="num">{l.uniques}</td>
                </tr>
              ))}
              {d && d.top.length === 0 && <tr><td colSpan={5} class="muted">No clicks in this range yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      {d && (
        <Card title="Audience">
          <div class="tops">
            <Top title="Countries" counts={asCounts(d.breakdowns.country)} />
            <Top title="Cities" counts={asCounts(d.breakdowns.city)} />
            <Top title="Devices" counts={asCounts(d.breakdowns.device)} />
            <Top title="OS" counts={asCounts(d.breakdowns.os)} />
            <Top title="Browsers" counts={asCounts(d.breakdowns.browser)} />
            <Top title="Referrers" counts={asCounts(d.breakdowns.referer)} />
            <Top title="Outcomes (all requests)" counts={Object.fromEntries(d.outcomes.map((x) => [x.outcome, x.n]))} />
          </div>
        </Card>
      )}
    </>
  )
}
