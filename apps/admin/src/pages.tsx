import { useState } from 'preact/hooks'
import { api, authConfig, changePassword, passwordLogin, sendOtp, setSession, verifyOtp, type Domain, type Link } from './api'
import { Bars, ErrorBox, FeedItem, Icon, Status, Top, ago, countryName, flag, go, useAsync, withQuery, type ClickRow } from './ui'

/** Text wordmark in brand type and colours (no logo artwork). */
function Wordmark() {
  return (
    <div class="wordmark" aria-label="Short links">
      <span>Short links</span>
      <i aria-hidden="true" />
    </div>
  )
}

// ───────────── Sign in ─────────────
export function Login() {
  const cfg = useAsync(authConfig, [])
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
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
  const provider = cfg.data?.provider
  return (
    <div class="auth">
      <div class="auth-inner">
        <Wordmark />
        <p class="lede">Short links, QR codes and tracking</p>
        {(provider === 'password' || provider === 'supabase') && (
          <section class="card">
            <form onSubmit={run(() => passwordLogin(email.trim(), pw))}>
              <h1>Sign in</h1>
              <label>Email<input type="email" required autoComplete="username" value={email} onInput={(e) => setEmail(e.currentTarget.value)} autoFocus /></label>
              <label>Password<input type="password" required autoComplete="current-password" value={pw} onInput={(e) => setPw(e.currentTarget.value)} /></label>
              <button class="primary" disabled={busy}>Sign in</button>
            </form>
          </section>
        )}
        {provider === 'supabase' && (
          <section class="card">
            {!sent ? (
              <form onSubmit={run(async () => (await sendOtp(email), setSent(true)))}>
                <h2>Or get a code by email</h2>
                <label>Email<input type="email" required value={email} onInput={(e) => setEmail(e.currentTarget.value)} /></label>
                <button disabled={busy}>Send code</button>
              </form>
            ) : (
              <form onSubmit={run(() => verifyOtp(email, code.trim()))}>
                <label>Code from the email<input inputMode="numeric" required value={code} onInput={(e) => setCode(e.currentTarget.value)} autoFocus /></label>
                <div class="row">
                  <button class="primary" disabled={busy}>Sign in</button>
                  <button type="button" class="ghost" onClick={() => setSent(false)}>Back</button>
                </div>
              </form>
            )}
          </section>
        )}
        <ErrorBox error={err ?? cfg.error} />
        {!showKey ? (
          <button class="ghost small" onClick={() => setShowKey(true)}>Use an API key instead</button>
        ) : (
          <section class="card">
            <form onSubmit={run(async () => {
              setSession({ kind: 'key', token: key.trim() })
              await api('/links?limit=1')
            })}>
              <label>API key<input type="password" autoComplete="off" placeholder="sk_live_…" value={key} onInput={(e) => setKey(e.currentTarget.value)} /></label>
              <button disabled={busy || !key}>Use key</button>
            </form>
          </section>
        )}
      </div>
    </div>
  )
}

