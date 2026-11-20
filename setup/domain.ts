import type { Database } from './databases/index.js'
import { registrarFor, REGISTRAR_OPTIONS } from './registrars/index.js'
import { RegistrarUnavailable, sameNs, type Registrar } from './registrars/types.js'
import { Manual } from './registrars/manual.js'
import type { CF } from './lib/cf.js'
import { kvDelete, kvPut } from './lib/cloudflare.js'
import { APEX_RE, lit } from './lib/sql.js'
import { loadFileConfig } from './lib/config.js'
import { saveState, type DomainState, type State } from './lib/state.js'
import { ask, choose, p, sleep, task, yes } from './lib/ui.js'
import { deployAll, writeConfigs, type WranglerAuth } from './lib/wrangler.js'
import { applyZoneSettings, enableDnssec, ensureWildcardRecord, ensureZone, zoneDrift } from './lib/zone.js'
import { runSmoke } from '../scripts/lib/smoke.js'

export async function promptDomain(s: State, opts: { apex?: string; isAdminHost: boolean }): Promise<DomainState> {
  const fc = loadFileConfig()?.domains ?? []
  const fromFile = opts.apex ? fc.find((x) => x.apex === opts.apex) : opts.isAdminHost ? fc[0] : fc.find((x) => !s.domains[x.apex])
  if (fromFile && !s.domains[fromFile.apex.toLowerCase()]) {
    const apex = fromFile.apex.toLowerCase()
    if (!APEX_RE.test(apex)) throw new Error(`invalid domain in shortener.config.json: ${fromFile.apex}`)
    const d: DomainState = {
      apex,
      registrar: fromFile.registrar ?? 'manual',
      serveWww: fromFile.serveWww ?? true,
      wildcard: fromFile.wildcard ?? false,
      wildcardMode: fromFile.wildcardMode ?? 'namespace',
      isAdminHost: opts.isAdminHost,
      homeUrl: fromFile.homeUrl ?? null,
      codeLength: s.codeLength,
      done: {},
    }
    p.log.info(`${apex}: using shortener.config.json`)
    s.domains[apex] = d
    saveState(s)
    return d
  }
  const apex = (opts.apex ?? (await ask('Domain (apex)', { placeholder: 'short.example', validate: (v) => (APEX_RE.test(v.toLowerCase()) ? undefined : 'Not a domain') })))
    .toLowerCase()
    .replace(/\.$/, '')
  if (!APEX_RE.test(apex)) throw new Error(`invalid domain: ${apex}`)
  const existing = s.domains[apex]
  if (existing) {
    p.log.info(`Resuming ${apex}`)
    return existing
  }
  const registrar = await choose('Where is it registered?', REGISTRAR_OPTIONS, 'manual')
  const serveWww = await yes(`Also serve www.${apex}?`, true)
  const wildcard = await yes(`Serve wildcard subdomains (*.${apex})?`, false)
  const wildcardMode = wildcard
    ? await choose(
        'Wildcard mode',
        [
          { value: 'namespace', label: 'namespace', hint: 'each subdomain has its own codes (acme.' + apex + '/X ≠ beta.' + apex + '/X)' },
          { value: 'alias', label: 'alias', hint: 'subdomains share the apex codes' },
        ],
        'namespace',
      )
    : 'namespace'
  const homeUrl = await ask(`Where should https://${apex}/ redirect? (blank = plain 200)`, { placeholder: 'https://www.example.com' })
  const d: DomainState = {
    apex,
    registrar,
    serveWww,
    wildcard,
    wildcardMode: wildcardMode as DomainState['wildcardMode'],
    isAdminHost: opts.isAdminHost,
    homeUrl: homeUrl || null,
    codeLength: s.codeLength,
    done: {},
  }
  s.domains[apex] = d
  saveState(s)
  return d
}

async function registrarWithFallback(d: DomainState): Promise<Registrar> {
  const r = registrarFor(d.registrar)
  try {
    await r.auth()
    return r
  } catch (err) {
    if (err instanceof RegistrarUnavailable) {
      p.log.warn(`${err.message} — continuing with manual steps.`)
      return new Manual()
    }
    throw err
  }
}

async function guard<T>(r: Registrar, fn: (r: Registrar) => Promise<T>): Promise<T> {
  try {
    return await fn(r)
  } catch (err) {
    if (err instanceof RegistrarUnavailable) {
      p.log.warn(`${err.message} — continuing with manual steps.`)
      return fn(new Manual())
    }
    throw err
  }
}

export type DomainCtx = { s: State; cf: CF; db: Database; auth: WranglerAuth; apiKey?: string }

