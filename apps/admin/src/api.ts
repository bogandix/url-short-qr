/** Session token: a Supabase access token (JWT) or an API key pasted at login. */
const KEY = 'shortener.session'

export type Session = { token: string; refresh?: string; exp?: number; email?: string; kind: 'jwt' | 'key'; mustChange?: boolean }
export type AuthConfig = { provider: 'supabase'; url: string; anon_key: string; password?: boolean } | { provider: 'api_key' }

function read(): Session | null {
  try {
    const s = sessionStorage.getItem(KEY)
    return s ? (JSON.parse(s) as Session) : null
  } catch {
    return null
  }
}

let session: Session | null = read()
let config: AuthConfig | null = null
const listeners = new Set<() => void>()

export function getSession() {
  return session
}
export function onSession(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function setSession(s: Session | null) {
  session = s
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s))
    else sessionStorage.removeItem(KEY)
  } catch {
    /* private mode: session lives in memory only */
  }
  listeners.forEach((f) => f())
}

export async function authConfig(): Promise<AuthConfig> {
  if (config) return config
  const r = await fetch('/_/api/config')
  config = ((await r.json()) as { auth: AuthConfig }).auth
  return config
}

async function supabase(path: string, body: unknown, opts: { method?: string; token?: string } = {}) {
  const cfg = (await authConfig()) as Extract<AuthConfig, { provider: 'supabase' }>
  const r = await fetch(`${cfg.url}/auth/v1/${path}`, {
    method: opts.method ?? 'POST',
    headers: { apikey: cfg.anon_key, 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.msg || j.error_description || j.message || `HTTP ${r.status}`)
  return j
}

export async function sendOtp(email: string) {
  await supabase('otp', { email, create_user: false })
}

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number; user?: { email?: string; user_metadata?: { must_change_password?: boolean } } }

function sessionFrom(j: TokenResponse, email: string): Session {
  return {
    kind: 'jwt',
    token: j.access_token,
    refresh: j.refresh_token,
    exp: Date.now() + j.expires_in * 1000,
    email: j.user?.email ?? email,
    mustChange: !!j.user?.user_metadata?.must_change_password,
  }
}

export async function verifyOtp(email: string, token: string) {
  setSession(sessionFrom(await supabase('verify', { type: 'email', email, token }), email))
}

export async function passwordLogin(email: string, password: string) {
  setSession(sessionFrom(await supabase('token?grant_type=password', { email, password }), email))
}

/** Sets a new password and clears the temporary-password flag. */
export async function changePassword(password: string) {
  const s = session
  if (!s || s.kind !== 'jwt') throw new Error('not signed in')
  await supabase('user', { password, data: { must_change_password: false } }, { method: 'PUT', token: s.token })
  setSession({ ...s, mustChange: false })
}

async function freshToken(): Promise<string | null> {
  const s = session
  if (!s) return null
  if (s.kind === 'jwt' && s.refresh && s.exp && s.exp - Date.now() < 60_000) {
    try {
      const j = await supabase('token?grant_type=refresh_token', { refresh_token: s.refresh })
      setSession({ ...s, token: j.access_token, refresh: j.refresh_token, exp: Date.now() + j.expires_in * 1000 })
    } catch {
      setSession(null)
      return null
    }
  }
  return session?.token ?? null
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(typeof body === 'object' && body && 'error' in body ? String((body as { error: string }).error) : `HTTP ${status}`)
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const token = await freshToken()
  const headers = new Headers(init.headers)
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (init.json !== undefined) headers.set('content-type', 'application/json')
  const r = await fetch(`/_/api${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body })
  const body = await r.json().catch(() => null)
  if (r.status === 401) setSession(null)
  if (!r.ok) throw new ApiError(r.status, body)
  return body as T
}

export type Link = {
  id: string
  namespace: string
  code: string
  target_url: string
  title: string | null
  tags: string[]
  owner: string | null
  status: 'active' | 'paused' | 'archived'
  expires_at: string | null
  fallback_url: string | null
  utm: Record<string, string>
  append_utm: boolean
  version: number
  created_at: string
  updated_at: string
  short_url: string
  qr: { svg: string; png: string; payload: string }
}

export type Domain = {
  id: string
  apex: string
  serve_www: boolean
  wildcard: boolean
  wildcard_mode: 'namespace' | 'alias'
  home_url: string | null
  not_found_url: string | null
  code_length: number
  is_admin_host: boolean
  status: 'active' | 'pending_ns' | 'disabled'
}
