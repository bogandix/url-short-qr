import { ask, choose, p, randomSecret, secret, sleep, task } from '../lib/ui.js'
import { withCredentials, type Database, type Provisioned } from './types.js'

const API = 'https://api.supabase.com/v1'

/**
 * Supabase via the Management API (personal access token). SQL runs through
 * /database/query, so no direct database connection is needed from this machine.
 * Hyperdrive connects through the Supavisor pooler in session mode (port 5432).
 */
export class Supabase implements Database {
  id = 'supabase' as const
  storageQuotaBytes = 500 * 1024 * 1024
  private token = ''
  ref?: string
  private pooler?: { host: string; port: number; db: string }
  private keys?: { anon: string; service: string }

  constructor(existing?: { projectRef?: string }) {
    this.ref = existing?.projectRef
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (r.status === 429 && attempt < 5) {
        await sleep(2000 * (attempt + 1))
        continue
      }
      const text = await r.text()
      if (!r.ok) throw new Error(`supabase ${method} ${path}: ${r.status} ${text.slice(0, 400)}`)
      return (text ? JSON.parse(text) : null) as T
    }
  }

  async auth() {
    p.log.info('Create a personal access token at https://supabase.com/dashboard/account/tokens')
    this.token = await secret('Supabase access token', 'SUPABASE_ACCESS_TOKEN')
    await this.call('GET', '/organizations')
  }

  async provision({ region }: { region: string }): Promise<Provisioned> {
    if (!this.ref) {
      const projects = await this.call<{ id: string; name: string; region: string }[]>('GET', '/projects')
      const pick = await choose(
        'Supabase project',
        [
          { value: '__new', label: 'Create a new project "shortener" (recommended: a dedicated project)' },
          ...projects.map((x) => ({ value: x.id, label: `${x.name} (${x.id}, ${x.region})` })),
        ],
        '__new',
      )
      if (pick === '__new') {
        const orgs = await this.call<{ id: string; name: string }[]>('GET', '/organizations')
        const org = orgs.length === 1 ? orgs[0]!.id : await choose('Organization', orgs.map((o) => ({ value: o.id, label: o.name })))
        const created = await this.call<{ id: string }>('POST', '/projects', {
          name: 'shortener',
          organization_id: org,
          region,
          db_pass: randomSecret(24), // owner password is never needed again: SQL goes through the API
        })
        this.ref = created.id
      } else this.ref = pick
    }
    await task('Waiting for the Supabase project to be healthy', async () => {
      for (let i = 0; i < 120; i++) {
        const proj = await this.call<{ status: string }>('GET', `/projects/${this.ref}`)
        if (proj.status === 'ACTIVE_HEALTHY') return
        await sleep(5000)
      }
      throw new Error('project did not become healthy in 10 minutes')
    })
    const poolers = await this.call<{ db_host: string; db_port: number; db_name: string; pool_mode: string }[]>(
      'GET',
      `/projects/${this.ref}/config/database/pooler`,
    )
    const pool = poolers.find((x) => x.pool_mode === 'session') ?? poolers[0]
    if (!pool) throw new Error('no pooler config returned')
    this.pooler = { host: pool.db_host, port: 5432, db: pool.db_name || 'postgres' } // 5432 = session mode
    return { poolerUrl: `postgres://u:p@${this.pooler.host}:${this.pooler.port}/${this.pooler.db}`, adminUrl: '' }
  }

  async runSql(query: string) {
    const rows = await this.call<Record<string, unknown>[] | null>('POST', `/projects/${this.ref}/database/query`, { query })
    return Array.isArray(rows) ? rows : []
  }

  roleUrl(role: string, password: string) {
    if (!this.pooler) throw new Error('provision first')
    // Supavisor routes custom roles as "<role>.<project-ref>"
    return withCredentials(`postgres://x@${this.pooler.host}:${this.pooler.port}/${this.pooler.db}`, `${role}.${this.ref}`, password)
  }

  async hideSchema() {
    const cfg = await this.call<{ db_schema: string }>('GET', `/projects/${this.ref}/postgrest`)
    const schemas = cfg.db_schema.split(',').map((s) => s.trim()).filter((s) => s && s !== 'shortener')
    if (schemas.join(',') !== cfg.db_schema) {
      await this.call('PATCH', `/projects/${this.ref}/postgrest`, { db_schema: schemas.join(',') || 'public' })
    }
  }

  private async apiKeys() {
    if (this.keys) return this.keys
    const keys = await this.call<{ name: string; api_key: string }[]>('GET', `/projects/${this.ref}/api-keys?reveal=true`)
    const anon = keys.find((k) => k.name === 'anon')?.api_key
    const service = keys.find((k) => k.name === 'service_role')?.api_key
    if (!anon || !service) throw new Error('could not read project API keys')
    this.keys = { anon, service }
    return this.keys
  }

  async jwks() {
    const url = `https://${this.ref}.supabase.co`
    const { anon } = await this.apiKeys()
    // Email OTP: make the magic-link email carry the 6-digit code; no public sign-ups.
    await this.call('PATCH', `/projects/${this.ref}/config/auth`, {
      disable_signup: true,
      mailer_otp_exp: 600,
      mailer_subjects_magic_link: 'Your shortener sign-in code',
      mailer_templates_magic_link_content: '<p>Your sign-in code is <strong>{{ .Token }}</strong>. It expires in 10 minutes.</p>',
    })
    return {
      jwksUrl: `${url}/auth/v1/.well-known/jwks.json`,
      issuer: `${url}/auth/v1`,
      audience: 'authenticated',
      supabaseUrl: url,
      anonKey: anon,
    }
  }

  async ensureAuthUser(email: string) {
    const { service } = await this.apiKeys()
    const r = await fetch(`https://${this.ref}.supabase.co/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: service, authorization: `Bearer ${service}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, email_confirm: true }),
    })
    if (!r.ok && r.status !== 422) throw new Error(`create auth user: ${r.status} ${(await r.text()).slice(0, 200)}`)
  }

  stateInfo() {
    return { projectRef: this.ref, host: this.pooler?.host }
  }

  async destroy() {
    if (!this.ref) return
    const confirm = await ask(`Type the project ref (${this.ref}) to delete the Supabase project`)
    if (confirm !== this.ref) throw new Error('not confirmed')
    await this.call('DELETE', `/projects/${this.ref}`)
  }
}
