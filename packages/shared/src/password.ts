/**
 * Password hashing for the built-in admin login: PBKDF2-SHA256 via WebCrypto
 * (works in Workers and Node). 100,000 iterations is the Workers maximum.
 * Format: pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>
 */
const ITER = 100_000

const b64u = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64u = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256))
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2-sha256$${ITER}$${b64u(salt)}$${b64u(await derive(password, salt, ITER))}`
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? '').split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') {
    await derive(password, new Uint8Array(16), ITER) // same cost when there is no hash
    return false
  }
  const iter = Number(parts[1])
  if (!Number.isInteger(iter) || iter < 10_000 || iter > ITER) return false
  const want = unb64u(parts[3]!)
  const got = await derive(password, new Uint8Array(unb64u(parts[2]!)), iter)
  if (got.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got[i]! ^ want[i]!
  return diff === 0
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < 12) return 'at least 12 characters'
  if (pw.length > 200) return 'at most 200 characters'
  return null
}
