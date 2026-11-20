import { p, secret } from '../lib/ui.js'
import type { DsRecord, Registrar } from './types.js'

const API = 'https://api.porkbun.com/api/json/v3'

export class Porkbun implements Registrar {
  id = 'porkbun' as const
  private creds = { apikey: '', secretapikey: '' }

  async auth() {
    p.log.info('Create keys at https://porkbun.com/account/api and enable "API Access" on the domain')
    this.creds.apikey = await secret('Porkbun API key', 'PORKBUN_API_KEY')
    this.creds.secretapikey = await secret('Porkbun secret API key', 'PORKBUN_SECRET_API_KEY')
    await this.call('/ping')
  }

  private async call<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const r = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...this.creds, ...body }),
    })
    const j = (await r.json().catch(() => ({}))) as { status?: string; message?: string } & T
    if (!r.ok || j.status !== 'SUCCESS') throw new Error(`porkbun ${path}: ${r.status} ${j.message ?? ''}`)
    return j
  }

  async getNameservers(domain: string) {
    return (await this.call<{ ns: string[] }>(`/domain/getNs/${domain}`)).ns ?? []
  }

  async setNameservers(domain: string, ns: string[]) {
    await this.call(`/domain/updateNs/${domain}`, { ns })
  }

  private async dsRecords(domain: string) {
    const r = await this.call<{ records?: Record<string, { keyTag: string }> }>(`/dns/getDnssecRecords/${domain}`)
    return Object.values(r.records ?? {})
  }

  async getDnssec(domain: string) {
    return (await this.dsRecords(domain)).length > 0
  }

  async disableDnssec(domain: string) {
    for (const rec of await this.dsRecords(domain)) await this.call(`/dns/deleteDnssecRecord/${domain}/${rec.keyTag}`)
  }

  async addDs(domain: string, ds: DsRecord) {
    await this.call(`/dns/createDnssecRecord/${domain}`, {
      keyTag: String(ds.keyTag),
      alg: String(ds.algorithm),
      digestType: String(ds.digestType),
      digest: ds.digest,
    })
  }
}
