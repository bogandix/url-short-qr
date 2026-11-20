import { describe, expect, it } from 'vitest'
import { mergeUtm } from './utm.js'

describe('mergeUtm', () => {
  it('appends only missing keys', () => {
    const out = mergeUtm('https://ex.com/x?utm_source=keep', { utm_source: 'x', utm_medium: 'qr' }, true)
    expect(out).toContain('utm_source=keep')
    expect(out).toContain('utm_medium=qr')
  })

  it('skips when append false', () => {
    expect(mergeUtm('https://ex.com', { a: '1' }, false)).toBe('https://ex.com')
  })
})
