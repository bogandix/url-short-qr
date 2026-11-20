import { CODE_ALPHABET, CODE_ALPHABET_SET, RESERVED_CODES, VANITY_RE } from './alphabet.js'

/** Normalize a path segment into a code: uppercase, O→0, I/L→1, strip trailing slash. */
export function readCode(raw: string): string | null {
  let s = raw.trim()
  if (s.endsWith('/')) s = s.slice(0, -1)
  if (!s) return null
  s = s.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1')
  if (s.startsWith('_/') || s.startsWith('/_/')) return null
  if (RESERVED_CODES.has(s)) return null
  if (!VANITY_RE.test(s)) return null
  return s
}

export function isValidVanity(code: string): boolean {
  return VANITY_RE.test(code) && !RESERVED_CODES.has(code) && !code.startsWith('_')
}

/**
 * Random code from the QR alphabet. Uses rejection sampling so every character
 * is equally likely (256 is not a multiple of 33).
 */
export function generateCode(length: number, randomBytes: (n: number) => Uint8Array): string {
  const alphabet = CODE_ALPHABET
  const n = alphabet.length
  const limit = 256 - (256 % n) // 231: bytes >= limit are discarded
  let out = ''
  while (out.length < length) {
    const bytes = randomBytes(length * 2)
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      const b = bytes[i]!
      if (b < limit) out += alphabet[b % n]!
    }
  }
  return out
}

/** Smallest length >= minLength whose space is less than half used. `usedAt(len)` counts codes of that length. */
export async function pickCodeLength(
  minLength: number,
  usedAt: (len: number) => Promise<number>,
): Promise<number> {
  let len = minLength
  while (len < 32 && nextLengthWhenHalfFull(len, await usedAt(len)) > len) len++
  return len
}

export function nextLengthWhenHalfFull(length: number, used: number): number {
  const space = CODE_ALPHABET.length ** length
  if (used >= space * 0.5) return length + 1
  return length
}

export function allCharsValid(code: string): boolean {
  for (const ch of code) {
    if (ch === '-') continue
    if (!CODE_ALPHABET_SET.has(ch)) return false
  }
  return true
}

/**
 * The canonical short URL, all capitals: HTTPS://VV1.EU/A7K2. Scheme and host are
 * case-insensitive and codes are read case-insensitively, so it works as typed, and
 * it keeps QR codes in alphanumeric mode (one version smaller than mixed case).
 */
export function shortUrl(host: string, code: string): string {
  return `HTTPS://${host.toUpperCase()}/${code.toUpperCase()}`
}
