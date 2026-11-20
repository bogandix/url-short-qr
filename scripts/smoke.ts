import { loadState } from '../setup/lib/state.js'
import { CF } from '../setup/lib/cf.js'
import { adminHost } from './lib/client.js'
import { runSmoke } from './lib/smoke.js'

/** npm run smoke [host…]   (defaults to every configured domain; wildcard domains also test a sample subdomain) */
const s = loadState()
const key = process.env.SHORTENER_API_KEY
if (!key) {
  console.error('Set SHORTENER_API_KEY')
  process.exit(2)
}
const hosts = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const targets = hosts.length
  ? hosts
  : (process.env.SHORTENER_DOMAINS?.split(',').map((x) => x.trim()).filter(Boolean) ??
    Object.values(s.domains).flatMap((d) => (d.wildcard && d.wildcardMode === 'namespace' ? [d.apex, `smoke.${d.apex}`] : [d.apex])))
if (targets.length === 0) {
  console.error('No domains: pass hosts or set SHORTENER_DOMAINS')
  process.exit(2)
}
const cf = process.env.CLOUDFLARE_API_TOKEN ? new CF(process.env.CLOUDFLARE_API_TOKEN, process.env.CLOUDFLARE_ACCOUNT_ID ?? s.accountId) : undefined

let failed = 0
for (const host of targets) {
  console.log(`smoke ${host}`)
  try {
    await runSmoke({ host, adminHost: adminHost(s), apiKey: key, cf })
    console.log(`✓ ${host}`)
  } catch (err) {
    failed++
    console.error(`✗ ${host}: ${(err as Error).message}`)
  }
}
process.exit(failed ? 1 : 0)
