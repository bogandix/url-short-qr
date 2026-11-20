import { z } from 'zod'
import type { DomainRow } from '@shortener/shared'
import { adminSqlClient, withSql } from '../lib/db.js'
import { publishDomains } from '../lib/domains.js'
import { authed, newApi, scope } from './app.js'

export const domainsApi = newApi()
domainsApi.use('*', authed, scope('domains:admin'))

const apexRe = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const url = z.string().url().regex(/^https?:\/\//)

const DomainInput = z.object({
  apex: z.string().transform((s) => s.toLowerCase().replace(/\.$/, '')).pipe(z.string().regex(apexRe)),
  serve_www: z.boolean().default(true),
  wildcard: z.boolean().default(false),
  wildcard_mode: z.enum(['namespace', 'alias']).default('namespace'),
  home_url: url.nullable().optional(),
  not_found_url: url.nullable().optional(),
  code_length: z.number().int().min(1).max(8).default(4),
  is_admin_host: z.boolean().default(false),
  registrar: z.string().max(32).nullable().optional(),
  zone_id: z.string().max(64).nullable().optional(),
  status: z.enum(['active', 'pending_ns', 'disabled']).default('pending_ns'),
})

const DomainPatch = DomainInput.omit({ apex: true }).partial().strict()

domainsApi.get('/', async (c) => {
  const rows = await withSql(() => adminSqlClient(c.env), (sql) => sql`select * from shortener.domains order by apex`)
  return c.json({ items: rows })
})

domainsApi.post('/', async (c) => {
  const parsed = DomainInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400)
  const d = parsed.data
  const actor = c.get('auth').actor
  const row = await withSql(
    () => adminSqlClient(c.env),
    async (sql) => {
      const rows = await sql<DomainRow[]>`
        insert into shortener.domains (apex, serve_www, wildcard, wildcard_mode, home_url, not_found_url,
                                       code_length, is_admin_host, registrar, zone_id, status)
        values (${d.apex}, ${d.serve_www}, ${d.wildcard}, ${d.wildcard_mode}, ${d.home_url ?? null}, ${d.not_found_url ?? null},
                ${d.code_length}, ${d.is_admin_host}, ${d.registrar ?? null}, ${d.zone_id ?? null}, ${d.status})
        on conflict (apex) do update set
          serve_www = excluded.serve_www, wildcard = excluded.wildcard, wildcard_mode = excluded.wildcard_mode,
          home_url = excluded.home_url, not_found_url = excluded.not_found_url, code_length = excluded.code_length,
          is_admin_host = excluded.is_admin_host,
          registrar = coalesce(excluded.registrar, shortener.domains.registrar),
          zone_id = coalesce(excluded.zone_id, shortener.domains.zone_id),
          status = excluded.status, updated_at = now()
        returning *`
      await sql`insert into shortener.audit (actor, action, namespace, after)
                values (${actor}, 'domain.upsert', ${d.apex}, ${JSON.stringify(rows[0])}::jsonb)`
      await publishDomains(c.env, sql)
      return rows[0]!
    },
  )
  return c.json(row, 201)
})

domainsApi.patch('/:id', async (c) => {
  const parsed = DomainPatch.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400)
  const p = parsed.data
  const has = (k: keyof typeof p) => p[k] !== undefined
  const id = c.req.param('id')
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: 'bad_id' }, 400)
  const actor = c.get('auth').actor
  const row = await withSql(
    () => adminSqlClient(c.env),
    async (sql) => {
      const before = await sql<DomainRow[]>`select * from shortener.domains where id = ${id}::uuid`
      if (!before[0]) return null
      const rows = await sql<DomainRow[]>`
        update shortener.domains set
          serve_www     = case when ${has('serve_www')} then ${p.serve_www ?? true} else serve_www end,
          wildcard      = case when ${has('wildcard')} then ${p.wildcard ?? false} else wildcard end,
          wildcard_mode = case when ${has('wildcard_mode')} then ${p.wildcard_mode ?? 'namespace'} else wildcard_mode end,
          home_url      = case when ${has('home_url')} then ${p.home_url ?? null} else home_url end,
          not_found_url = case when ${has('not_found_url')} then ${p.not_found_url ?? null} else not_found_url end,
          code_length   = case when ${has('code_length')} then ${p.code_length ?? 4} else code_length end,
          is_admin_host = case when ${has('is_admin_host')} then ${p.is_admin_host ?? false} else is_admin_host end,
          registrar     = case when ${has('registrar')} then ${p.registrar ?? null} else registrar end,
          zone_id       = case when ${has('zone_id')} then ${p.zone_id ?? null} else zone_id end,
          status        = case when ${has('status')} then ${p.status ?? 'active'} else status end,
          updated_at = now()
        where id = ${id}::uuid returning *`
      await sql`insert into shortener.audit (actor, action, namespace, before, after)
                values (${actor}, 'domain.update', ${rows[0]!.apex}, ${JSON.stringify(before[0])}::jsonb, ${JSON.stringify(rows[0])}::jsonb)`
      await publishDomains(c.env, sql)
      return rows[0]!
    },
  )
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(row)
})
