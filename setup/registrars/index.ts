import type { RegistrarId } from '../lib/state.js'
import { CloudflareRegistrar } from './cloudflare.js'
import { GoDaddy } from './godaddy.js'
import { Manual } from './manual.js'
import { Porkbun } from './porkbun.js'
import type { Registrar } from './types.js'

/** v1 adapters: GoDaddy, Porkbun, Cloudflare, Manual. Namecheap and Route 53 fall back to manual for now. */
export function registrarFor(id: RegistrarId): Registrar {
  switch (id) {
    case 'godaddy':
      return new GoDaddy()
    case 'porkbun':
      return new Porkbun()
    case 'cloudflare':
      return new CloudflareRegistrar()
    default:
      return new Manual()
  }
}

export const REGISTRAR_OPTIONS: { value: RegistrarId; label: string; hint?: string }[] = [
  { value: 'cloudflare', label: 'Cloudflare Registrar', hint: 'nothing to change' },
  { value: 'porkbun', label: 'Porkbun', hint: 'API key' },
  { value: 'godaddy', label: 'GoDaddy', hint: 'API key; falls back to manual if GoDaddy refuses' },
  { value: 'namecheap', label: 'Namecheap', hint: 'manual steps (adapter planned)' },
  { value: 'route53', label: 'Route 53', hint: 'manual steps (adapter planned)' },
  { value: 'manual', label: 'Other / manual', hint: 'prints what to change' },
]

export type { Registrar }
