import postgres from 'postgres'
import { ask, secret } from '../lib/ui.js'
import { parsePgUrl, withCredentials, type Database, type Provisioned } from './types.js'

/** Any Postgres reachable from Cloudflare (Hyperdrive) and from this machine (migrations). */
export class PostgresUrl implements Database {
  id = 'postgres-url' as const
  private adminUrl = ''
  private poolerUrl = ''

  async auth() {
    this.adminUrl = await secret('Admin connection string (owner of the database, used for migrations)', 'SHORTENER_DATABASE_URL')
    parsePgUrl(this.adminUrl)
  }

  async provision(): Promise<Provisioned> {
    const host = await ask('Host:port Hyperdrive should connect to (blank = same as admin URL)', { placeholder: 'db.example.com:5432' })
    const base = new URL(this.adminUrl)
    if (host) {
      const [h, p] = host.split(':')
      base.hostname = h!
      base.port = p ?? '5432'
    }
    this.poolerUrl = base.toString()
    return { poolerUrl: this.poolerUrl, adminUrl: this.adminUrl }
  }

  async runSql(text: string) {
    const sql = postgres(this.adminUrl, { max: 1, onnotice: () => {} })
    try {
      return [...(await sql.unsafe(text))] as Record<string, unknown>[]
    } finally {
      await sql.end({ timeout: 5 })
    }
  }

  roleUrl(role: string, password: string) {
    return withCredentials(this.poolerUrl || this.adminUrl, role, password)
  }

  stateInfo() {
    return { host: parsePgUrl(this.poolerUrl || this.adminUrl).host }
  }
}
