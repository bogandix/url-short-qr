import postgres from 'postgres'
import { ask, secret, sleep } from '../lib/ui.js'
import { withCredentials, type Database, type Provisioned } from './types.js'

const API = 'https://console.neon.tech/api/v2'

/** Neon: Hyperdrive pools connections itself, so it connects to the direct (non -pooler) host. */
export class Neon implements Database {
  id = 'neon' as const
  storageQuotaBytes = 512 * 1024 * 1024
  private key = ''
  private projectId?: string
  private ownerUrl = ''

  constructor(existing?: { projectId?: string }) {
    this.projectId = existing?.projectId
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!r.ok) throw new Error(`neon ${method} ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`)
    return (await r.json()) as T
  }

  async auth() {
    this.key = await secret('Neon API key', 'NEON_API_KEY')
    await this.call('GET', '/projects?limit=1')
  }

  async provision({ region }: { region: string }): Promise<Provisioned> {
    if (!this.projectId) {
      const r = await this.call<{ project: { id: string }; connection_uris: { connection_uri: string }[] }>('POST', '/projects', {
        project: { name: 'shortener', region_id: region, pg_version: 17 },
      })
      this.projectId = r.project.id
      this.ownerUrl = r.connection_uris[0]!.connection_uri
    } else {
      const roleName = await ask('Neon owner role', { initial: 'neondb_owner' })
      const r = await this.call<{ uri: string }>(
        'GET',
        `/projects/${this.projectId}/connection_uri?database_name=neondb&role_name=${encodeURIComponent(roleName)}&pooled=false`,
      )
      this.ownerUrl = r.uri
    }
    for (let i = 0; i < 30; i++) {
      try {
        await this.runSql('select 1')
        break
      } catch {
        await sleep(2000)
      }
    }
    return { poolerUrl: this.ownerUrl, adminUrl: this.ownerUrl }
  }

  async runSql(text: string) {
    const sql = postgres(this.ownerUrl, { max: 1, ssl: 'require', onnotice: () => {} })
    try {
      return [...(await sql.unsafe(text))] as Record<string, unknown>[]
    } finally {
      await sql.end({ timeout: 5 })
    }
  }

  roleUrl(role: string, password: string) {
    return withCredentials(this.ownerUrl, role, password)
  }

  stateInfo() {
    return { projectId: this.projectId, host: this.ownerUrl ? new URL(this.ownerUrl).hostname : undefined }
  }

  async destroy() {
    if (this.projectId) await this.call('DELETE', `/projects/${this.projectId}`)
  }
}
