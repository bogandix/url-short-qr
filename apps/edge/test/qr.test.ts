import { describe, expect, it } from 'vitest'
import { encode } from 'uqr'
import { qrPng, qrSvg } from '../src/lib/qr.js'

/** Root-tag attributes must be unique, or browsers reject the SVG ("Attribute viewBox redefined"). */
function rootAttrs(svg: string): string[] {
  const tag = svg.match(/^<svg\b([^>]*)>/)![1]!
  return [...tag.matchAll(/\s([a-zA-Z:-]+)=/g)].map((m) => m[1]!)
}

describe('QR rendering', () => {
  const payload = 'HTTPS://VV1.EU/VHTV'

  it('SVG is well-formed: single viewBox, sized, colours applied', () => {
    const svg = qrSvg(payload, { size: 256, fg: '#1a3c8f', bg: '#ffffff', margin: 4 })
    const attrs = rootAttrs(svg)
    expect(new Set(attrs).size).toBe(attrs.length)
    expect(attrs).toEqual(expect.arrayContaining(['xmlns', 'width', 'height', 'viewBox']))
    const n = encode(payload, { ecc: 'M', border: 4 }).size
    expect(svg).toContain(`viewBox="0 0 ${n} ${n}"`)
    expect(svg).toContain('width="256" height="256"')
    expect(svg).toContain('fill="#1a3c8f"')
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg.match(/<svg/g)).toHaveLength(1)
  })

  it('SVG dark-module area matches the QR matrix', () => {
    const { data } = encode(payload, { ecc: 'H', border: 2 })
    const dark = data.flat().filter(Boolean).length
    const d = qrSvg(payload, { ecc: 'H', margin: 2 }).match(/ d="([^"]+)"/)![1]!
    const area = [...d.matchAll(/h(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0) // each run is 1 module tall
    expect(area).toBe(dark)
  })

  it('uppercase payload gives a version-1 symbol at ECC M', () => {
    expect(encode(payload, { ecc: 'M', border: 0 }).size).toBe(21)
  })

  it('PNG has a valid signature and RGB header', async () => {
    const png = await qrPng(payload, { size: 300 })
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png[25]).toBe(2) // colour type: truecolor
  })
})
