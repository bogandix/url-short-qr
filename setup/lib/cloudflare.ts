import { execFile } from 'node:child_process'
import { CF, analyticsTokenPageUrl, tokenPageUrl } from './cf.js'
import { saveState, type State } from './state.js'
import { choose, p, secret, task } from './ui.js'

export function openUrl(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  execFile(cmd, [url], () => {})
}

/** Step 1: token from $CLOUDFLARE_API_TOKEN or the pre-filled token page; verify; pick account. */
export async function cloudflareAuth(s: State, opts: { interactive?: boolean } = {}): Promise<CF> {
  let token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) {
    const url = tokenPageUrl()
    p.note(`A browser tab opens with the token form pre-filled.\nCheck the permissions, create the token, and paste it here.\n\n${url}`, 'Cloudflare API token')
    if (opts.interactive !== false) openUrl(url)
    token = await secret('Cloudflare API token')
  }
  const cf = new CF(token, s.accountId)
  const v = await task('Verifying token', () => cf.get<{ status: string }>('/user/tokens/verify'))
  if (v.status !== 'active') throw new Error(`token status is ${v.status}`)

  if (!s.accountId) {
    const accounts = await cf.get<{ id: string; name: string }[]>('/accounts')
    if (accounts.length === 0) throw new Error('token has no account access')
    const id =
      accounts.length === 1
        ? accounts[0]!.id
        : await choose('Cloudflare account', accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.id})` })))
    s.accountId = id
    s.accountName = accounts.find((a) => a.id === id)!.name
    saveState(s)
  }
  cf.accountId = s.accountId
  return cf
}

export async function analyticsToken(): Promise<string> {
  if (process.env.CF_ANALYTICS_TOKEN) return process.env.CF_ANALYTICS_TOKEN
  const url = analyticsTokenPageUrl()
  p.note(`The daily reconcile reads Analytics Engine with a separate read-only token\n(the Worker never holds your setup token).\n\n${url}`, 'Analytics token')
  openUrl(url)
  return secret('Analytics read token')
}

// ───────── resources ─────────

export async function ensureKv(cf: CF, title: string): Promise<string> {
  const list = await cf.all<{ id: string; title: string }>(`${cf.acct}/storage/kv/namespaces`)
  const hit = list.find((n) => n.title === title)
  if (hit) return hit.id
  return (await cf.post<{ id: string }>(`${cf.acct}/storage/kv/namespaces`, { title })).id
}

export async function ensureR2(cf: CF, name: string): Promise<string> {
  const r = await cf.get<{ buckets: { name: string }[] }>(`${cf.acct}/r2/buckets`)
  if (!r.buckets.some((b) => b.name === name)) await cf.post(`${cf.acct}/r2/buckets`, { name })
  return name
}

export type Origin = { host: string; port: number; database: string; user: string; password: string }

/** Create, or update the origin (new password) of, a Hyperdrive config. Caching is off: reads must be fresh. */
export async function ensureHyperdrive(cf: CF, name: string, origin: Origin): Promise<string> {
  const list = await cf.get<{ id: string; name: string }[]>(`${cf.acct}/hyperdrive/configs`)
  const body = { name, origin: { scheme: 'postgres', ...origin }, caching: { disabled: true } }
  const hit = list.find((h) => h.name === name)
  if (hit) {
    await cf.patch(`${cf.acct}/hyperdrive/configs/${hit.id}`, { origin: body.origin, caching: body.caching })
    return hit.id
  }
  return (await cf.post<{ id: string }>(`${cf.acct}/hyperdrive/configs`, body)).id
}

export async function findHyperdrive(cf: CF, name: string): Promise<string | undefined> {
  const list = await cf.get<{ id: string; name: string }[]>(`${cf.acct}/hyperdrive/configs`)
  return list.find((h) => h.name === name)?.id
}

export async function ensureQueue(cf: CF, name: string): Promise<string> {
  const list = await cf.get<{ queue_id: string; queue_name: string }[]>(`${cf.acct}/queues`)
  if (list.some((q) => q.queue_name === name)) return name
  await cf.post(`${cf.acct}/queues`, { queue_name: name, settings: { message_retention_period: 14 * 86400 } })
  return name
}

export async function kvPut(cf: CF, namespaceId: string, key: string, value: string) {
  await cf.client.put(`${cf.acct}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`, {
    body: value,
    headers: { 'content-type': 'text/plain' },
  } as never)
}

export async function kvDelete(cf: CF, namespaceId: string, key: string) {
  await cf.del(`${cf.acct}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`).catch(() => {})
}
