import { p, secret } from '../lib/ui.js'
import { RegistrarUnavailable, type Registrar } from './types.js'

/**
 * GoDaddy restricts its production API to larger accounts; any 401/403 makes the
 * wizard fall back to manual steps. DS records are printed (v2 DNSSEC API needs a
 * customer id and is not used here).
 */
export class GoDaddy implements Registrar {
  id = 'godaddy' as const
  private auth_ = ''

  async auth() {
    p.log.info('Create a Production API key at https://developer.godaddy.com/keys')
    const key = await secret('GoDaddy API key', 'GODADDY_API_KEY')
    const sec = await secret('GoDaddy API secret', 'GODADDY_API_SECRET')
    this.auth_ = `sso-key ${key}:${sec}`
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`https://api.godaddy.com${path}`, {
      method,
      headers: { authorization: this.auth_, 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (r.status === 401 || r.status === 403) throw new RegistrarUnavailable(`GoDaddy API refused (${r.status})`)
    const text = await r.text()
    if (!r.ok) throw new Error(`godaddy ${method} ${path}: ${r.status} ${text.slice(0, 300)}`)
    return (text ? JSON.parse(text) : null) as T
  }

  async getNameservers(domain: string) {
    const d = await this.call<{ nameServers?: string[] }>('GET', `/v1/domains/${encodeURIComponent(domain)}`)
    return d.nameServers ?? []
  }

  async setNameservers(domain: string, ns: string[]) {
    await this.call('PATCH', `/v1/domains/${encodeURIComponent(domain)}`, { nameServers: ns })
  }
}
