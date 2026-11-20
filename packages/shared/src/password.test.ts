import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password.js'

describe('password hashing', () => {
  it('verifies the right password only, with a fresh salt each time', async () => {
    const h = await hashPassword('correct horse battery')
    expect(h).toMatch(/^pbkdf2-sha256\$100000\$/)
    expect(await verifyPassword('correct horse battery', h)).toBe(true)
    expect(await verifyPassword('wrong', h)).toBe(false)
    expect(await hashPassword('correct horse battery')).not.toBe(h)
    expect(await verifyPassword('x', null)).toBe(false)
    expect(await verifyPassword('x', 'pbkdf2-sha256$1$a$b')).toBe(false)
  })
})
