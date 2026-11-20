import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = { fail: false, inserted: 0 }
vi.mock('postgres', () => ({
  default: () => ({
    unsafe: async (_sql: string, params: unknown[]) => {
      if (state.fail) throw new Error('db down')
      state.inserted += params.length / 32
      return Object.assign([], { count: params.length / 32 })
    },
    end: async () => {},
  }),
}))

import worker from './index.js'

function msg(body: unknown) {
  return { id: crypto.randomUUID(), body, ack: vi.fn(), retry: vi.fn() }
}
const ev = () => ({
  id: crypto.randomUUID(), ts: new Date().toISOString(), host: 'h', namespace: 'h', code: 'A7K2', link_id: null,
  outcome: 'redirect', method: 'GET', path: '/A7K2', query: null, scheme: 'https', country: null, region: null,
  region_code: null, city: null, timezone: null, colo: null, asn: null, as_org: null, ua: null, device: null, os: null,
  browser: null, browser_version: null, lang: null, referer: null, ip_hash: 'x', visitor_hash: 'y', is_bot: false,
  bot_name: null, ray_id: null, source: 'live',
})
const env = { DB: { connectionString: 'postgres://x' } } as never

beforeEach(() => {
  state.fail = false
  state.inserted = 0
})

describe('consumer', () => {
  it('inserts a batch in one statement and acks', async () => {
    const ms = [msg(ev()), msg(ev()), msg(ev())]
    await worker.queue({ messages: ms } as never, env)
    expect(state.inserted).toBe(3)
    for (const m of ms) expect(m.ack).toHaveBeenCalled()
  })
  it('acks malformed messages so they cannot block the batch', async () => {
    const bad = msg({ nope: true })
    const good = msg(ev())
    await worker.queue({ messages: [bad, good] } as never, env)
    expect(bad.ack).toHaveBeenCalled()
    expect(good.ack).toHaveBeenCalled()
    expect(state.inserted).toBe(1)
  })
  it('retries the batch when the database fails', async () => {
    state.fail = true
    const ms = [msg(ev()), msg(ev())]
    await worker.queue({ messages: ms } as never, env)
    for (const m of ms) {
      expect(m.ack).not.toHaveBeenCalled()
      expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    }
  })
})
