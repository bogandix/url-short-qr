import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyJwt } from '../src/lib/jwt.js'

const b64url = (b: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof b === 'string' ? b : new Uint8Array(b as ArrayBuffer)).toString('base64url')

async function setup() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'ES256' }
  const jwksUrl = `https://auth.example/${crypto.randomUUID()}/jwks.json`
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => (String(u) === jwksUrl ? Response.json({ keys: [jwk] }) : new Response('', { status: 404 })))
  const sign = async (claims: Record<string, unknown>, kid = 'k1') => {
    const h = b64url(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }))
    const p = b64url(JSON.stringify(claims))
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(`${h}.${p}`))
    return `${h}.${p}.${b64url(sig)}`
  }
  return { jwksUrl, sign }
}

const now = () => Math.floor(Date.now() / 1000)
const opts = (jwksUrl: string) => ({ jwksUrl, issuer: 'https://auth.example/v1', audience: 'authenticated' })
const good = { iss: 'https://auth.example/v1', aud: 'authenticated', email: 'a@b.example', exp: now() + 600 }

afterEach(() => vi.restoreAllMocks())

describe('verifyJwt', () => {
  it('accepts a valid ES256 token', async () => {
    const { jwksUrl, sign } = await setup()
    expect((await verifyJwt(await sign(good), opts(jwksUrl))).email).toBe('a@b.example')
  })
  it('rejects a tampered payload', async () => {
    const { jwksUrl, sign } = await setup()
    const [h, , s] = (await sign(good)).split('.')
    const forged = `${h}.${b64url(JSON.stringify({ ...good, email: 'evil@x.example' }))}.${s}`
    await expect(verifyJwt(forged, opts(jwksUrl))).rejects.toThrow(/signature/)
  })
  it('rejects unsigned (alg none), expired, wrong issuer and audience', async () => {
    const { jwksUrl, sign } = await setup()
    const none = `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(good))}.`
    await expect(verifyJwt(none, opts(jwksUrl))).rejects.toThrow()
    await expect(verifyJwt(await sign({ ...good, exp: now() - 120 }), opts(jwksUrl))).rejects.toThrow(/expired/)
    await expect(verifyJwt(await sign({ ...good, exp: undefined }), opts(jwksUrl))).rejects.toThrow(/expired/)
    await expect(verifyJwt(await sign({ ...good, iss: 'https://other/' }), opts(jwksUrl))).rejects.toThrow(/issuer/)
    await expect(verifyJwt(await sign({ ...good, aud: 'anon' }), opts(jwksUrl))).rejects.toThrow(/audience/)
    await expect(verifyJwt(await sign(good, 'unknown'), opts(jwksUrl))).rejects.toThrow(/kid/)
  })
})
