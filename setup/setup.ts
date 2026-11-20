import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { databaseFor, DATABASE_REGIONS, type Database } from './databases/index.js'
import { parsePgUrl } from './databases/types.js'
import { addDomain, promptDomain } from './domain.js'
import { analyticsToken, cloudflareAuth, ensureHyperdrive, ensureKv, ensureQueue, ensureR2, findHyperdrive } from './lib/cloudflare.js'
import { rolePasswordSql, runMigrations } from './lib/migrate.js'
import { hashPassword } from '@shortener/shared'
import { EMAIL_RE, lit, newApiKey, sha256Hex } from './lib/sql.js'
import { loadFileConfig } from './lib/config.js'
import { markStep, saveState, type State } from './lib/state.js'
import { ask, choose, p, randomSecret, secret, task, yes } from './lib/ui.js'
import { deployAll, putSecret, wrangler, writeConfigs, type WranglerAuth } from './lib/wrangler.js'

function preflightTools() {
  const [maj, min] = process.versions.node.split('.').map(Number) as [number, number]
  if (maj < 22 || (maj === 22 && min < 12)) throw new Error(`Node ${process.versions.node}: wrangler needs Node >= 22.12`)
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch {
    throw new Error('git not available')
  }
  try {
    createRequire(import.meta.url).resolve('wrangler/package.json')
  } catch {
    throw new Error('wrangler not installed (run npm install first)')
  }
}

/** Step 0: choices. Re-runs keep earlier answers. */
async function preflight(s: State) {
  await task('Checking Node, git, wrangler', async () => preflightTools())
  if (s.steps.preflight) return
  const fc = loadFileConfig()
  if (fc?.mode && fc.database?.provider && fc.database.region) {
    p.log.info('Using shortener.config.json')
    s.mode = fc.mode
    s.database = { ...s.database, provider: fc.database.provider, region: fc.database.region }
    s.codeLength = fc.codeLength ?? s.codeLength
    s.retentionMonths = fc.retentionMonths ?? s.retentionMonths
    s.strictLogging = fc.strictLogging ?? s.strictLogging
    markStep(s, 'preflight')
    return
  }
  s.mode = await choose('Mode', [
    { value: 'free', label: 'Free', hint: 'free tiers, up to ~100k requests/day; Postgres with R2 fallback' },
    { value: 'paid', label: 'Paid', hint: 'Workers Paid ($5/mo): adds a durable queue in front of Postgres' },
  ], s.mode)
  const provider = await choose('Postgres provider', [
    { value: 'supabase', label: 'Supabase', hint: 'default; also provides the admin login' },
    { value: 'neon', label: 'Neon' },
    { value: 'postgres-url', label: 'Any Postgres (connection string)' },
  ], s.database?.provider ?? 'supabase')
  const region = DATABASE_REGIONS[provider].length > 1 ? await choose('Database region', DATABASE_REGIONS[provider]) : DATABASE_REGIONS[provider][0]!.value
  s.database = { ...s.database, provider, region }
  s.codeLength = Number(await choose('Code length (random codes)', [
    { value: '4', label: '4', hint: '1.18M codes per namespace (grows automatically at 50%)' },
    { value: '5', label: '5', hint: '39M codes' },
    { value: '6', label: '6', hint: '1.3B codes' },
  ], String(s.codeLength)))
  s.retentionMonths = Number(await ask('Keep raw clicks for how many months? (rollups are kept forever)', { initial: String(s.retentionMonths), validate: (v) => (/^\d+$/.test(v) && +v >= 1 && +v <= 120 ? undefined : '1–120') }))
  s.strictLogging = await yes('STRICT_LOGGING: refuse to redirect when neither Postgres nor R2 can store the event?', false)
  markStep(s, 'preflight')
}

type Secrets = { edgePw?: string; adminPw?: string; salt?: string }

