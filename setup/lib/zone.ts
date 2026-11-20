import { CF, errStatus, isNotFound } from './cf.js'

export type Zone = { id: string; name: string; status: string; name_servers: string[]; type: string; account: { id: string } }

export async function findZone(cf: CF, apex: string): Promise<Zone | undefined> {
  const list = await cf.get<Zone[]>('/zones', { name: apex, 'account.id': cf.accountId })
  return list[0]
}

export async function ensureZone(cf: CF, apex: string): Promise<Zone> {
  const found = await findZone(cf, apex)
  if (found) {
    if (found.type !== 'full') throw new Error(`${apex} is a "${found.type}" zone; a full zone is required (partial/CNAME setup is Business plan only)`)
    return found
  }
  return cf.post<Zone>('/zones', { account: { id: cf.accountId }, name: apex, type: 'full' })
}

/** §4 zone settings. HSTS is fine: browsers upgrade http:// locally after the first (logged) visit. */
export async function applyZoneSettings(cf: CF, zoneId: string, opts: { wildcard: boolean }) {
  await cf.patch(`/zones/${zoneId}/settings/always_use_https`, { value: 'off' })
  await cf.patch(`/zones/${zoneId}/settings/always_online`, { value: 'off' })
  await cf.patch(`/zones/${zoneId}/settings/security_header`, {
    value: {
      strict_transport_security: { enabled: true, max_age: 15552000, include_subdomains: opts.wildcard, nosniff: true, preload: false },
    },
  })
}

export type DriftItem = { ok: boolean; check: string; detail?: string }

const FORBIDDEN_PHASES = [
  ['http_request_dynamic_redirect', 'Redirect Rules'],
  ['http_request_cache_settings', 'Cache Rules'],
] as const

/** Everything doctor checks on a zone (also used by domain:add after applying settings). */
export async function zoneDrift(cf: CF, zoneId: string, opts: { wildcard: boolean; apex: string }): Promise<DriftItem[]> {
  const out: DriftItem[] = []
  const setting = async (id: string) => (await cf.get<{ value: unknown }>(`/zones/${zoneId}/settings/${id}`)).value

  const zone = await cf.get<Zone>(`/zones/${zoneId}`)
  out.push({ ok: zone.status === 'active', check: 'zone active', detail: zone.status })

  const auh = await setting('always_use_https')
  out.push({ ok: auh === 'off', check: 'Always Use HTTPS is off', detail: String(auh) })
  const ao = await setting('always_online')
  out.push({ ok: ao === 'off', check: 'Always Online is off', detail: String(ao) })
  const sh = (await setting('security_header')) as { strict_transport_security?: { enabled?: boolean } }
  out.push({ ok: !!sh?.strict_transport_security?.enabled, check: 'HSTS is on' })

  try {
    const rules = await cf.get<{ id: string; status: string }[]>(`/zones/${zoneId}/pagerules`)
    out.push({ ok: rules.length === 0, check: 'no Page Rules', detail: rules.length ? `${rules.length} found` : undefined })
  } catch (err) {
    out.push({ ok: false, check: 'no Page Rules', detail: `cannot read (${errStatus(err)})` })
  }
  for (const [phase, label] of FORBIDDEN_PHASES) {
    try {
      const rs = await cf.get<{ rules?: unknown[] }>(`/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`)
      const n = rs.rules?.length ?? 0
      out.push({ ok: n === 0, check: `no ${label}`, detail: n ? `${n} found` : undefined })
    } catch (err) {
      if (isNotFound(err)) out.push({ ok: true, check: `no ${label}` })
      else out.push({ ok: false, check: `no ${label}`, detail: `cannot read (${errStatus(err)})` })
    }
  }

  const dnssec = await cf.get<{ status: string }>(`/zones/${zoneId}/dnssec`)
  out.push({ ok: dnssec.status === 'active', check: 'DNSSEC active', detail: dnssec.status })

  if (opts.wildcard) {
    const recs = await cf.get<{ type: string; content: string; proxied: boolean }[]>(`/zones/${zoneId}/dns_records`, {
      name: `*.${opts.apex}`,
    })
    out.push({ ok: recs.some((r) => r.type === 'AAAA' && r.proxied), check: 'wildcard AAAA 100:: proxied' })
    const routes = await cf.get<{ pattern: string; script?: string; request_limit_fail_open?: boolean }[]>(
      `/zones/${zoneId}/workers/routes`,
    )
    const route = routes.find((r) => r.pattern === `*.${opts.apex}/*`)
    out.push({ ok: route?.script === 'shortener-edge', check: `route *.${opts.apex}/* → shortener-edge` })
    if (route && route.request_limit_fail_open != null)
      out.push({ ok: route.request_limit_fail_open === false, check: 'wildcard route fails closed' })
  }
  return out
}

export async function ensureWildcardRecord(cf: CF, zoneId: string, apex: string) {
  const name = `*.${apex}`
  const recs = await cf.get<{ id: string; type: string; content: string; proxied: boolean }[]>(`/zones/${zoneId}/dns_records`, { name })
  if (recs.some((r) => r.type === 'AAAA' && r.content === '100::' && r.proxied)) return
  await cf.post(`/zones/${zoneId}/dns_records`, { type: 'AAAA', name, content: '100::', proxied: true, ttl: 1, comment: 'shortener wildcard' })
}

export type Ds = { keyTag: number; algorithm: number; digestType: number; digest: string; ds: string }

export async function enableDnssec(cf: CF, zoneId: string): Promise<Ds | null> {
  let d = await cf.get<{ status: string; key_tag?: number; algorithm?: string; digest_type?: string; digest?: string; ds?: string }>(
    `/zones/${zoneId}/dnssec`,
  )
  if (d.status === 'disabled') d = await cf.patch(`/zones/${zoneId}/dnssec`, { status: 'active' })
  if (!d.ds || !d.digest || d.key_tag == null) return null
  return { keyTag: d.key_tag, algorithm: Number(d.algorithm), digestType: Number(d.digest_type), digest: d.digest, ds: d.ds }
}
