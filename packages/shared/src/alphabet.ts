/** QR-friendly alphabet: 33 chars, no I/L/O (maps cleanly to alphanumeric mode). */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTUVWXYZ' as const

export const CODE_ALPHABET_SET = new Set(CODE_ALPHABET.split(''))

export const RESERVED_CODES = new Set([
  'ROBOTS.TXT',
  'FAVICON.ICO',
  'SITEMAP.XML',
  '.WELL-KNOWN',
])

export const VANITY_RE = /^[0-9A-Z-]{2,32}$/

export function spaceAtLength(length: number): number {
  return CODE_ALPHABET.length ** length
}
