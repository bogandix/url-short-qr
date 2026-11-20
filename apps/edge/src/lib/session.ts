/**
 * Admin UI sessions for the built-in password login: compact HS256 JWTs signed
 * with a key derived from SECRET_SALT (no extra secret to manage).
 */
import type { Env } from '../env.js'

export const SESSION_TTL_S = 12 * 3600

export type SessionClaims = { typ: 'adm'; sub: string; ep: number; mc: boolean; iat: number; exp: number }

const enc = new TextEncoder()
const b64u = (b: Uint8Array | string) =>
  btoa(typeof b === 'string' ? b : String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64u = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))

let cached: { salt: string; key: CryptoKey } | null = null

async function key(env: Env): Promise<CryptoKey> {
  const salt = env.SECRET_SALT
  if (!salt) throw new Error('SECRET_SALT not set')
  if (cached?.salt === salt) return cached.key
  const base = await crypto.subtle.importKey('raw', enc.encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const derived = new Uint8Array(await crypto.subtle.sign('HMAC', base, enc.encode('admin-session-v1')))
  const k = await crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  cached = { salt, key: k }
  return k
}

export async function issueSession(env: Env, email: string, epoch: number, mustChange: boolean): Promise<{ token: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000)
  const claims: SessionClaims = { typ: 'adm', sub: email, ep: epoch, mc: mustChange, iat: now, exp: now + SESSION_TTL_S }
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64u(JSON.stringify(claims))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), enc.encode(`${head}.${body}`)))
  return { token: `${head}.${body}.${b64u(sig)}`, exp: claims.exp }
}

/** Returns claims for a valid, unexpired session token; null for anything else (incl. other JWTs). */
export async function readSession(env: Env, token: string): Promise<SessionClaims | null> {
  const parts = token.split('.')
  if (parts.length !== 3 || !env.SECRET_SALT) return null
  try {
    const head = JSON.parse(unb64u(parts[0]!)) as { alg?: string }
    if (head.alg !== 'HS256') return null
    const sig = Uint8Array.from(unb64u(parts[2]!), (c) => c.charCodeAt(0))
    const ok = await crypto.subtle.verify('HMAC', await key(env), sig, enc.encode(`${parts[0]}.${parts[1]}`))
    if (!ok) return null
    const c = JSON.parse(unb64u(parts[1]!)) as SessionClaims
    if (c.typ !== 'adm' || typeof c.sub !== 'string' || c.exp < Date.now() / 1000) return null
    return c
  } catch {
    return null
  }
}
