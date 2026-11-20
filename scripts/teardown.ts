import { rmSync } from 'node:fs'
import { databaseFor } from '../setup/databases/index.js'
import { cloudflareAuth } from '../setup/lib/cloudflare.js'
import { isNotFound } from '../setup/lib/cf.js'
import { loadState, STATE_PATH } from '../setup/lib/state.js'
import { ask, p, yes } from '../setup/lib/ui.js'

/** Removes everything the wizard created. `--with-database` also drops the database (or its schema and roles). */
const withDb = process.argv.includes('--with-database')
const s = loadState()
p.intro('shortener teardown')
const cf = await cloudflareAuth(s)
const typed = await ask(`Type the Cloudflare account name ("${s.accountName}") to remove all shortener resources`)
if (typed !== s.accountName) {
  p.cancel('Name did not match. Nothing removed.')
  process.exit(1)
}

const step = async (title: string, fn: () => Promise<unknown>) => {
  try {
    await fn()
    p.log.success(title)
  } catch (err) {
    if (isNotFound(err)) p.log.info(`${title}: already gone`)
    else p.log.error(`${title}: ${(err as Error).message}`)
  }
}

for (const d of Object.values(s.domains)) {
  if (!d.zoneId) continue
  await step(`${d.apex}: worker routes`, async () => {
    const routes = await cf.get<{ id: string; script?: string }[]>(`/zones/${d.zoneId}/workers/routes`)
    for (const r of routes.filter((r) => r.script?.startsWith('shortener-'))) await cf.del(`/zones/${d.zoneId}/workers/routes/${r.id}`)
  })
  await step(`${d.apex}: wildcard DNS`, async () => {
    const recs = await cf.get<{ id: string; content: string }[]>(`/zones/${d.zoneId}/dns_records`, { name: `*.${d.apex}`, type: 'AAAA' })
    for (const r of recs.filter((r) => r.content === '100::')) await cf.del(`/zones/${d.zoneId}/dns_records/${r.id}`)
  })
}
await step('custom domains', async () => {
  const doms = await cf.get<{ id: string; service: string }[]>(`${cf.acct}/workers/domains`)
  for (const d of doms.filter((d) => d.service.startsWith('shortener-'))) await cf.del(`${cf.acct}/workers/domains/${d.id}`)
})
for (const script of ['shortener-consumer', 'shortener-edge']) {
  await step(`worker ${script}`, () => cf.client.delete(`${cf.acct}/workers/scripts/${script}`, { query: { force: true } }))
}
await step('queues', async () => {
  const qs = await cf.get<{ queue_id: string; queue_name: string }[]>(`${cf.acct}/queues`)
  for (const q of qs.filter((q) => q.queue_name.startsWith('shortener-clicks'))) await cf.del(`${cf.acct}/queues/${q.queue_id}`)
})
await step('hyperdrive', async () => {
  const hs = await cf.get<{ id: string; name: string }[]>(`${cf.acct}/hyperdrive/configs`)
  for (const h of hs.filter((h) => h.name.startsWith('shortener-'))) await cf.del(`${cf.acct}/hyperdrive/configs/${h.id}`)
})
if (s.resources?.kvId) await step('KV shortener-links', () => cf.del(`${cf.acct}/storage/kv/namespaces/${s.resources!.kvId}`))
if (s.resources?.r2Bucket) {
  const bucket = s.resources.r2Bucket
  await step(`R2 ${bucket} (objects, then bucket)`, async () => {
    for (;;) {
      const env = (await cf.client.get(`${cf.acct}/r2/buckets/${bucket}/objects`, { query: { per_page: 1000 } })) as { result: { key: string }[] }
      if (!env.result.length) break
      for (const o of env.result) await cf.del(`${cf.acct}/r2/buckets/${bucket}/objects/${encodeURIComponent(o.key)}`)
    }
    await cf.del(`${cf.acct}/r2/buckets/${bucket}`)
  })
}
for (const d of Object.values(s.domains)) {
  if (d.zoneId && (await yes(`Delete the Cloudflare zone ${d.apex}? (the domain stops resolving until you change nameservers back)`, false))) {
    await step(`zone ${d.apex}`, () => cf.del(`/zones/${d.zoneId}`))
  }
}

if (withDb && s.database) {
  const db = databaseFor(s.database.provider, s)
  await db.auth()
  if (db.destroy) await step('database project', () => db.destroy!())
  else
    await step('schema and roles', () =>
      db.runSql(`drop schema if exists shortener cascade; drop role if exists shortener_edge; drop role if exists shortener_admin;`),
    )
}

rmSync(STATE_PATH, { force: true })
p.outro('Teardown finished. Analytics Engine data expires on its own (3 months).')
