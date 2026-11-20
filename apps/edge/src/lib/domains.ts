import { domainKvKey, type DomainRow } from '@shortener/shared'
import type { Env } from '../env.js'
import { adminSqlClient, sqlClient, withSql, type Sql } from './db.js'

export const DOMAINS_INDEX_KEY = '__domains_all'
const MEMORY_MS = 60_000

let memory: { at: number; rows: DomainRow[] } | null = null

const DOMAIN_COLS = `id, apex, zone_id, registrar, serve_www, wildcard, wildcard_mode,
  home_url, not_found_url, code_length, is_admin_host, status`

/** Domains for host resolution: isolate memory (60 s) → KV index → Postgres. */
export async function loadDomains(env: Env): Promise<DomainRow[]> {
  if (memory && Date.now() - memory.at < MEMORY_MS) return memory.rows

  try {
    const cached = await env.LINKS.get<DomainRow[]>(DOMAINS_INDEX_KEY, { type: 'json', cacheTtl: 60 })
    if (Array.isArray(cached)) {
      memory = { at: Date.now(), rows: cached }
      return cached
    }
  } catch {
    /* fall through to the database */
  }

  try {
    const rows = await withSql(() => sqlClient(env), selectDomains)
    memory = { at: Date.now(), rows }
    await env.LINKS.put(DOMAINS_INDEX_KEY, JSON.stringify(rows)).catch(() => {})
    return rows
  } catch (err) {
    // Database and KV both unavailable: keep serving with the last known list.
    if (memory) return memory.rows
    throw err
  }
}

export async function selectDomains(sql: Sql): Promise<DomainRow[]> {
  return sql.unsafe<DomainRow[]>(`select ${DOMAIN_COLS} from shortener.domains where status <> 'disabled' order by apex`)
}

/** Rewrite per-apex keys and the index after a domain change. */
export async function publishDomains(env: Env, sql?: Sql): Promise<DomainRow[]> {
  const rows = sql ? await selectDomains(sql) : await withSql(() => adminSqlClient(env), selectDomains)
  await Promise.all(rows.map((d) => env.LINKS.put(domainKvKey(d.apex), JSON.stringify(d))))
  await env.LINKS.put(DOMAINS_INDEX_KEY, JSON.stringify(rows))
  memory = { at: Date.now(), rows }
  return rows
}

export function resetDomainMemory(): void {
  memory = null
}