/** Step 2: provision, migrate, roles, hide schema, JWKS. Migrations run on every setup (idempotent). */
async function database(s: State, db: Database, sec: Secrets, cfHasHyperdrive: boolean) {
  await db.auth()
  const prov = await db.provision({ region: s.database!.region })
  await task('Running migrations', () => runMigrations((sql) => db.runSql(sql)))
  // Passwords are generated fresh whenever Hyperdrive must (re)learn them; never stored.
  if (!cfHasHyperdrive || (await yes('Rotate database role passwords?', false))) {
    sec.edgePw = randomSecret(24)
    sec.adminPw = randomSecret(24)
    await task('Setting role passwords', async () => {
      await db.runSql(rolePasswordSql('shortener_edge', sec.edgePw!))
      await db.runSql(rolePasswordSql('shortener_admin', sec.adminPw!))
    })
  }
  if (db.hideSchema) await task('Hiding schema from the REST API', () => db.hideSchema!())
  const info = db.stateInfo()
  s.database = { ...s.database!, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v)) }
  // Supabase Auth (email OTP) is opt-in: it changes the project's auth settings, which is
  // wrong for a shared project. The built-in password login works everywhere.
  if (db.jwks && process.env.SHORTENER_SUPABASE_AUTH === 'on') {
    const j = await task('Configuring Supabase Auth login (email OTP)', () => db.jwks!())
    Object.assign(s.database!, { jwksUrl: j.jwksUrl, oidcIssuer: j.issuer, oidcAudience: j.audience, supabaseUrl: j.supabaseUrl, supabaseAnonKey: j.anonKey })
  }
  saveState(s)
  return prov
}

export async function runSetup() {
  p.intro('shortener setup')
  const s = (await import('./lib/state.js')).loadState()
  await preflight(s)

  // 1. Cloudflare
  const cf = await cloudflareAuth(s)
  const auth: WranglerAuth = { token: cf.token, accountId: s.accountId! }
  markStep(s, 'cloudflare')

  // 2. Database
  const db = databaseFor(s.database!.provider, s)
  const hasHd = !!(await findHyperdrive(cf, 'shortener-edge')) && !!(await findHyperdrive(cf, 'shortener-admin'))
  const sec: Secrets = {}
  await database(s, db, sec, hasHd)
  markStep(s, 'database')

  // 3. Cloudflare resources
  s.resources ??= {}
  const r = s.resources
  r.kvId = await task('KV shortener-links', () => ensureKv(cf, 'shortener-links'))
  if (process.env.SHORTENER_R2 === 'off') r.r2Bucket = undefined
  else {
    try {
      r.r2Bucket = await task('R2 shortener-fallback', () => ensureR2(cf, 'shortener-fallback'))
    } catch (err) {
      if (!/10042|enable R2/i.test(String((err as Error).message))) throw err
      r.r2Bucket = undefined
      p.log.warn('R2 is not enabled on this account: the outage buffer will use KV (free, ~1,000 writes/day). Enable R2 and re-run setup to switch.')
    }
  }
  if (sec.edgePw && sec.adminPw) {
    for (const [name, role, pw, key] of [
      ['shortener-edge', 'shortener_edge', sec.edgePw, 'hyperdriveEdgeId'],
      ['shortener-admin', 'shortener_admin', sec.adminPw, 'hyperdriveAdminId'],
    ] as const) {
      const o = parsePgUrl(db.roleUrl(role, pw))
      r[key] = await task(`Hyperdrive ${name}`, () => ensureHyperdrive(cf, name, o))
    }
  } else {
    r.hyperdriveEdgeId = await findHyperdrive(cf, 'shortener-edge')
    r.hyperdriveAdminId = await findHyperdrive(cf, 'shortener-admin')
  }
  r.aeDataset = 'shortener_clicks' // created on first write
  if (s.mode === 'paid') {
    r.dlq = await task('Queue shortener-clicks-dlq', () => ensureQueue(cf, 'shortener-clicks-dlq'))
    r.queue = await task('Queue shortener-clicks', () => ensureQueue(cf, 'shortener-clicks'))
  }
  saveState(s)
  markStep(s, 'resources')

  // 5 (before 4: secrets need the script to exist). Deploy with no routes yet.
  writeConfigs(s)
  await task('Building admin UI', async () => {
    execFileSync('npm', ['run', 'build', '-w', '@shortener/admin'], { stdio: 'ignore' })
  })
  await deployAll(s, auth)
  markStep(s, 'deploy')

  // 4. Secrets
  if (!s.steps.secrets) {
    sec.salt = randomSecret(32)
    await task('SECRET_SALT', () => putSecret('SECRET_SALT', sec.salt!, auth))
    const ae = await analyticsToken()
    await task('CF_ANALYTICS_TOKEN', () => putSecret('CF_ANALYTICS_TOKEN', ae, auth))
    const hook = await ask('Alert webhook URL for reconcile differences (Slack/Discord/any; blank = none)', { placeholder: 'https://hooks.slack.com/…', env: 'ALERT_WEBHOOK_URL', optional: true })
    if (hook) {
      await task('ALERT_WEBHOOK_URL', () => putSecret('ALERT_WEBHOOK_URL', hook, auth))
      s.alertWebhookSet = true
    }
    markStep(s, 'secrets')
  }

  // 7 (key first, so step 6 can smoke-test). First admin + API key.
  let apiKey: string | undefined
  let tempPassword: string | undefined
  if (!s.steps.admin) {
    const email = (await ask('Admin email (for the admin UI login)', { env: 'SHORTENER_ADMIN_EMAIL', validate: (v) => (EMAIL_RE.test(v) ? undefined : 'Not an email') })).toLowerCase()
    tempPassword = randomSecret(12) // must be changed at first sign-in
    const hash = await hashPassword(tempPassword)
    await db.runSql(`insert into shortener.admins (email, password_hash, must_change_password) values (${lit(email)}, ${lit(hash)}, true)
      on conflict (email) do update set password_hash = excluded.password_hash, must_change_password = true,
        failed_attempts = 0, locked_until = null, session_epoch = shortener.admins.session_epoch + 1`)
    if (db.ensureAuthUser && s.database?.supabaseUrl) await task('Creating Supabase Auth user', () => db.ensureAuthUser!(email, tempPassword))
    apiKey = newApiKey()
    await db.runSql(`insert into shortener.api_keys (name, key_hash, scopes)
      values ('setup', ${lit(await sha256Hex(apiKey))}, array['links:read','links:write','stats:read','domains:admin','keys:admin'])`)
    markStep(s, 'admin')
  } else {
    apiKey = process.env.SHORTENER_API_KEY || (await yes('Paste an API key so smoke tests can run?', false) ? await secret('API key') : undefined)
  }

  // 6. First domain (admin host)
  const existingAdmin = Object.values(s.domains).find((d) => d.isAdminHost)
  const d = existingAdmin ?? (await promptDomain(s, { isAdminHost: true }))
  await addDomain({ s, cf, db, auth, apiKey }, d)
  markStep(s, 'domain')

  // 9. Summary
  summary(s, apiKey, tempPassword)
}

