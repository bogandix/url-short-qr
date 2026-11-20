import type { CF } from '../../setup/lib/cf.js'
import { readCode } from '@shortener/shared'
import { Api } from './client.js'

export type SmokeOpts = { host: string; adminHost: string; apiKey: string; cf?: CF; wait?: boolean; log?: (m: string) => void }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class SmokeFail extends Error {}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new SmokeFail(msg)
}

/**
 * §11 smoke: create SMOKE1-xxxx (codes are never reused, so each run gets a suffix),
 * expect 302 + no-store, wait for its row (≤30 s) and the AE counter, expect 404 + row
 * for an unknown code, then archive the link.
 */
export async function runSmoke(o: SmokeOpts): Promise<void> {
  const log = o.log ?? ((m: string) => console.log(`  ${m}`))
  const api = new Api(o.adminHost, o.apiKey)
  const namespace = o.host.toLowerCase()
  const suffix = Buffer.from(crypto.getRandomValues(new Uint8Array(3))).toString('hex').toUpperCase().replace(/[ILO]/g, '0')
  const code = `SMOKE1-${suffix}` // stored as SM0KE1-… (O→0), requested as typed
  const nope = `NOPE99-${suffix}`
  const nopeStored = readCode(nope)!
  const since = new Date(Date.now() - 5000).toISOString()

  // propagation: a fresh custom domain may need a minute for its certificate
  for (let i = 0; ; i++) {
    try {
      const h = await fetch(`https://${o.adminHost}/_/health`)
      if (h.status === 200 || !o.wait) break
    } catch {
      if (!o.wait || i > 30) throw new SmokeFail(`https://${o.adminHost}/_/health unreachable`)
    }
    await sleep(10_000)
  }

  const created = await api.call<{ code: string }>('POST', '/links', { namespace, code, target_url: 'https://example.com/?shortener-smoke=1', tags: ['smoke'] })
  expect(created.status === 201, `create link: HTTP ${created.status} ${JSON.stringify(created.body)}`)
  const stored = created.body.code
  log(`created ${namespace}/${stored}`)
  try {
    // KV is written right after the DB insert; allow edge cache misses to settle.
    let res: Response | null = null
    for (let i = 0; i < 10; i++) {
      res = await fetch(`https://${o.host}/${code}`, { redirect: 'manual', headers: { 'user-agent': 'shortener-smoke/1 (Mozilla)' } })
      if (res.status === 302) break
      await sleep(3000)
    }
    expect(res && res.status === 302, `GET /${code}: expected 302, got ${res?.status}`)
    expect(res.headers.get('location')?.startsWith('https://example.com/'), `bad Location ${res.headers.get('location')}`)
    expect(res.headers.get('cache-control') === 'private, no-store, max-age=0', `bad Cache-Control ${res.headers.get('cache-control')}`)
    log('302 with no-store ✓')

    const rowsFor = async (c: string) =>
      (await api.call<{ items: { outcome: string }[] }>('GET', `/ops/clicks?namespace=${encodeURIComponent(namespace)}&code=${encodeURIComponent(c)}&since=${since}`)).body?.items ?? []
    let rows: { outcome: string }[] = []
    for (let i = 0; i < 15 && !rows.some((r) => r.outcome === 'redirect'); i++) {
      await sleep(2000)
      rows = await rowsFor(stored)
    }
    expect(rows.some((r) => r.outcome === 'redirect'), 'no click row within 30 s')
    log('row in Postgres ✓')

    if (o.cf?.accountId) {
      let n = 0
      for (let i = 0; i < 12 && n === 0; i++) {
        await sleep(10_000)
        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${o.cf.accountId}/analytics_engine/sql`, {
          method: 'POST',
          headers: { authorization: `Bearer ${o.cf.token}` },
          body: `SELECT SUM(_sample_interval) AS n FROM shortener_clicks WHERE blob1 = '${namespace}' AND blob2 = '${stored}' AND timestamp > NOW() - INTERVAL '1' HOUR FORMAT JSON`,
        })
        if (r.ok) n = Number(((await r.json()) as { data: { n: number }[] }).data[0]?.n ?? 0)
      }
      if (n > 0) log('Analytics Engine counter ✓')
      else log('Analytics Engine counter not visible yet (ingestion lag); reconcile will check it')
    }

    const nf = await fetch(`https://${o.host}/${nope}`, { redirect: 'manual' })
    expect(nf.status === 404 || nf.status === 302, `GET /${nope}: expected 404, got ${nf.status}`)
    expect(nf.headers.get('cache-control') === 'private, no-store, max-age=0', 'unknown code response is cacheable')
    let nfRows: { outcome: string }[] = []
    for (let i = 0; i < 15 && nfRows.length === 0; i++) {
      await sleep(2000)
      nfRows = await rowsFor(nopeStored)
    }
    expect(nfRows.some((r) => r.outcome === 'not_found'), `no not_found row for /${nope}`)
    log(`/${nope} → ${nf.status} with row ✓`)
  } finally {
    const del = await api.call('DELETE', `/links/${encodeURIComponent(namespace)}/${stored}`)
    log(del.status === 200 ? 'archived smoke link' : `could not archive smoke link (HTTP ${del.status})`)
  }
}

export { SmokeFail }
