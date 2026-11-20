import { useState } from 'preact/hooks'
import { api, authConfig, sendOtp, setSession, verifyOtp, type Domain, type Link } from './api'
import { Bars, Card, ErrorBox, Status, Top, go, useAsync } from './ui'

// ───────────── Login ─────────────
export function Login() {
  const cfg = useAsync(authConfig, [])
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [key, setKey] = useState('')
  const [err, setErr] = useState<Error>()
  const [busy, setBusy] = useState(false)
  const run = (f: () => Promise<void>) => async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setErr(undefined)
    try {
      await f()
    } catch (x) {
      setErr(x as Error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <main class="login">
      <h1>Shortener</h1>
      {cfg.data?.provider === 'supabase' && (
        <Card title="Sign in with email">
          {!sent ? (
            <form onSubmit={run(async () => (await sendOtp(email), setSent(true)))}>
              <label>Email<input type="email" required value={email} onInput={(e) => setEmail(e.currentTarget.value)} autoFocus /></label>
              <button disabled={busy}>Send code</button>
            </form>
          ) : (
            <form onSubmit={run(() => verifyOtp(email, code.trim()))}>
              <label>Code from the email<input inputMode="numeric" required value={code} onInput={(e) => setCode(e.currentTarget.value)} autoFocus /></label>
              <div class="row">
                <button disabled={busy}>Sign in</button>
                <button type="button" class="ghost" onClick={() => setSent(false)}>Back</button>
              </div>
            </form>
          )}
        </Card>
      )}
      <Card title="Or use an API key">
        <form onSubmit={run(async () => {
          setSession({ kind: 'key', token: key.trim() })
          await api('/links?limit=1')
        })}>
          <label>API key<input type="password" autoComplete="off" placeholder="sk_live_…" value={key} onInput={(e) => setKey(e.currentTarget.value)} /></label>
          <button class="ghost" disabled={busy || !key}>Use key</button>
        </form>
      </Card>
      <ErrorBox error={err ?? cfg.error} />
    </main>
  )
}

// ───────────── Links ─────────────
export function Links() {
  const [f, setF] = useState({ namespace: '', status: '', tag: '', owner: '', q: '' })
  const [cursor, setCursor] = useState<string[]>([])
  const domains = useAsync(() => api<{ items: Domain[] }>('/domains').catch(() => ({ items: [] as Domain[] })), [])
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v))
  if (cursor.length) qs.set('cursor', cursor[cursor.length - 1]!)
  const list = useAsync(() => api<{ items: Link[]; next_cursor: string | null }>(`/links?${qs}`), [qs.toString()])
  const set = (k: keyof typeof f) => (e: Event) => {
    setCursor([])
    setF({ ...f, [k]: (e.currentTarget as HTMLInputElement).value })
  }
  return (
    <Card title="Links" actions={<button onClick={() => go('new')}>New link</button>}>
      <div class="filters">
        <select value={f.namespace} onChange={set('namespace')} aria-label="Namespace">
          <option value="">All domains</option>
          {domains.data?.items.map((d) => <option key={d.id} value={d.apex}>{d.apex}</option>)}
        </select>
        <select value={f.status} onChange={set('status')} aria-label="Status">
          <option value="">Active + paused</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
        </select>
        <input placeholder="Namespace (e.g. acme.short.example)" value={f.namespace} onChange={set('namespace')} />
        <input placeholder="Tag" value={f.tag} onChange={set('tag')} />
        <input placeholder="Owner" value={f.owner} onChange={set('owner')} />
        <input placeholder="Search code, title, URL" value={f.q} onChange={set('q')} />
      </div>
      <ErrorBox error={list.error} />
      <div class="tablewrap">
        <table>
          <thead><tr><th>Short link</th><th>Target</th><th>Tags</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>
            {list.data?.items.map((l) => (
              <tr key={l.id} onClick={() => go(`link/${l.namespace}/${l.code}`)} class="click">
                <td><code>{l.namespace}/{l.code}</code>{l.title && <div class="muted">{l.title}</div>}</td>
                <td class="trunc">{l.target_url}</td>
                <td>{l.tags.map((t) => <span class="tag" key={t}>{t}</span>)}</td>
                <td><Status s={l.status} /></td>
                <td class="muted">{new Date(l.updated_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 && <tr><td colSpan={5} class="muted">No links.</td></tr>}
          </tbody>
        </table>
      </div>
      <div class="row pager">
        <button class="ghost" disabled={!cursor.length} onClick={() => setCursor(cursor.slice(0, -1))}>Previous</button>
        <button class="ghost" disabled={!list.data?.next_cursor} onClick={() => setCursor([...cursor, list.data!.next_cursor!])}>Next</button>
      </div>
    </Card>
  )
}

// ───────────── New link ─────────────
export function NewLink() {
  const domains = useAsync(() => api<{ items: Domain[] }>('/domains'), [])
  const [v, setV] = useState({ namespace: '', target_url: '', code: '', title: '', tags: '', owner: '', expires_at: '', fallback_url: '' })
  const [created, setCreated] = useState<Link>()
  const [err, setErr] = useState<Error>()
  const set = (k: keyof typeof v) => (e: Event) => setV({ ...v, [k]: (e.currentTarget as HTMLInputElement).value })
  const ns = v.namespace || domains.data?.items.find((d) => d.status !== 'disabled')?.apex || ''
  const submit = async (e: Event) => {
    e.preventDefault()
    setErr(undefined)
    try {
      const body: Record<string, unknown> = { namespace: ns, target_url: v.target_url }
      if (v.code) body.code = v.code
      if (v.title) body.title = v.title
      if (v.owner) body.owner = v.owner
      if (v.fallback_url) body.fallback_url = v.fallback_url
      if (v.tags) body.tags = v.tags.split(',').map((s) => s.trim()).filter(Boolean)
      if (v.expires_at) body.expires_at = new Date(v.expires_at).toISOString()
      setCreated(await api<Link>('/links', { method: 'POST', json: body }))
    } catch (x) {
      setErr(x as Error)
    }
  }
  if (created) return <Created link={created} />
  return (
    <Card title="New link">
      <form onSubmit={submit} class="grid2">
        <label>Namespace
          <input list="ns" required value={ns} onInput={set('namespace')} />
          <datalist id="ns">{domains.data?.items.map((d) => <option key={d.id} value={d.apex} />)}</datalist>
        </label>
        <label>Target URL<input type="url" required placeholder="https://…" value={v.target_url} onInput={set('target_url')} /></label>
        <label>Code (optional)<input placeholder="random" value={v.code} onInput={set('code')} pattern="[0-9A-Za-z\-]{2,32}" /></label>
        <label>Title<input value={v.title} onInput={set('title')} /></label>
        <label>Tags (comma-separated)<input value={v.tags} onInput={set('tags')} /></label>
        <label>Owner<input placeholder="tenant:42" value={v.owner} onInput={set('owner')} /></label>
        <label>Expires<input type="datetime-local" value={v.expires_at} onInput={set('expires_at')} /></label>
        <label>Fallback URL<input type="url" value={v.fallback_url} onInput={set('fallback_url')} /></label>
        <div class="row span2"><button>Create</button><button type="button" class="ghost" onClick={() => go('links')}>Cancel</button></div>
      </form>
      <ErrorBox error={err ?? domains.error} />
    </Card>
  )
}

function QrBlock({ link }: { link: Link }) {
  // QR images are served on the link's own host; on the admin host they are fetched cross-origin.
  return (
    <div class="qr">
      <img src={`${link.qr.svg}?size=256`} width={192} height={192} alt={`QR code for ${link.short_url}`} />
      <div class="row">
        <a class="button ghost" href={`${link.qr.svg}?size=1024`} download={`${link.code}.svg`}>SVG</a>
        <a class="button ghost" href={`${link.qr.png}?size=1024`} download={`${link.code}.png`}>PNG</a>
      </div>
      <code class="muted small">{link.qr.payload}</code>
    </div>
  )
}

function Created({ link }: { link: Link }) {
  return (
    <Card title="Link created">
      <div class="split">
        <div>
          <p class="big"><a href={link.short_url} target="_blank" rel="noreferrer">{link.short_url}</a></p>
          <p class="muted trunc">→ {link.target_url}</p>
          <div class="row">
            <button onClick={() => navigator.clipboard.writeText(link.short_url)}>Copy</button>
            <button class="ghost" onClick={() => go(`link/${link.namespace}/${link.code}`)}>Details</button>
            <button class="ghost" onClick={() => location.reload()}>Another</button>
          </div>
        </div>
        <QrBlock link={link} />
      </div>
    </Card>
  )
}

// ───────────── Link detail ─────────────
type Daily = { day: string; outcome: string; clicks: number; uniques: number; bots: number; by_country: Record<string, number>; by_city: Record<string, number>; by_device: Record<string, number>; by_os: Record<string, number> }
type Live = { bucket: string; outcome: string; clicks: number; uniques: number; bots: number }
type Audit = { ts: string; actor: string; action: string }

export function LinkDetail({ ns, code }: { ns: string; code: string }) {
  const path = `/links/${encodeURIComponent(ns)}/${encodeURIComponent(code)}`
  const link = useAsync(() => api<Link & { audit: Audit[] }>(path), [path])
  const [days, setDays] = useState(30)
  const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const stats = useAsync(() => api<{ daily: Daily[]; live: Live[] }>(`${path}/stats?from=${from}`), [path, from])
  const [err, setErr] = useState<Error>()

  const act = async (json: unknown, method = 'PATCH') => {
    setErr(undefined)
    try {
      await api(path, { method, json })
      link.reload()
    } catch (x) {
      setErr(x as Error)
    }
  }

  const byDay = new Map<string, { value: number; sub: number; bots: number }>()
  const agg = { country: {} as Record<string, number>, city: {} as Record<string, number>, device: {} as Record<string, number>, os: {} as Record<string, number> }
  let total = 0, uniques = 0, bots = 0
  for (const d of stats.data?.daily ?? []) {
    if (d.outcome !== 'redirect') continue
    const e = byDay.get(d.day) ?? { value: 0, sub: 0, bots: 0 }
    e.value += d.clicks - d.bots
    e.sub += d.uniques
    e.bots += d.bots
    byDay.set(d.day, e)
    for (const [k, src] of [['country', d.by_country], ['city', d.by_city], ['device', d.by_device], ['os', d.by_os]] as const)
      for (const [kk, n] of Object.entries(src)) agg[k][kk] = (agg[k][kk] ?? 0) + n
  }
  for (const l of stats.data?.live ?? []) {
    if (l.outcome !== 'redirect') continue
    const day = l.bucket.slice(0, 10)
    const e = byDay.get(day) ?? { value: 0, sub: 0, bots: 0 }
    e.value += l.clicks - l.bots
    e.sub += l.uniques
    e.bots += l.bots
    byDay.set(day, e)
  }
  for (const e of byDay.values()) (total += e.value), (uniques += e.sub), (bots += e.bots)
  const series = [...byDay.entries()].sort().map(([label, e]) => ({ label, value: e.value, sub: e.sub }))
  const l = link.data

  return (
    <>
      <ErrorBox error={link.error ?? err} />
      {l && (
        <Card
          title={`${l.namespace}/${l.code}`}
          actions={
            <>
              <Status s={l.status} />
              {l.status === 'active' && <button class="ghost" onClick={() => act({ status: 'paused' })}>Pause</button>}
              {l.status === 'paused' && <button class="ghost" onClick={() => act({ status: 'active' })}>Resume</button>}
              {l.status !== 'archived' && (
                <button class="danger" onClick={() => confirmArchive(l) && act(undefined, 'DELETE')}>Archive</button>
              )}
            </>
          }
        >
          <div class="split">
            <dl class="kv">
              <dt>Short URL</dt><dd><a href={l.short_url} target="_blank" rel="noreferrer">{l.short_url}</a></dd>
              <dt>Target</dt><dd class="trunc">{l.target_url}</dd>
              {l.title && <><dt>Title</dt><dd>{l.title}</dd></>}
              {l.owner && <><dt>Owner</dt><dd>{l.owner}</dd></>}
              {l.tags.length > 0 && <><dt>Tags</dt><dd>{l.tags.map((t) => <span class="tag" key={t}>{t}</span>)}</dd></>}
              {l.expires_at && <><dt>Expires</dt><dd>{new Date(l.expires_at).toLocaleString()}</dd></>}
              <dt>Version</dt><dd>{l.version}</dd>
            </dl>
            <QrBlock link={l} />
          </div>
        </Card>
      )}
      <Card
        title="Clicks"
        actions={
          <select value={days} onChange={(e) => setDays(Number(e.currentTarget.value))} aria-label="Range">
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={365}>1 year</option>
          </select>
        }
      >
        <div class="stats">
          <div><strong>{total}</strong><span>human clicks</span></div>
          <div><strong>{uniques}</strong><span>unique visitors (daily)</span></div>
          <div><strong>{bots}</strong><span>bots & previews</span></div>
        </div>
        <ErrorBox error={stats.error} />
        <Bars data={series} />
        <div class="tops">
          <Top title="Countries" counts={agg.country} />
          <Top title="Cities" counts={agg.city} />
          <Top title="Devices" counts={agg.device} />
          <Top title="OS" counts={agg.os} />
        </div>
        <p class="muted small">Breakdowns cover rolled-up days (until yesterday) and count humans only.</p>
      </Card>
      {l && (
        <Card title="History">
          <ul class="audit">
            {l.audit.map((a, i) => (
              <li key={i}><span class="muted">{new Date(a.ts).toLocaleString()}</span> <b>{a.action}</b> by {a.actor}</li>
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}

function confirmArchive(l: Link): boolean {
  return window.confirm(`Archive ${l.namespace}/${l.code}? It stops redirecting and the code is never reused.`)
}

// ───────────── Domains ─────────────
export function Domains() {
  const list = useAsync(() => api<{ items: Domain[] }>('/domains'), [])
  const [err, setErr] = useState<Error>()
  const patch = async (d: Domain, json: Partial<Domain>) => {
    setErr(undefined)
    try {
      await api(`/domains/${d.id}`, { method: 'PATCH', json })
      list.reload()
    } catch (x) {
      setErr(x as Error)
    }
  }
  return (
    <Card title="Domains">
      <p class="muted">Add domains with <code>npm run domain:add</code>: it sets up the zone, DNS and routes.</p>
      <ErrorBox error={list.error ?? err} />
      <div class="tablewrap">
        <table>
          <thead><tr><th>Apex</th><th>Status</th><th>www</th><th>Wildcard</th><th>Home URL</th><th>Code length</th></tr></thead>
          <tbody>
            {list.data?.items.map((d) => (
              <tr key={d.id}>
                <td><code>{d.apex}</code>{d.is_admin_host && <span class="tag">admin</span>}</td>
                <td><Status s={d.status} /></td>
                <td>{d.serve_www ? 'yes' : 'no'}</td>
                <td>
                  {d.wildcard ? (
                    <select value={d.wildcard_mode} onChange={(e) => patch(d, { wildcard_mode: e.currentTarget.value as Domain['wildcard_mode'] })}>
                      <option value="namespace">namespace</option>
                      <option value="alias">alias</option>
                    </select>
                  ) : 'off'}
                </td>
                <td>
                  <input
                    type="url"
                    defaultValue={d.home_url ?? ''}
                    placeholder="(none)"
                    onChange={(e) => patch(d, { home_url: e.currentTarget.value || null })}
                  />
                </td>
                <td>{d.code_length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ───────────── Health ─────────────
type HealthData = {
  reconcile: { day: string; db_count: number; edge_count: number; diff: number; status: string }[]
  r2_pending: number
  schema_bytes: number
  database_bytes: number
  mode: string
}

export function Health() {
  const h = useAsync(() => api<HealthData>('/ops/health'), [])
  const [msg, setMsg] = useState('')
  const replay = async () => {
    setMsg('Replaying…')
    try {
      const r = await api<{ pending: number }>('/ops/replay', { method: 'POST' })
      setMsg(`Done. ${r.pending} still pending.`)
      h.reload()
    } catch (x) {
      setMsg((x as Error).message)
    }
  }
  const d = h.data
  const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`
  return (
    <>
      <ErrorBox error={h.error} />
      {d && (
        <Card title="Health" actions={<button class="ghost" onClick={replay}>Replay R2 now</button>}>
          <div class="stats">
            <div><strong>{d.mode}</strong><span>mode</span></div>
            <div><strong class={d.r2_pending ? 'warn' : ''}>{d.r2_pending}</strong><span>events pending in R2</span></div>
            <div><strong>{mb(d.schema_bytes)}</strong><span>shortener schema</span></div>
            <div><strong>{mb(d.database_bytes)}</strong><span>whole database</span></div>
          </div>
          {msg && <p class="muted">{msg}</p>}
        </Card>
      )}
      {d && (
        <Card title="Reconcile (Postgres vs Analytics Engine)">
          <div class="tablewrap">
            <table>
              <thead><tr><th>Day</th><th>Postgres</th><th>Edge</th><th>Diff</th><th>Status</th></tr></thead>
              <tbody>
                {d.reconcile.map((r) => (
                  <tr key={r.day}>
                    <td>{r.day}</td><td class="num">{r.db_count}</td><td class="num">{r.edge_count}</td>
                    <td class="num">{r.diff}</td><td><Status s={r.status} /></td>
                  </tr>
                ))}
                {d.reconcile.length === 0 && <tr><td colSpan={5} class="muted">No runs yet (daily at 00:15 UTC).</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  )
}