// ───────────── Temporary password → new password ─────────────
export function ChangePassword() {
  const [cur, setCur] = useState('')
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [err, setErr] = useState<Error>()
  const [busy, setBusy] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    setErr(undefined)
    if (a !== b) return setErr(new Error('The new passwords do not match.'))
    setBusy(true)
    try {
      await changePassword(cur, a)
    } catch (x) {
      setErr(x as Error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="auth">
      <div class="auth-inner">
        <Wordmark />
        <section class="card">
          <form onSubmit={submit}>
            <h1>Choose a new password</h1>
            <p class="muted small" style={{ margin: 0 }}>You signed in with a temporary password.</p>
            <label>Temporary password<input type="password" autoComplete="current-password" required value={cur} onInput={(e) => setCur(e.currentTarget.value)} autoFocus /></label>
            <label>New password <span class="hint">12 characters or more</span><input type="password" autoComplete="new-password" required minLength={12} value={a} onInput={(e) => setA(e.currentTarget.value)} /></label>
            <label>Repeat new password<input type="password" autoComplete="new-password" required value={b} onInput={(e) => setB(e.currentTarget.value)} /></label>
            <button class="primary" disabled={busy || a.length < 12}>Save password</button>
          </form>
        </section>
        <ErrorBox error={err} />
        <button class="ghost small" onClick={() => setSession(null)}>Sign out</button>
      </div>
    </div>
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
  const summary = useAsync(
    () => api<LinksSummary>(`/links/summary${f.namespace ? `?namespace=${encodeURIComponent(f.namespace)}` : ''}`),
    [f.namespace],
  )
  const s = summary.data
  const set = (k: keyof typeof f) => (e: Event) => {
    setCursor([])
    setF({ ...f, [k]: (e.currentTarget as HTMLInputElement).value })
  }
  return (
    <>
      <div class="page-head">
        <div>
          <h1>Links</h1>
          <p>Every short link, newest change first.</p>
        </div>
        <a class="btn primary" href="#/new"><Icon name="plus" /> New link</a>
      </div>
      <div class="stats summary">
        <div class="stat hero"><strong>{s?.clicks.today ?? '–'}</strong><span>scans today{s ? ` · ${s.clicks.visitors_today} people` : ''}</span></div>
        <div class="stat"><strong>{s?.clicks.d7 ?? '–'}</strong><span>scans, last 7 days</span></div>
        <div class="stat"><strong>{s?.clicks.d30 ?? '–'}</strong><span>scans, last 30 days</span></div>
        <div class="stat"><strong>{s?.links.active ?? '–'}</strong><span>active links{s?.links.paused ? ` · ${s.links.paused} paused` : ''}</span></div>
        <div class="stat"><strong>{s?.links.total ?? '–'}</strong><span>links in total{s?.links.created_7d ? ` · ${s.links.created_7d} new this week` : ''}</span></div>
      </div>
      <section class="card">
        <div class="filters">
          <input type="search" placeholder="Search code, title or URL" value={f.q} onChange={set('q')} aria-label="Search" />
          <select value={f.namespace} onChange={set('namespace')} aria-label="Domain">
            <option value="">All domains</option>
            {domains.data?.items.map((d) => <option key={d.id} value={d.apex}>{d.apex}</option>)}
          </select>
          <select value={f.status} onChange={set('status')} aria-label="Status">
            <option value="">Active and paused</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="archived">Archived</option>
          </select>
          <input placeholder="Tag" value={f.tag} onChange={set('tag')} aria-label="Tag" />
          <input placeholder="Owner" value={f.owner} onChange={set('owner')} aria-label="Owner" />
        </div>
        <ErrorBox error={list.error} />
        <table class="list">
          <thead><tr><th>Short link</th><th>Goes to</th><th class="num">Scans</th><th class="num">7 days</th><th>Last scan</th><th>Status</th></tr></thead>
          <tbody>
            {list.data?.items.map((l) => (
              <tr key={l.id} onClick={() => go(`link/${l.namespace}/${l.code}`)} class="click">
                <td class="primary-cell" data-label="Link">
                  <code>{l.namespace.toUpperCase()}/{l.code}</code>
                  {l.title && <div class="muted small trunc">{l.title}</div>}
                </td>
                <td class="trunc wide" data-label="To">{l.target_url}{l.tags.length > 0 && <div>{l.tags.map((t) => <span class="tag" key={t}>{t}</span>)}</div>}</td>
                <td class="num metric" data-label="Scans"><b>{l.stats?.total ?? 0}</b>{l.stats?.today ? <span class="delta">+{l.stats.today} today</span> : null}</td>
                <td class="num metric" data-label="7 days">{l.stats?.last_7d ?? 0}</td>
                <td class="muted metric" data-label="Last scan">{l.stats?.last_click_at ? ago(l.stats.last_click_at) : 'never'}</td>
                <td class="status-cell"><Status s={l.status} /></td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 && <tr><td colSpan={6} class="muted">No links match.</td></tr>}
          </tbody>
        </table>
        <div class="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--space-3)' }}>
          <button class="small" disabled={!cursor.length} onClick={() => setCursor(cursor.slice(0, -1))}>Previous</button>
          <button class="small" disabled={!list.data?.next_cursor} onClick={() => setCursor([...cursor, list.data!.next_cursor!])}>Next</button>
        </div>
      </section>
    </>
  )
}

type LinksSummary = {
  links: { total: number; active: number; paused: number; archived: number; created_7d: number }
  clicks: { today: number; d7: number; d30: number; visitors_today: number }
}

// ───────────── New link ─────────────
const capacity = (n: number) => {
  const c = 33 ** n
  return c >= 1e9 ? `${(c / 1e9).toFixed(c >= 1e10 ? 0 : 1)}B` : c >= 1e6 ? `${(c / 1e6).toFixed(c >= 1e7 ? 0 : 1)}M` : c.toLocaleString('en')
}

export function NewLink() {
  // Keys without domains:admin cannot list domains: fall back to the host this UI runs on.
  const domains = useAsync(
    () => api<{ items: Domain[] }>('/domains').catch(() => ({ items: [{ id: 'here', apex: location.hostname, code_length: 4, status: 'active' } as Domain] })),
    [],
  )
  const [v, setV] = useState({ namespace: '', target_url: '', code: '', code_length: '', title: '', tags: '', owner: '', expires_at: '', fallback_url: '' })
  const [more, setMore] = useState(false)
  const [created, setCreated] = useState<Link>()
  const [err, setErr] = useState<Error>()
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof v) => (e: Event) => setV({ ...v, [k]: (e.currentTarget as HTMLInputElement).value })
  const ns = v.namespace || domains.data?.items.find((d) => d.status !== 'disabled')?.apex || ''
  const domainLen = domains.data?.items.find((d) => d.apex === ns)?.code_length ?? 4
  const len = Number(v.code_length || domainLen)
  const submit = async (e: Event) => {
    e.preventDefault()
    setErr(undefined)
    setBusy(true)
    try {
      const body: Record<string, unknown> = { namespace: ns, target_url: v.target_url }
      if (v.code) body.code = v.code
      else if (v.code_length) body.code_length = Number(v.code_length)
      if (v.title) body.title = v.title
      if (v.owner) body.owner = v.owner
      if (v.fallback_url) body.fallback_url = v.fallback_url
      if (v.tags) body.tags = v.tags.split(',').map((s) => s.trim()).filter(Boolean)
      if (v.expires_at) body.expires_at = new Date(v.expires_at).toISOString()
      setCreated(await api<Link>('/links', { method: 'POST', json: body }))
    } catch (x) {
      setErr(x as Error)
    } finally {
      setBusy(false)
    }
  }
  if (created) return <Created link={created} />
  return (
    <>
      <div class="page-head"><div><h1>New link</h1><p>Paste where it should go; the short code and QR are made for you.</p></div></div>
      <section class="card">
        <form onSubmit={submit}>
          <label>Where should it go?
            <input type="url" inputMode="url" required placeholder="https://…" value={v.target_url} onInput={set('target_url')} autoFocus />
          </label>
          <div class="form-grid">
            <label>Domain
              <select value={ns} onChange={set('namespace')}>
                {domains.data?.items.filter((d) => d.status !== 'disabled').map((d) => <option key={d.id} value={d.apex}>{d.apex}</option>)}
              </select>
            </label>
            <label>Code length
              <select value={v.code_length} onChange={set('code_length')} disabled={!!v.code}>
                <option value="">Default ({domainLen})</option>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>{n} · {capacity(n)} codes</option>
                ))}
              </select>
              <span class="hint">{v.code ? 'Not used with your own code.' : `Looks like ${ns.toUpperCase()}/${'A7K2M9QX'.slice(0, len)}`}</span>
            </label>
            <label>Your own code <span class="hint">optional</span>
              <input placeholder="e.g. PROMO" value={v.code} onInput={set('code')} pattern="[0-9A-Za-z\-]{1,32}" autoCapitalize="characters" />
            </label>
            <label>Title <span class="hint">optional</span><input value={v.title} onInput={set('title')} /></label>
          </div>
          {!more ? (
            <button type="button" class="ghost small" onClick={() => setMore(true)} style={{ justifySelf: 'start' }}>More options</button>
          ) : (
            <div class="form-grid">
              <label>Tags <span class="hint">comma-separated</span><input value={v.tags} onInput={set('tags')} /></label>
              <label>Owner<input placeholder="vrumvrum:garage:42" value={v.owner} onInput={set('owner')} /></label>
              <label>Expires<input type="datetime-local" value={v.expires_at} onInput={set('expires_at')} /></label>
              <label>Fallback URL <span class="hint">when paused or expired</span><input type="url" value={v.fallback_url} onInput={set('fallback_url')} /></label>
            </div>
          )}
          <div class="row">
            <button class="primary" disabled={busy || !ns}>Create link</button>
            <button type="button" class="ghost" onClick={() => go('links')}>Cancel</button>
          </div>
        </form>
        <ErrorBox error={err ?? domains.error} />
      </section>
    </>
  )
}

