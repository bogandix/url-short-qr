import type { RegistrarId } from '../lib/state.js'

export type DsRecord = { keyTag: number; algorithm: number; digestType: number; digest: string; ds: string }

export interface Registrar {
  id: RegistrarId
  auth(): Promise<void>
  getNameservers(domain: string): Promise<string[]>
  setNameservers(domain: string, ns: string[]): Promise<void>
  getDnssec?(domain: string): Promise<boolean>
  disableDnssec?(domain: string): Promise<void>
  addDs?(domain: string, ds: DsRecord): Promise<void>
}

/** Thrown when an adapter cannot be used (e.g. GoDaddy API restricted); the wizard falls back to manual. */
export class RegistrarUnavailable extends Error {}

export function sameNs(a: string[], b: string[]): boolean {
  const n = (x: string[]) => x.map((s) => s.toLowerCase().replace(/\.$/, '')).sort().join(',')
  return n(a) === n(b)
}
