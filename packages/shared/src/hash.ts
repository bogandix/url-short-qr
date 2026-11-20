/** Hex HMAC-SHA256 helpers used for ip_hash / visitor_hash. */

export async function hmacSha256Hex(
  key: ArrayBuffer | Uint8Array | string,
  message: string,
): Promise<string> {
  const keyBytes: Uint8Array<ArrayBuffer> =
    typeof key === 'string' ? new TextEncoder().encode(key) : new Uint8Array(key) // copy: plain ArrayBuffer

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function daySalt(secretSalt: string, day: string): Promise<string> {
  return hmacSha256Hex(secretSalt, day)
}

export async function ipHash(secretSalt: string, day: string, ip: string): Promise<string> {
  const salt = await daySalt(secretSalt, day)
  const full = await hmacSha256Hex(salt, ip)
  return full.slice(0, 32)
}

export async function visitorHash(
  secretSalt: string,
  day: string,
  ip: string,
  ua: string,
  lang: string,
): Promise<string> {
  const salt = await daySalt(secretSalt, day)
  const full = await hmacSha256Hex(salt, `${ip}|${ua}|${lang}`)
  return full.slice(0, 32)
}

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}
