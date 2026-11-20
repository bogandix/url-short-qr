import { describe, expect, it } from 'vitest'
import { ipHash, visitorHash } from './hash.js'

describe('hashes', () => {
  it('are stable within a day and differ across days', async () => {
    const a = await ipHash('salt', '2026-01-01', '203.0.113.9')
    const b = await ipHash('salt', '2026-01-01', '203.0.113.9')
    const c = await ipHash('salt', '2026-01-02', '203.0.113.9')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })
  it('visitor hash includes ua and lang', async () => {
    const a = await visitorHash('salt', '2026-01-01', '1.1.1.1', 'ua', 'en')
    const b = await visitorHash('salt', '2026-01-01', '1.1.1.1', 'ua', 'de')
    expect(a).not.toBe(b)
  })
})
