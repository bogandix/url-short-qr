import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const STATE_PATH = join(ROOT, '.shortener', 'state.json')

export type DomainState = {
  apex: string
  zoneId?: string
  registrar: RegistrarId
  nameservers?: string[]
  serveWww: boolean
  wildcard: boolean
  wildcardMode: 'namespace' | 'alias'
  isAdminHost: boolean
  homeUrl?: string | null
  codeLength: number
  done: Partial<Record<'zone' | 'nameservers' | 'active' | 'settings' | 'dnssec' | 'ds' | 'routes' | 'db' | 'smoke', string>>
}

export type RegistrarId = 'godaddy' | 'namecheap' | 'porkbun' | 'cloudflare' | 'route53' | 'manual'
export type DatabaseId = 'supabase' | 'neon' | 'postgres-url'

/** Everything here is non-secret: IDs, names and choices only. */
export type State = {
  version: 1
  mode: 'free' | 'paid'
  strictLogging: boolean
  retentionMonths: number
  codeLength: number
  accountId?: string
  accountName?: string
  database?: {
    provider: DatabaseId
    region: string
    projectRef?: string // supabase
    projectId?: string // neon
    host?: string
    jwksUrl?: string
    oidcIssuer?: string
    oidcAudience?: string
    supabaseUrl?: string
    supabaseAnonKey?: string // public by design (shipped to browsers)
  }
  resources?: {
    kvId?: string
    r2Bucket?: string
    hyperdriveEdgeId?: string
    hyperdriveAdminId?: string
    aeDataset?: string
    queue?: string
    dlq?: string
  }
  domains: Record<string, DomainState>
  steps: Partial<Record<string, string>>
  alertWebhookSet?: boolean
}

export function defaultState(): State {
  return { version: 1, mode: 'free', strictLogging: false, retentionMonths: 13, codeLength: 4, domains: {}, steps: {} }
}

export function loadState(): State {
  if (!existsSync(STATE_PATH)) return defaultState()
  return { ...defaultState(), ...(JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State) }
}

export function saveState(s: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  const tmp = `${STATE_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, STATE_PATH)
}

export function markStep(s: State, step: string): void {
  s.steps[step] = new Date().toISOString()
  saveState(s)
}

export function adminDomain(s: State): DomainState | undefined {
  return Object.values(s.domains).find((d) => d.isAdminHost)
}
