import Cloudflare from 'cloudflare'

/**
 * Thin wrapper over the official SDK's generic request methods. Every call is a
 * documented v4 REST path, so it is easy to audit what the wizard does.
 */
export class CF {
  readonly client: Cloudflare
  constructor(readonly token: string, public accountId?: string) {
    this.client = new Cloudflare({ apiToken: token, maxRetries: 3 })
  }

  private async unwrap<T>(p: PromiseLike<unknown>): Promise<T> {
    const env = (await p) as { success?: boolean; result: T; errors?: unknown[] }
    return env.result
  }

  get<T>(path: string, query?: Record<string, unknown>) {
    return this.unwrap<T>(this.client.get(path, { query }))
  }
  post<T>(path: string, body?: unknown) {
    return this.unwrap<T>(this.client.post(path, { body }))
  }
  put<T>(path: string, body?: unknown) {
    return this.unwrap<T>(this.client.put(path, { body }))
  }
  patch<T>(path: string, body?: unknown) {
    return this.unwrap<T>(this.client.patch(path, { body }))
  }
  del<T>(path: string) {
    return this.unwrap<T>(this.client.delete(path))
  }

  get acct() {
    if (!this.accountId) throw new Error('account not selected')
    return `/accounts/${this.accountId}`
  }

  /** Paginate `?page=&per_page=` lists. */
  async all<T>(path: string, query: Record<string, unknown> = {}): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; page < 100; page++) {
      const env = (await this.client.get(path, { query: { ...query, page, per_page: 50 } })) as {
        result: T[]
        result_info?: { total_pages?: number }
      }
      out.push(...env.result)
      if (!env.result_info?.total_pages || page >= env.result_info.total_pages || env.result.length === 0) break
    }
    return out
  }
}

export function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err != null && 'status' in err && (err as { status: number }).status === 404
}

export function errStatus(err: unknown): number | undefined {
  return typeof err === 'object' && err != null && 'status' in err ? (err as { status: number }).status : undefined
}

// ───────── token page ─────────

const PERMS: { key: string; type: 'read' | 'edit' }[] = [
  // account
  { key: 'workers_scripts', type: 'edit' },
  { key: 'workers_kv_storage', type: 'edit' },
  { key: 'workers_r2', type: 'edit' },
  { key: 'queues', type: 'edit' },
  { key: 'hyperdrive', type: 'edit' },
  { key: 'account_analytics', type: 'read' },
  { key: 'account_settings', type: 'read' },
  // zone
  { key: 'zone', type: 'edit' },
  { key: 'dns', type: 'edit' },
  { key: 'zone_settings', type: 'edit' },
  { key: 'workers_routes', type: 'edit' },
  { key: 'ssl_and_certificates', type: 'edit' },
  // read-only, for doctor's drift checks
  { key: 'page_rules', type: 'read' },
  { key: 'single_redirect', type: 'read' },
  { key: 'cache_settings', type: 'read' },
]

export function tokenPageUrl(name = 'shortener-setup'): string {
  const q = new URLSearchParams({
    permissionGroupKeys: JSON.stringify(PERMS),
    name,
    accountId: '*',
    zoneId: 'all',
  })
  return `https://dash.cloudflare.com/profile/api-tokens?${q}`
}

export function analyticsTokenPageUrl(): string {
  const q = new URLSearchParams({
    permissionGroupKeys: JSON.stringify([{ key: 'account_analytics', type: 'read' }]),
    name: 'shortener-analytics-read',
    accountId: '*',
  })
  return `https://dash.cloudflare.com/profile/api-tokens?${q}`
}
