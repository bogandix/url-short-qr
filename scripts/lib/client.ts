import { loadState, type State } from '../../setup/lib/state.js'

export function adminHost(s: State = loadState()): string {
  const h = process.env.SHORTENER_ADMIN_HOST ?? Object.values(s.domains).find((d) => d.isAdminHost)?.apex
  if (!h) throw new Error('No admin host: run setup, or set SHORTENER_ADMIN_HOST')
  return h
}

export class Api {
  constructor(readonly host: string, private key: string) {}
  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const r = await fetch(`https://${this.host}/_/api${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: r.status, body: (await r.json().catch(() => null)) as T }
  }
}
