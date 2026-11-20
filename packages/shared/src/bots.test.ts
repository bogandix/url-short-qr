import { describe, expect, it } from 'vitest'
import { detectBot } from './bots.js'

describe('detectBot', () => {
  it('flags HEAD and known UAs', () => {
    expect(detectBot('HEAD', 'Mozilla').isBot).toBe(true)
    expect(detectBot('GET', 'Googlebot/2.1').isBot).toBe(true)
    expect(detectBot('GET', 'curl/8.0').isBot).toBe(true)
    expect(detectBot('GET', 'Mozilla/5.0 Safari').isBot).toBe(false)
  })
})
