import { describe, expect, it } from 'vitest'
import { generateCode, nextLengthWhenHalfFull, readCode } from './codes.js'
import { CODE_ALPHABET } from './alphabet.js'

describe('readCode', () => {
  it('uppercases and maps lookalikes', () => {
    expect(readCode('a7k2')).toBe('A7K2')
    expect(readCode('o1il')).toBe('0111')
    expect(readCode('ABC/')).toBe('ABC')
  })

  it('accepts one-character codes', () => {
    expect(readCode('a')).toBe('A')
    expect(readCode('o')).toBe('0')
  })

  it('rejects reserved and invalid', () => {
    expect(readCode('robots.txt')).toBeNull()
    expect(readCode('_/api')).toBeNull()
  })
})

describe('generateCode', () => {
  it('uses alphabet length', () => {
    const code = generateCode(4, (n) => new Uint8Array(n).fill(1))
    expect(code).toHaveLength(4)
    for (const ch of code) expect(CODE_ALPHABET.includes(ch)).toBe(true)
  })

  it('bumps length at half capacity', () => {
    expect(nextLengthWhenHalfFull(4, CODE_ALPHABET.length ** 4 * 0.5)).toBe(5)
    expect(nextLengthWhenHalfFull(4, 10)).toBe(4)
  })
})
