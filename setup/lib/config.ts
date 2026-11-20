import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, type DatabaseId, type RegistrarId } from './state.js'

/** Optional shortener.config.json: answers the wizard would otherwise ask. Never holds secrets. */
export type FileConfig = {
  mode?: 'free' | 'paid'
  retentionMonths?: number
  strictLogging?: boolean
  codeLength?: number
  database?: { provider?: DatabaseId; region?: string }
  domains?: {
    apex: string
    registrar?: RegistrarId
    serveWww?: boolean
    wildcard?: boolean
    wildcardMode?: 'namespace' | 'alias'
    homeUrl?: string | null
  }[]
}

export function loadFileConfig(): FileConfig | null {
  const p = join(ROOT, 'shortener.config.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8')) as FileConfig
}
