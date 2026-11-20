import { encode } from 'uqr'

export type Ecc = 'L' | 'M' | 'Q' | 'H'

export type QrOptions = { size: number; ecc: Ecc; margin: number; fg: string; bg: string }

const HEX_RE = /^[0-9a-f]{6}$/i

function color(v: string | null, def: string): string {
  if (!v) return def
  let h = v.replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((x) => x + x).join('')
  return HEX_RE.test(h) ? `#${h.toLowerCase()}` : def
}

export function parseQrOptions(q: URLSearchParams): QrOptions {
  const size = clampInt(q.get('size'), 64, 2048, 512)
  const margin = clampInt(q.get('margin'), 0, 16, 4)
  const e = (q.get('ecc') ?? 'M').toUpperCase()
  const ecc: Ecc = e === 'L' || e === 'M' || e === 'Q' || e === 'H' ? e : 'M'
  return { size, ecc, margin, fg: color(q.get('fg'), '#000000'), bg: color(q.get('bg'), '#ffffff') }
}

function clampInt(v: string | null, min: number, max: number, def: number): number {
  const n = v == null ? NaN : Number.parseInt(v, 10)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

/** Uppercase payload keeps the QR in alphanumeric mode (smallest symbol). */
export { shortUrl as shortPayload } from '@shortener/shared'

/**
 * Bump when the rendered output changes: QR URLs carry `v=<this>` so browsers that cached
 * an older image (served immutable for a year) fetch the new one.
 */
export const QR_RENDER_VERSION = '2'

/**
 * SVG rendered directly from the module matrix: one root element with a single viewBox
 * (in modules) and width/height (in px), dark modules merged into horizontal runs.
 */
export function qrSvg(payload: string, opts: Partial<QrOptions> = {}): string {
  const o = { size: 512, ecc: 'M' as Ecc, margin: 4, fg: '#000000', bg: '#ffffff', ...opts }
  const { data, size: n } = encode(payload, { ecc: o.ecc, border: o.margin })
  let d = ''
  for (let y = 0; y < n; y++) {
    const row = data[y]!
    for (let x = 0; x < n; ) {
      if (!row[x]) {
        x++
        continue
      }
      let w = 1
      while (x + w < n && row[x + w]) w++
      d += `M${x} ${y}h${w}v1h-${w}z`
      x += w
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${o.size}" height="${o.size}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="${o.bg}"/><path fill="${o.fg}" d="${d}"/></svg>`
  )
}

/** Black/white PNG of the QR symbol (8-bit grayscale, zlib via CompressionStream). */
export async function qrPng(payload: string, opts: Partial<QrOptions> = {}): Promise<Uint8Array<ArrayBuffer>> {
  const o = { size: 512, ecc: 'M' as Ecc, margin: 4, fg: '#000000', bg: '#ffffff', ...opts }
  const { data, size: modules } = encode(payload, { ecc: o.ecc, border: o.margin })
  const scale = Math.max(1, Math.floor(o.size / modules))
  const px = modules * scale
  const rgb = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
  const fg = rgb(o.fg)
  const bg = rgb(o.bg)

  const stride = px * 3 + 1 // RGB, one filter byte per row
  const raw = new Uint8Array(px * stride)
  for (let y = 0; y < px; y++) {
    const row = data[Math.floor(y / scale)]!
    const off = y * stride
    raw[off] = 0 // filter: none
    for (let x = 0; x < px; x++) raw.set(row[Math.floor(x / scale)] ? fg : bg, off + 1 + x * 3)
  }

  const idat = await zlib(raw)
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, px)
  dv.setUint32(4, px)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor RGB
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ])
}

async function zlib(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + body.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, body.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)))
  return out
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
