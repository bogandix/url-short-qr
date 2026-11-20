import postgres from 'postgres'
import type { Env } from '../env.js'

export type Sql = postgres.Sql

function client(connectionString: string): Sql {
  return postgres(connectionString, {
    max: 1,
    fetch_types: false,
    prepare: false,
    connect_timeout: 5,
    idle_timeout: 5,
    // fetch_types is off, so array OIDs are unknown to postgres.js: parse text[] (1009) and varchar[] (1015) here.
    types: {
      textArray: { to: 1009, from: [1009, 1015], serialize: (v: string[] | string) => (Array.isArray(v) ? pgArray(v)! : v), parse: parsePgArray },
      // json/jsonb arrive as text without type info; params are already JSON strings (cast ::jsonb in SQL).
      json: { to: 3802, from: [114, 3802], serialize: (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)), parse: (t: string) => JSON.parse(t) },
    },
  }) as unknown as Sql
}

/** Edge role: INSERT clicks, SELECT links/domains/api_keys. */
export function sqlClient(env: Env): Sql {
  return client(env.DB.connectionString)
}

/** Admin role: link CRUD, audit, stats, crons. */
export function adminSqlClient(env: Env): Sql {
  return client((env.DB_ADMIN ?? env.DB).connectionString)
}

/** Run fn with a short-lived client and always close it (Hyperdrive pools the real connection). */
export async function withSql<T>(make: () => Sql, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = make()
  try {
    return await fn(sql)
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {})
  }
}

/**
 * Postgres text-array literal. postgres.js cannot serialize JS arrays when
 * fetch_types is off (required behind Hyperdrive), so arrays are sent as text
 * and cast with ::text[] in SQL. Null stays null.
 */
export function pgArray(values: readonly string[] | null | undefined): string | null {
  if (values == null) return null
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`
}

/** Parse a Postgres array literal of text: {a,"b c","d\\"e",NULL}. One dimension. */
export function parsePgArray(text: string): (string | null)[] {
  if (text === '{}') return []
  const out: (string | null)[] = []
  let i = 1
  while (i < text.length - 1) {
    if (text[i] === '"') {
      let v = ''
      i++
      while (text[i] !== '"') {
        if (text[i] === '\\') i++
        v += text[i]
        i++
      }
      out.push(v)
      i += 2 // closing quote + comma
    } else {
      let j = i
      while (j < text.length - 1 && text[j] !== ',') j++
      const v = text.slice(i, j)
      out.push(v === 'NULL' ? null : v)
      i = j + 1
    }
  }
  return out
}