function QrBlock({ link }: { link: Link }) {
  return (
    <div class="qr">
      <img class="preview-qr" src={withQuery(link.qr.svg, { size: 480 })} width={200} height={200} alt={`QR code for ${link.short_url}`} />
      <div class="row">
        <a class="btn small" href={withQuery(link.qr.svg, { size: 1024 })} download={`${link.code}.svg`}><Icon name="download" /> SVG</a>
        <a class="btn small" href={withQuery(link.qr.png, { size: 1024 })} download={`${link.code}.png`}><Icon name="download" /> PNG</a>
      </div>
    </div>
  )
}

function Created({ link }: { link: Link }) {
  const [copied, setCopied] = useState(false)
  return (
    <section class="card">
      <header><h2>Link created</h2><Status s="active" /></header>
      <div class="split">
        <div style={{ display: 'grid', gap: 'var(--space-3)', minWidth: 0 }}>
          <p class="big" style={{ margin: 0 }}>{link.short_url}</p>
          <p class="muted trunc" style={{ margin: 0 }}>→ {link.target_url}</p>
          <div class="row">
            <button class="primary" onClick={() => navigator.clipboard.writeText(link.short_url).then(() => setCopied(true))}><Icon name="copy" /> {copied ? 'Copied' : 'Copy link'}</button>
            <button onClick={() => go(`link/${link.namespace}/${link.code}`)}>Details</button>
            <button onClick={() => go(`qr/${link.namespace}/${link.code}`)}>Style QR</button>
            <button class="ghost" onClick={() => location.reload()}>Another</button>
          </div>
        </div>
        <QrBlock link={link} />
      </div>
    </section>
  )
}

