/** SQL literal for values sent through text-only channels (management APIs). standard_conforming_strings is on. */
export function lit(v: string | number | boolean | null | undefined): string {
  if (v == null) return 'null'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('bad number')
    return String(v)
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (v.includes('\0')) throw new Error('NUL in literal')
  return `'${v.replace(/'/g, "''")}'`
}

export const APEX_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
export const EMAIL_RE = /^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Buffer.from(buf).toString('hex')
}

export function newApiKey(): string {
  return `sk_live_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex')}`
}
