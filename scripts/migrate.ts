import postgres from 'postgres'
import { runMigrations } from '../setup/lib/migrate.js'

/**
 * CI migrations. Either SHORTENER_DATABASE_URL (owner connection), or
 * SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF (Management API, no direct connection).
 */
async function main() {
  const url = process.env.SHORTENER_DATABASE_URL
  const sbToken = process.env.SUPABASE_ACCESS_TOKEN
  const ref = process.env.SUPABASE_PROJECT_REF
  let run: (sql: string) => Promise<unknown>
  let close = async () => {}
  if (url) {
    const sql = postgres(url, { max: 1, onnotice: () => {} })
    run = (q) => sql.unsafe(q)
    close = () => sql.end({ timeout: 5 })
  } else if (sbToken && ref) {
    run = async (query) => {
      const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sbToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      if (!r.ok) throw new Error(`supabase query: ${r.status} ${(await r.text()).slice(0, 400)}`)
    }
  } else {
    // Cloudflare Workers Builds without database secrets: deploy still proceeds.
    console.log('migrate: skipped (set SHORTENER_DATABASE_URL, or SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF)')
    return
  }
  try {
    const ran = await runMigrations(run, (m) => console.log(m))
    console.log(`applied ${ran.length} migrations`)
  } finally {
    await close()
  }
}

main().catch((err) => {
  console.error((err as Error).message)
  process.exit(1)
})