/** `domain:add` — §11 steps 1–7. Every step is recorded and skipped on re-run. */
export async function addDomain(ctx: DomainCtx, d: DomainState): Promise<void> {
  const { s, cf } = ctx
  const mark = (k: keyof DomainState['done']) => {
    d.done[k] = new Date().toISOString()
    saveState(s)
  }

  // 1. zone
  const zone = await task(`Zone ${d.apex}`, () => ensureZone(cf, d.apex))
  d.zoneId = zone.id
  d.nameservers = zone.name_servers
  mark('zone')

  // 2. registrar: DNSSEC off, nameservers
  let registrar: Registrar | null = null
  if (!d.done.nameservers && zone.status !== 'active') {
    registrar = await registrarWithFallback(d)
    const current = await guard(registrar, (r) => r.getNameservers(d.apex)).catch(() => [] as string[])
    if (!sameNs(current, zone.name_servers)) {
      if (registrar.getDnssec && (await guard(registrar, (r) => r.getDnssec!(d.apex)))) {
        await task('Turning registrar DNSSEC off (re-enabled with Cloudflare keys later)', () => guard(registrar!, (r) => r.disableDnssec!(d.apex)))
      }
      await guard(registrar, (r) => r.setNameservers(d.apex, zone.name_servers))
    }
  }
  mark('nameservers')

  // 3. wait for activation (resumable)
  if (!d.done.active) {
    await cf.put(`/zones/${zone.id}/activation_check`).catch(() => {})
    const s0 = p.spinner()
    s0.start(`Waiting for ${d.apex} to become active (nameserver propagation; can take hours — Ctrl-C and re-run to resume)`)
    for (let i = 0; ; i++) {
      const z = await cf.get<{ status: string }>(`/zones/${zone.id}`)
      if (z.status === 'active') break
      if (i > 0 && i % 40 === 0) {
        s0.stop(`still ${z.status}`)
        if (!(await yes('Keep waiting?', true))) {
          p.log.info(`Re-run: npm run domain:add ${d.apex}`)
          process.exit(0)
        }
        s0.start('Waiting…')
      }
      await sleep(30_000)
    }
    s0.stop(`${d.apex} is active ✓`)
    mark('active')
  }

  // 4. zone settings + DNSSEC + DS
  await task('Zone settings (Always Use HTTPS off, Always Online off, HSTS on)', () => applyZoneSettings(cf, zone.id, d))
  mark('settings')
  if (!d.done.ds) {
    const ds = await task('Turning on Cloudflare DNSSEC', () => enableDnssec(cf, zone.id))
    mark('dnssec')
    if (ds && d.registrar !== 'cloudflare') {
      registrar ??= await registrarWithFallback(d)
      if (registrar.addDs) await guard(registrar, (r) => r.addDs!(d.apex, ds))
      else await new Manual().addDs(d.apex, ds)
    }
    mark('ds')
  }

  // 5. Worker on apex (+www) as custom domains; wildcard record + route
  if (d.wildcard) await task(`Wildcard DNS *.${d.apex}`, () => ensureWildcardRecord(cf, zone.id, d.apex))

  // 6. database row + KV
  await task('Registering domain in the database', async () => {
    await ctx.db.runSql(`
      insert into shortener.domains (apex, zone_id, registrar, serve_www, wildcard, wildcard_mode, home_url, code_length, is_admin_host, status)
      values (${lit(d.apex)}, ${lit(zone.id)}, ${lit(d.registrar)}, ${lit(d.serveWww)}, ${lit(d.wildcard)}, ${lit(d.wildcardMode)},
              ${lit(d.homeUrl ?? null)}, ${lit(d.codeLength)}, ${lit(d.isAdminHost)}, 'active')
      on conflict (apex) do update set zone_id = excluded.zone_id, registrar = excluded.registrar, serve_www = excluded.serve_www,
        wildcard = excluded.wildcard, wildcard_mode = excluded.wildcard_mode, home_url = excluded.home_url,
        is_admin_host = excluded.is_admin_host or shortener.domains.is_admin_host, status = 'active', updated_at = now();`)
    const rows = await ctx.db.runSql(`select row_to_json(d)::text as j from shortener.domains d where apex = ${lit(d.apex)}`)
    const kvId = s.resources?.kvId
    if (kvId) {
      if (rows[0]?.j) await kvPut(cf, kvId, `__domain/${d.apex}`, String(rows[0].j))
      await kvDelete(cf, kvId, '__domains_all') // the Worker rebuilds the index from Postgres
    }
  })
  mark('db')

  await task('Deploying routes', async () => {
    writeConfigs(s)
    await deployAll(s, ctx.auth)
  })
  mark('routes')
  // Best effort: wildcard route fails closed (no origin fallback when the Worker errors or is over limit).
  if (d.wildcard) await failClosed(cf, zone.id, `*.${d.apex}/*`).catch(() => p.log.warn('Could not set the wildcard route to fail closed; set it in the dashboard (Workers Routes → Request limit failure mode).'))

  const drift = (await zoneDrift(cf, zone.id, { wildcard: d.wildcard, apex: d.apex })).filter((x) => !x.ok && x.check !== 'DNSSEC active')
  for (const x of drift) p.log.warn(`${d.apex}: ${x.check} — ${x.detail ?? 'not ok'}`)

  // 7. smoke
  if (ctx.apiKey) {
    await runSmoke({ host: d.apex, adminHost: adminHostOf(s) ?? d.apex, apiKey: ctx.apiKey, cf, wait: true })
    mark('smoke')
  } else {
    p.log.info(`Smoke skipped (no API key in memory). Run: SHORTENER_API_KEY=… npm run smoke ${d.apex}`)
  }
}

async function failClosed(cf: CF, zoneId: string, pattern: string) {
  const routes = await cf.get<{ id: string; pattern: string; script?: string }[]>(`/zones/${zoneId}/workers/routes`)
  const r = routes.find((x) => x.pattern === pattern)
  if (!r) return
  await cf.put(`/zones/${zoneId}/workers/routes/${r.id}`, { pattern, script: r.script, request_limit_fail_open: false })
}

export function adminHostOf(s: State): string | undefined {
  return Object.values(s.domains).find((d) => d.isAdminHost)?.apex
}

export async function confirmApexFromArgs(arg?: string): Promise<string | undefined> {
  if (!arg) return undefined
  const apex = arg.toLowerCase().replace(/\.$/, '')
  if (!APEX_RE.test(apex)) throw new Error(`invalid domain: ${arg}`)
  return apex
}
