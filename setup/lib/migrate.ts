import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './state.js'

export const MIGRATIONS_DIR = join(ROOT, 'migrations')

export function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }))
}

/** All migrations are idempotent; bookkeeping only records what ran. */
export async function runMigrations(runSql: (sql: string) => Promise<unknown>, log: (m: string) => void = () => {}): Promise<string[]> {
  const ran: string[] = []
  for (const m of migrationFiles()) {
    log(`migration ${m.name}`)
    await runSql(m.sql)
    ran.push(m.name)
  }
  await runSql(`
    create table if not exists shortener.schema_migrations (name text primary key, applied_at timestamptz not null default now());
    insert into shortener.schema_migrations (name) values ${ran.map((n) => `('${n.replace(/'/g, "''")}')`).join(', ')}
    on conflict (name) do nothing;`)
  return ran
}

/** Sets login + password on the two roles. Password is validated to be URL/SQL-safe. */
export function rolePasswordSql(role: 'shortener_edge' | 'shortener_admin', password: string): string {
  if (!/^[A-Za-z0-9_-]{24,}$/.test(password)) throw new Error('unsafe password')
  return `alter role ${role} with login password '${password}';`
}
