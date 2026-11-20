export type WildcardMode = 'namespace' | 'alias'

export type DomainRow = {
  id: string
  apex: string
  zone_id: string | null
  registrar: string | null
  serve_www: boolean
  wildcard: boolean
  wildcard_mode: WildcardMode
  home_url: string | null
  not_found_url: string | null
  code_length: number
  is_admin_host: boolean
  status: 'active' | 'pending_ns' | 'disabled'
}

export type HostResolution =
  | {
      kind: 'ok'
      host: string
      namespace: string
      domain: DomainRow
      isAdminHost: boolean
    }
  | {
      kind: 'invalid'
      host: string
      namespace: string
      domain: DomainRow | null
    }

function stripWww(host: string, serveWww: boolean): string {
  if (serveWww && host.startsWith('www.')) return host.slice(4)
  return host
}

/** Resolve request host against configured domains. */
export function resolveHost(rawHost: string, domains: DomainRow[]): HostResolution {
  const host = rawHost.toLowerCase().replace(/\.$/, '')
  if (!host) {
    return { kind: 'invalid', host: '', namespace: '', domain: null }
  }

  const byApex = new Map(domains.map((d) => [d.apex.toLowerCase(), d]))

  for (const domain of domains) {
    if (domain.status === 'disabled') continue
    const apex = domain.apex.toLowerCase()
    const candidate = stripWww(host, domain.serve_www)

    if (candidate === apex) {
      return {
        kind: 'ok',
        host,
        namespace: apex,
        domain,
        isAdminHost: domain.is_admin_host,
      }
    }

    if (domain.wildcard && candidate.endsWith(`.${apex}`) && candidate !== apex) {
      const namespace = domain.wildcard_mode === 'alias' ? apex : candidate
      return {
        kind: 'ok',
        host,
        namespace,
        domain,
        isAdminHost: domain.is_admin_host && candidate === apex,
      }
    }
  }

  // Unknown host: pick a zone apex if the host is under one of our zones (for logging namespace).
  for (const domain of domains) {
    const apex = domain.apex.toLowerCase()
    if (host === apex || host.endsWith(`.${apex}`)) {
      return { kind: 'invalid', host, namespace: apex, domain }
    }
  }

  const fallback = byApex.values().next().value ?? null
  return {
    kind: 'invalid',
    host,
    namespace: fallback?.apex.toLowerCase() ?? host,
    domain: fallback ?? null,
  }
}
