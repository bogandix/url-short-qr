import { Api, adminHost } from './lib/client.js'

/** Force the R2 → Postgres replay now (normally every 5 minutes). */
const key = process.env.SHORTENER_API_KEY
if (!key) {
  console.error('Set SHORTENER_API_KEY')
  process.exit(2)
}
const r = await new Api(adminHost(), key).call<{ runs: { read: number; inserted: number }[]; pending: number }>('POST', '/ops/replay')
if (r.status !== 200) {
  console.error(`replay failed: HTTP ${r.status} ${JSON.stringify(r.body)}`)
  process.exit(1)
}
const read = r.body.runs.reduce((n, x) => n + x.read, 0)
const inserted = r.body.runs.reduce((n, x) => n + x.inserted, 0)
console.log(`replayed ${read} events (${inserted} new rows, ${read - inserted} already present); ${r.body.pending} still pending`)
