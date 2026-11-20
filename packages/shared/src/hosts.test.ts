import { describe, expect, it } from 'vitest'
import { resolveHost, type DomainRow } from './hosts.js'

const base = (over: Partial<DomainRow> & { apex: string }): DomainRow => ({
  id: '1',
  zone_id: null,
  registrar: null,
  serve_www: true,
  wildcard: false,
  wildcard_mode: 'namespace',
  home_url: null,
  not_found_url: null,
  code_length: 4,
  is_admin_host: false,
  status: 'active',
  ...over,
})

describe('resolveHost', () => {
  it('matches apex and strips www', () => {
    const domains = [base({ apex: 'short.example', is_admin_host: true })]
    const a = resolveHost('SHORT.EXAMPLE', domains)
    expect(a.kind).toBe('ok')
    if (a.kind === 'ok') {
      expect(a.namespace).toBe('short.example')
      expect(a.isAdminHost).toBe(true)
    }
    const w = resolveHost('www.short.example', domains)
    expect(w.kind).toBe('ok')
    if (w.kind === 'ok') expect(w.namespace).toBe('short.example')
  })

  it('wildcard namespace vs alias', () => {
    const domains = [
      base({ apex: 'short.example', wildcard: true, wildcard_mode: 'namespace' }),
    ]
    const n = resolveHost('acme.short.example', domains)
    expect(n.kind).toBe('ok')
    if (n.kind === 'ok') expect(n.namespace).toBe('acme.short.example')

    domains[0]!.wildcard_mode = 'alias'
    const al = resolveHost('acme.short.example', domains)
    expect(al.kind).toBe('ok')
    if (al.kind === 'ok') expect(al.namespace).toBe('short.example')
  })

  it('unknown host is invalid but namespaced', () => {
    const domains = [base({ apex: 'short.example' })]
    const u = resolveHost('other.example', domains)
    expect(u.kind).toBe('invalid')
  })
})
