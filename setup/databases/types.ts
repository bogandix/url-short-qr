import type { DatabaseId } from '../lib/state.js'

export type Provisioned = {
  /** Pooled/proxied connection string Hyperdrive should use (credentials are replaced per role). */
  poolerUrl: string
  /** Owner/admin connection for migrations; may be '' when runSql goes through a management API. */
  adminUrl: string
}

export interface Database {
  id: DatabaseId
  auth(): Promise<void>
  provision(opts: { region: string }): Promise<Provisioned>
  runSql(sql: string): Promise<Record<string, unknown>[]>
  /** Connection string for one of our roles, through the pooler. */
  roleUrl(role: 'shortener_edge' | 'shortener_admin', password: string): string
  /** Remove the schema from any REST layer (Supabase PostgREST). */
  hideSchema?(): Promise<void>
  /** Admin UI login: JWKS URL + issuer/audience (Supabase Auth). */
  jwks?(): Promise<{ jwksUrl: string; issuer: string; audience: string; supabaseUrl?: string; anonKey?: string }>
  /** Create/ensure a login user for an admin email (Supabase Auth). */
  ensureAuthUser?(email: string, tempPassword?: string): Promise<void>
  storageQuotaBytes?: number
  /** Saved into state (non-secret identifiers). */
  stateInfo(): Record<string, string | undefined>
  destroy?(): Promise<void>
}

export function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url)
  u.username = encodeURIComponent(user)
  u.password = encodeURIComponent(password)
  return u.toString()
}

export function parsePgUrl(url: string) {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  }
}
