import { useState } from 'preact/hooks'
import { api, type Link } from './api'
import { Card, ErrorBox, useAsync } from './ui'

/** QR generator: pick a link, style it, preview and download. Images come from the link's own host. */
export function QrGenerator({ ns, code }: { ns?: string; code?: string }) {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<{ namespace: string; code: string } | null>(ns && code ? { namespace: ns, code } : null)
  const [o, setO] = useState({ size: 1024, ecc: 'M', margin: 4, fg: '#000000', bg: '#ffffff' })
  const list = useAsync(() => api<{ items: Link[] }>(`/links?limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`), [q])
  const set = (k: keyof typeof o) => (e: Event) => {
    const v = (e.currentTarget as HTMLInputElement).value
    setO({ ...o, [k]: k === 'size' || k === 'margin' ? Number(v) : v })
  }
  const params = new URLSearchParams({ size: String(o.size), ecc: o.ecc, margin: String(o.margin), fg: o.fg.slice(1), bg: o.bg.slice(1) })
  const base = picked ? `https://${picked.namespace}/_/qr/${picked.code}` : ''
  const shortUrl = picked ? `https://${picked.namespace}/${picked.code}` : ''
  const lowContrast = contrast(o.fg, o.bg) < 4

  return (
    <div class="qrgen">
      <Card title="1. Pick a link">
        <input placeholder="Search code, title or URL" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        <ErrorBox error={list.error} />
        <ul class="picklist">
          {list.data?.items.map((l) => (
            <li key={l.id}>
              <button
                class={picked?.namespace === l.namespace && picked.code === l.code ? '' : 'ghost'}
                onClick={() => setPicked({ namespace: l.namespace, code: l.code })}
              >
                <code>{l.namespace}/{l.code}</code>
              </button>
              <span class="muted trunc">{l.title ?? l.target_url}</span>
            </li>
          ))}
        </ul>
        <p class="muted small">Need a new link? Create it under <a href="#/new">New</a>.</p>
      </Card>
      <Card title="2. Style">
        <form class="grid2" onSubmit={(e) => e.preventDefault()}>
          <label>Size (px)
            <select value={o.size} onChange={set('size')}>
              {[256, 512, 1024, 2048].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>Error correction
            <select value={o.ecc} onChange={set('ecc')}>
              <option value="L">L — 7% (smallest)</option>
              <option value="M">M — 15% (default)</option>
              <option value="Q">Q — 25%</option>
              <option value="H">H — 30% (print, stickers)</option>
            </select>
          </label>
          <label>Quiet zone (modules)<input type="number" min={0} max={16} value={o.margin} onInput={set('margin')} /></label>
          <label>Foreground<input type="color" value={o.fg} onInput={set('fg')} /></label>
          <label>Background<input type="color" value={o.bg} onInput={set('bg')} /></label>
        </form>
        {lowContrast && <p class="warn small">Low contrast: some phone cameras will not read this code.</p>}
        {o.margin < 2 && <p class="warn small">A quiet zone under 2 modules makes codes harder to scan.</p>}
      </Card>
      <Card title="3. Preview & download">
        {!picked && <p class="muted">Pick a link first.</p>}
        {picked && (
          <div class="split">
            <div class="qr">
              <img src={`${base}.svg?${params}`} width={240} height={240} alt={`QR code for ${shortUrl}`} />
            </div>
            <div class="grid">
              <p class="big">{shortUrl}</p>
              <code class="muted small">{`HTTPS://${picked.namespace.toUpperCase()}/${picked.code}`}</code>
              <div class="row">
                <a class="button" href={`${base}.svg?${params}`} download={`${picked.code}.svg`} target="_blank" rel="noreferrer">Download SVG</a>
                <a class="button ghost" href={`${base}.png?${params}`} download={`${picked.code}.png`} target="_blank" rel="noreferrer">Download PNG</a>
                <button class="ghost" onClick={() => navigator.clipboard.writeText(`${base}.svg?${params}`)}>Copy image URL</button>
              </div>
              <p class="muted small">The QR encodes the uppercase short URL (alphanumeric mode = smallest code). Image URLs are public and cached; scans are logged as clicks.</p>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

function lum(hex: string) {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
function contrast(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}
