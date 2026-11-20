/** Minimal JWS verification against a JWKS (RS256 / ES256), using WebCrypto only. */

type Jwk = JsonWebKey & { kid?: string; alg?: string }

const jwksCache = new Map<string, { at: number; keys: Jwk[] }>()
const JWKS_TTL_MS = 10 * 60_000

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function b64urlJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T
}

async function fetchJwks(url: string, force = false): Promise<Jwk[]> {
  const hit = jwksCache.get(url)
  if (!force && hit && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`jwks ${res.status}`)
  const body = (await res.json()) as { keys?: Jwk[] }
  const keys = body.keys ?? []
  jwksCache.set(url, { at: Date.now(), keys })
  return keys
}

function importParams(alg: string): { imp: RsaHashedImportParams | EcKeyImportParams; ver: AlgorithmIdentifier | EcdsaParams } {
  switch (alg) {
    case 'RS256':
      return { imp: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, ver: { name: 'RSASSA-PKCS1-v1_5' } }
    case 'ES256':
      return { imp: { name: 'ECDSA', namedCurve: 'P-256' }, ver: { name: 'ECDSA', hash: 'SHA-256' } }
    default:
      throw new Error(`unsupported alg ${alg}`)
  }
}

export type JwtClaims = {
  iss?: string
  aud?: string | string[]
  exp?: number
  nbf?: number
  sub?: string
  email?: string
  [k: string]: unknown
}

export async function verifyJwt(
  token: string,
  opts: { jwksUrl: string; issuer?: string; audience?: string; now?: number },
): Promise<JwtClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed')
  const [h, p, s] = parts as [string, string, string]
  const header = b64urlJson<{ alg: string; kid?: string }>(h)
  const claims = b64urlJson<JwtClaims>(p)
  const { imp, ver } = importParams(header.alg)

  let keys = await fetchJwks(opts.jwksUrl)
  let jwk = keys.find((k) => !header.kid || k.kid === header.kid)
  if (!jwk) {
    keys = await fetchJwks(opts.jwksUrl, true) // key rotation
    jwk = keys.find((k) => !header.kid || k.kid === header.kid)
  }
  if (!jwk) throw new Error('unknown kid')

  const key = await crypto.subtle.importKey('jwk', jwk, imp, false, ['verify'])
  const ok = await crypto.subtle.verify(ver, key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`))
  if (!ok) throw new Error('bad signature')

  const now = Math.floor((opts.now ?? Date.now()) / 1000)
  if (typeof claims.exp !== 'number' || claims.exp < now - 30) throw new Error('expired')
  if (typeof claims.nbf === 'number' && claims.nbf > now + 30) throw new Error('not yet valid')
  if (opts.issuer && claims.iss !== opts.issuer) throw new Error('bad issuer')
  if (opts.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.includes(opts.audience)) throw new Error('bad audience')
  }
  return claims
}
