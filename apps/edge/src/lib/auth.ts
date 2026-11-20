import type { Env } from '../env.js'
import { adminSqlClient, withSql } from './db.js'
import { verifyJwt } from './jwt.js'

export type AuthContext = {
  actor: string
  scopes: string[]
  ownerPrefix: string | null
  namespaces: string[] | null
}

export const ALL_SCOPES = ['links:read', 'links:write', 'stats:read', 'domains:admin', 'keys:admin'] as const

const CACHE_MS = 60_000
const keyCache = new Map<string, { at: number; ctx: AuthContext | null }>()
const adminCache = new Map<string, { at: number; ok: boolean }>()

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function authenticate(req: Request, env: Env, ctx?: ExecutionContext): Promise<AuthContext | null> {
  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice(7).trim()
  if (!token) return null

  if (token.startsWith('sk_live_')) return authApiKey(token, env, ctx)
  if (env.ADMIN_JWKS_URL) return authJwt(token, env)
  return null
}

async function authApiKey(token: string, env: Env, ctx?: ExecutionContext): Promise<AuthContext | null> {
  const hash = await sha256Hex(token)
  const cached = keyCache.get(hash)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.ctx

  const row = await withSql(
    () => adminSqlClient(env),
    async (sql) => {
      const rows = await sql<{ id: string; name: string; scopes: string[]; owner_prefix: string | null; namespaces: string[] | null }[]>`
        select id, name, scopes, owner_prefix, namespaces
        from shortener.api_keys
        where key_hash = ${hash} and revoked_at is null
        limit 1`
      const r = rows[0]
      if (r) {
        const touch = sql`update shortener.api_keys set last_used_at = now() where id = ${r.id}::uuid`.then(() => {})
        if (ctx) ctx.waitUntil(touch.catch(() => {}))
        else await touch.catch(() => {})
      }
      return r
    },
  )
  const auth: AuthContext | null = row
    ? { actor: `key:${row.name}`, scopes: row.scopes, ownerPrefix: row.owner_prefix, namespaces: row.namespaces }
    : null
  keyCache.set(hash, { at: Date.now(), ctx: auth })
  return auth
}

async function authJwt(token: string, env: Env): Promise<AuthContext | null> {
  let email: string
  try {
    const claims = await verifyJwt(token, {
      jwksUrl: env.ADMIN_JWKS_URL!,
      issuer: env.OIDC_ISSUER,
      audience: env.OIDC_AUDIENCE,
    })
    if (typeof claims.email !== 'string' || !claims.email) return null
    email = claims.email.toLowerCase()
  } catch {
    return null
  }

  const hit = adminCache.get(email)
  let ok: boolean
  if (hit && Date.now() - hit.at < CACHE_MS) ok = hit.ok
  else {
    ok = await withSql(
      () => adminSqlClient(env),
      async (sql) => (await sql`select 1 from shortener.admins where email = ${email} limit 1`).length > 0,
    )
    adminCache.set(email, { at: Date.now(), ok })
  }
  if (!ok) return null
  return { actor: `admin:${email}`, scopes: [...ALL_SCOPES], ownerPrefix: null, namespaces: null }
}

export function requireScope(ctx: AuthContext, scope: string): boolean {
  return ctx.scopes.includes(scope) || ctx.scopes.includes('*')
}

/** Key restrictions: optional namespace allow-list and owner prefix. */
export function canAccess(ctx: AuthContext, namespace: string, owner: string | null | undefined): boolean {
  if (ctx.namespaces && ctx.namespaces.length > 0 && !ctx.namespaces.includes(namespace)) return false
  if (ctx.ownerPrefix && !(owner ?? '').startsWith(ctx.ownerPrefix)) return false
  return true
}

export function clearAuthCaches(): void {
  keyCache.clear()
  adminCache.clear()
}