// ───────────── Link detail ─────────────
type Daily = { day: string; outcome: string; clicks: number; uniques: number; bots: number } & Record<string, unknown>
type Live = { bucket: string; outcome: string; clicks: number; uniques: number; bots: number }
type Audit = { ts: string; actor: string; action: string }
const DIMS = ['country', 'city', 'device', 'os', 'browser', 'source', 'referer', 'language'] as const
const DIM_TITLE: Record<(typeof DIMS)[number], string> = {
  country: 'Countries', city: 'Cities', device: 'Devices', os: 'Operating systems', browser: 'Browsers', source: 'Sources', referer: 'Referrers', language: 'Languages',
}

export function LinkDetail({ ns, code }: { ns: string; code: string }) {
  const path = `/links/${encodeURIComponent(ns)}/${encodeURIComponent(code)}`
  const link = useAsync(() => api<Link & { audit: Audit[] }>(path), [path])
  const [days, setDays] = useState(30)
  const from = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10)
  const stats = useAsync(() => api<{ daily: Daily[]; live: Live[] }>(`${path}/stats?from=${from}`), [path, from])
  const clicks = useAsync(() => api<{ items: ClickRow[] }>(`${path}/clicks?limit=30`), [path])
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
  const agg = Object.fromEntries(DIMS.map((d) => [d, {} as Record<string, number>])) as Record<(typeof DIMS)[number], Record<string, number>>
  let total = 0, uniques = 0, bots = 0
  for (const d of stats.data?.daily ?? []) {
    if (d.outcome !== 'redirect') continue
    const e = byDay.get(d.day) ?? { value: 0, sub: 0, bots: 0 }
    e.value += d.clicks - d.bots
    e.sub += d.uniques
    e.bots += d.bots
    byDay.set(d.day, e)
    for (const k of DIMS) for (const [kk, n] of Object.entries((d[`by_${k}`] as Record<string, number>) ?? {})) agg[k][kk] = (agg[k][kk] ?? 0) + n
  }
  for (const l of stats.data?.live ?? []) {
    if (l.outcome !== 'redirect') continue
    const day = String(l.bucket).slice(0, 10)
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
        <section class="card">
          <header>
            <div style={{ minWidth: 0 }}>
              <p class="big" style={{ margin: 0 }}>{l.short_url}</p>
              {l.title && <p class="muted" style={{ margin: '2px 0 0' }}>{l.title}</p>}
            </div>
            <Status s={l.status} />
          </header>
          <div class="split">
            <dl class="kv">
              <dt>Goes to</dt><dd><a href={l.target_url} target="_blank" rel="noreferrer">{l.target_url}</a></dd>
              {l.owner && <><dt>Owner</dt><dd>{l.owner}</dd></>}
              {l.tags.length > 0 && <><dt>Tags</dt><dd>{l.tags.map((t) => <span class="tag" key={t}>{t}</span>)}</dd></>}
              {l.expires_at && <><dt>Expires</dt><dd>{new Date(l.expires_at).toLocaleString()}</dd></>}
              {l.external_id && <><dt>External id</dt><dd><code>{l.external_id}</code></dd></>}
              <dt>Version</dt><dd>{l.version}</dd>
            </dl>
            <QrBlock link={l} />
          </div>
          <div class="row" style={{ marginTop: 'var(--space-4)' }}>
            <button onClick={() => navigator.clipboard.writeText(l.short_url)}><Icon name="copy" /> Copy</button>
            <button onClick={() => go(`qr/${l.namespace}/${l.code}`)}><Icon name="qr" /> Style QR</button>
            {l.status === 'active' && <button onClick={() => act({ status: 'paused' })}>Pause</button>}
            {l.status === 'paused' && <button onClick={() => act({ status: 'active' })}>Resume</button>}
            {l.status !== 'archived' && (
              <button class="danger" onClick={() => window.confirm(`Archive ${l.short_url}? It stops redirecting and the code is never reused.`) && act(undefined, 'DELETE')}>Archive</button>
            )}
          </div>
        </section>
      )}
      <section class="card">
        <header>
          <h2>Scans and clicks</h2>
          <div class="seg" role="group" aria-label="Range">
            {[7, 30, 90, 365].map((d) => (
              <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>{d === 365 ? '1y' : `${d}d`}</button>
            ))}
          </div>
        </header>
        <div class="stats">
          <div class="stat hero"><strong>{total}</strong><span>human scans & clicks</span></div>
          <div class="stat"><strong>{uniques}</strong><span>unique visitors / day</span></div>
          <div class="stat"><strong>{bots}</strong><span>bots & previews</span></div>
        </div>
        <ErrorBox error={stats.error} />
        <Bars data={series} />
        <div class="legend"><span><i />Scans & clicks</span><span><i class="sub" />Unique visitors</span></div>
        <div class="tops" style={{ marginTop: 'var(--space-6)' }}>
          {DIMS.map((d) => (
            <Top key={d} title={DIM_TITLE[d]} counts={agg[d]} label={d === 'country' ? (k) => `${flag(k)} ${countryName(k)}` : undefined} />
          ))}
        </div>
        <p class="muted small">Breakdowns cover days up to yesterday (rolled up nightly) and count people only. Today's scans are in the list below.</p>
      </section>
      <section class="card">
        <header><h2>Latest scans</h2><button class="small" onClick={() => clicks.reload()}>Refresh</button></header>
        <ErrorBox error={clicks.error} />
        <ul class="feed">
          {clicks.data?.items.map((c) => <FeedItem key={String(c.id)} c={c} showLink={false} />)}
          {clicks.data && clicks.data.items.length === 0 && <li class="muted">Nobody has opened this link yet.</li>}
        </ul>
      </section>
      {l && (
        <section class="card">
          <header><h2>History</h2></header>
          <ul class="audit">
            {l.audit.map((a, i) => (
              <li key={i}><span class="muted">{new Date(a.ts).toLocaleString()}</span> <b>{a.action.replace('link.', '')}</b> <span class="muted">by {a.actor}</span></li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
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
    <>
      <div class="page-head"><div><h1>Domains</h1><p>Add domains with <code>npm run domain:add</code>: it sets up the zone, DNS and routes.</p></div></div>
      <section class="card">
        <ErrorBox error={list.error ?? err} />
        <table class="list">
          <thead><tr><th>Domain</th><th>Status</th><th>www</th><th>Subdomains</th><th>Home page redirect</th><th>Code length</th></tr></thead>
          <tbody>
            {list.data?.items.map((d) => (
              <tr key={d.id}>
                <td class="primary-cell" data-label="Domain"><code>{d.apex.toUpperCase()}</code> {d.is_admin_host && <span class="tag">admin</span>}</td>
                <td class="status-cell"><Status s={d.status} /></td>
                <td data-label="www">{d.serve_www ? 'yes' : 'no'}</td>
                <td data-label="Subdomains" class="wide">
                  {d.wildcard ? (
                    <select value={d.wildcard_mode} onChange={(e) => patch(d, { wildcard_mode: e.currentTarget.value as Domain['wildcard_mode'] })} aria-label="Wildcard mode">
                      <option value="namespace">Each has its own codes</option>
                      <option value="alias">Share the main codes</option>
                    </select>
                  ) : 'off'}
                </td>
                <td data-label="Home" class="wide">
                  <input type="url" defaultValue={d.home_url ?? ''} placeholder="https://…" onChange={(e) => patch(d, { home_url: e.currentTarget.value || null })} aria-label="Home page redirect" />
                </td>
                <td data-label="Code length" class="wide">
                  <select value={d.code_length} onChange={(e) => patch(d, { code_length: Number(e.currentTarget.value) })} aria-label="Default code length">
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n} characters</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
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
      setMsg(`Done. ${r.pending} still waiting.`)
      h.reload()
    } catch (x) {
      setMsg((x as Error).message)
    }
  }
  const d = h.data
  const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`
  return (
    <>
      <div class="page-head"><div><h1>Health</h1><p>Every request is logged once; this page proves it.</p></div></div>
      <ErrorBox error={h.error} />
      {d && (
        <section class="card">
          <header><h2>System</h2><button class="small" onClick={replay}>Replay buffer now</button></header>
          <div class="stats">
            <div class="stat"><strong>{d.mode}</strong><span>mode</span></div>
            <div class="stat"><strong class={d.r2_pending ? 'warn' : ''}>{d.r2_pending}</strong><span>events waiting in the outage buffer</span></div>
            <div class="stat"><strong>{mb(d.schema_bytes)}</strong><span>shortener data</span></div>
            <div class="stat"><strong>{mb(d.database_bytes)}</strong><span>whole database</span></div>
          </div>
          {msg && <p class="muted">{msg}</p>}
        </section>
      )}
      {d && (
        <section class="card">
          <header><h2>Daily reconcile</h2></header>
          <p class="muted small">Postgres rows vs. the independent Analytics Engine counter, per day. Diff must be 0.</p>
          <table class="list">
            <thead><tr><th>Day</th><th class="num">Postgres</th><th class="num">Edge counter</th><th class="num">Diff</th><th>Status</th></tr></thead>
            <tbody>
              {d.reconcile.map((r) => (
                <tr key={r.day}>
                  <td class="primary-cell" data-label="Day">{r.day}</td>
                  <td class="num" data-label="Postgres">{r.db_count}</td>
                  <td class="num" data-label="Edge">{r.edge_count}</td>
                  <td class="num" data-label="Diff">{r.diff}</td>
                  <td class="status-cell"><Status s={r.status} /></td>
                </tr>
              ))}
              {d.reconcile.length === 0 && <tr><td colSpan={5} class="muted">No runs yet: the first runs at 00:15 UTC.</td></tr>}
            </tbody>
          </table>
        </section>
      )}
    </>
  )
}

// ───────────── More (phones) ─────────────
export function More({ email }: { email?: string }) {
  return (
    <>
      <div class="page-head"><div><h1>More</h1>{email && <p>Signed in as {email}</p>}</div></div>
      <section class="card">
        <ul class="menu">
          <li><a href="#/domains"><Icon name="globe" /> Domains</a></li>
          <li><a href="#/keys"><Icon name="key" /> API keys</a></li>
          <li><a href="#/health"><Icon name="pulse" /> Health</a></li>
          <li><button onClick={() => setSession(null)}><Icon name="out" /> Sign out</button></li>
        </ul>
      </section>
    </>
  )
}