function summary(s: State, apiKey?: string, tempPassword?: string) {
  const admin = Object.values(s.domains).find((d) => d.isAdminHost)!
  const lines = [
    `Admin UI:   https://${admin.apex}/_/admin`,
    `API:        https://${admin.apex}/_/api`,
    `Health:     https://${admin.apex}/_/health`,
    `Domains:    ${Object.keys(s.domains).join(', ')}`,
    '',
    s.mode === 'free'
      ? 'Free mode: ~100k requests/day across all domains. Past that Cloudflare answers Error 1027 — no redirect AND no log. Switch to paid mode above ~50k/day.'
      : 'Paid mode: queue shortener-clicks → shortener-consumer, DLQ shortener-clicks-dlq.',
    '',
    'GitHub Actions secrets for .github/workflows/deploy.yml:',
    '  CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, SHORTENER_API_KEY,',
    s.database?.provider === 'supabase' ? '  SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF (= ' + s.database.projectRef + ')' : '  SHORTENER_DATABASE_URL (owner connection, for migrations)',
    'and commit apps/edge/wrangler.jsonc (IDs only, no secrets).',
  ]
  p.note(lines.join('\n'), 'Done')
  if (apiKey) {
    p.note(`${apiKey}\n\nShown once. Store it in your password manager; it is not saved anywhere.`, 'First API key')
  }
  if (tempPassword) {
    p.note(`${tempPassword}\n\nTemporary admin UI password; you must choose a new one at first sign-in.`, 'Admin password')
  }
  p.outro('Run `npm run doctor` any time to check for drift.')
}

export async function runDomainAdd(apexArg?: string) {
  p.intro('shortener domain:add')
  const { loadState } = await import('./lib/state.js')
  const s = loadState()
  if (!s.steps.deploy || !s.database) throw new Error('Run `npm run setup` first.')
  const cf = await cloudflareAuth(s)
  const db = databaseFor(s.database.provider, s)
  await db.auth()
  await db.provision({ region: s.database.region }) // re-attaches to the existing project
  const d = await promptDomain(s, { apex: apexArg, isAdminHost: false })
  const apiKey = process.env.SHORTENER_API_KEY || (await secret('API key (for the smoke test)'))
  await addDomain({ s, cf, db, auth: { token: cf.token, accountId: s.accountId! }, apiKey }, d)
  p.outro(`${d.apex} is live.`)
}

export { wrangler }
