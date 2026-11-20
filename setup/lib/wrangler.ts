import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { ROOT, type State } from './state.js'

export const EDGE_CONFIG = join(ROOT, 'apps/edge/wrangler.jsonc')
export const CONSUMER_CONFIG = join(ROOT, 'apps/consumer/wrangler.jsonc')

export type WranglerAuth = { token: string; accountId: string }

/** Run wrangler with the token in env (never on the command line). Output is redacted. */
export function wrangler(args: string[], auth: WranglerAuth, opts: { stdin?: string; quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    // Same Node binary as the wizard (wrangler needs >= 22.12), wrangler from this repo's node_modules.
    const bin = join(dirname(createRequire(join(ROOT, 'package.json')).resolve('wrangler/package.json')), 'bin/wrangler.js')
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: ROOT,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: auth.token, CLOUDFLARE_ACCOUNT_ID: auth.accountId, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    const onData = (b: Buffer) => {
      const s = b.toString().split(auth.token).join('***')
      out += s
      if (!opts.quiet) process.stdout.write(s)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    if (opts.stdin != null) child.stdin.end(opts.stdin)
    else child.stdin.end()
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`wrangler ${args[0]} exited ${code}\n${out.slice(-2000)}`))))
  })
}

export async function putSecret(name: string, value: string, auth: WranglerAuth, config = EDGE_CONFIG): Promise<void> {
  await wrangler(['secret', 'put', name, '-c', config], auth, { stdin: value, quiet: true })
}

/** wrangler.jsonc for the edge Worker, generated from state (IDs only; secrets are pushed separately). */
export function edgeConfig(s: State): Record<string, unknown> {
  const r = s.resources ?? {}
  const routes: Record<string, unknown>[] = []
  for (const d of Object.values(s.domains)) {
    if (!d.zoneId || !d.done.active) continue
    routes.push({ pattern: d.apex, custom_domain: true })
    if (d.serveWww) routes.push({ pattern: `www.${d.apex}`, custom_domain: true })
    if (d.wildcard) routes.push({ pattern: `*.${d.apex}/*`, zone_id: d.zoneId })
  }
  const db = s.database
  const vars: Record<string, string> = {
    MODE: s.mode,
    STRICT_LOGGING: String(s.strictLogging),
    RETENTION_MONTHS: String(s.retentionMonths),
    AE_DATASET: r.aeDataset ?? 'shortener_clicks',
  }
  if (s.accountId) vars.CF_ACCOUNT_ID = s.accountId
  if (db?.jwksUrl) vars.ADMIN_JWKS_URL = db.jwksUrl
  if (db?.oidcIssuer) vars.OIDC_ISSUER = db.oidcIssuer
  if (db?.oidcAudience) vars.OIDC_AUDIENCE = db.oidcAudience
  if (db?.supabaseUrl) vars.SUPABASE_URL = db.supabaseUrl
  if (db?.supabaseAnonKey) vars.SUPABASE_ANON_KEY = db.supabaseAnonKey

  const cfg: Record<string, unknown> = {
    $schema: '../../node_modules/wrangler/config-schema.json',
    name: 'shortener-edge',
    main: 'src/index.ts',
    account_id: s.accountId,
    compatibility_date: '2025-06-01',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: true },
    assets: { directory: './public', binding: 'ASSETS', run_worker_first: true },
    vars,
    kv_namespaces: r.kvId ? [{ binding: 'LINKS', id: r.kvId }] : [],
    r2_buckets: r.r2Bucket ? [{ binding: 'FALLBACK', bucket_name: r.r2Bucket }] : [],
    hyperdrive: [
      ...(r.hyperdriveEdgeId ? [{ binding: 'DB', id: r.hyperdriveEdgeId }] : []),
      ...(r.hyperdriveAdminId ? [{ binding: 'DB_ADMIN', id: r.hyperdriveAdminId }] : []),
    ],
    analytics_engine_datasets: [{ binding: 'CLICKS_AE', dataset: r.aeDataset ?? 'shortener_clicks' }],
    ratelimits: [{ name: 'RATE_LIMIT', namespace_id: '7001', simple: { limit: 120, period: 60 } }],
    triggers: { crons: ['*/5 * * * *', '15 0 * * *', '0 */6 * * *'] },
    routes,
  }
  if (s.mode === 'paid' && r.queue) cfg.queues = { producers: [{ binding: 'CLICKS', queue: r.queue }] }
  return cfg
}

export function consumerConfig(s: State): Record<string, unknown> {
  const r = s.resources ?? {}
  return {
    $schema: '../../node_modules/wrangler/config-schema.json',
    name: 'shortener-consumer',
    main: 'src/index.ts',
    account_id: s.accountId,
    compatibility_date: '2025-06-01',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    observability: { enabled: true },
    hyperdrive: [{ binding: 'DB', id: r.hyperdriveEdgeId ?? 'REPLACE_WITH_EDGE_HYPERDRIVE_ID' }],
    queues: {
      consumers: [
        {
          queue: r.queue ?? 'shortener-clicks',
          max_batch_size: 100,
          max_batch_timeout: 10,
          max_retries: 10,
          retry_delay: 30,
          dead_letter_queue: r.dlq ?? 'shortener-clicks-dlq',
        },
      ],
    },
  }
}

const HEADER = '// Generated by `npm run setup` from .shortener/state.json — IDs only, no secrets.\n// Re-run `npm run setup` (or `npm run domain:add`) to regenerate.\n'

export function writeConfigs(s: State): void {
  writeFileSync(EDGE_CONFIG, HEADER + JSON.stringify(edgeConfig(s), null, 2) + '\n')
  if (s.mode === 'paid') writeFileSync(CONSUMER_CONFIG, HEADER + JSON.stringify(consumerConfig(s), null, 2) + '\n')
}

export async function deployAll(s: State, auth: WranglerAuth): Promise<void> {
  await wrangler(['deploy', '-c', EDGE_CONFIG], auth)
  if (s.mode === 'paid') await wrangler(['deploy', '-c', CONSUMER_CONFIG], auth)
}
