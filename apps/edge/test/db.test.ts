import { describe, expect, it } from 'vitest'
import { parsePgArray, pgArray } from '../src/lib/db.js'

describe('text[] codec', () => {
  it('round-trips awkward values', () => {
    const v = ['a', 'b c', 'q"uote', 'back\\slash', 'comma,inside', '{brace}', '', 'NULL']
    expect(parsePgArray(pgArray(v)!)).toEqual(v)
  })
  it('parses server output', () => {
    expect(parsePgArray('{}')).toEqual([])
    expect(parsePgArray('{links:read,stats:read}')).toEqual(['links:read', 'stats:read'])
    expect(parsePgArray('{"a b",NULL,c}')).toEqual(['a b', null, 'c'])
  })
})
