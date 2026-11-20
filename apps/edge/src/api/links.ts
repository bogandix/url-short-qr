import { z } from 'zod'
import {
  generateCode,
  isValidVanity,
  kvKey,
  pickCodeLength,
  readCode,
  resolveHost,
  type DomainRow,
} from '@shortener/shared'
import { canAccess } from '../lib/auth.js'
import { adminSqlClient, pgArray, withSql, type Sql } from '../lib/db.js'
import { loadDomains } from '../lib/domains.js'
import { linkToKv } from '../lib/lookup.js'
import { shortPayload } from '../lib/qr.js'
import { authed, newApi, scope, type Ctx } from './app.js'

export const linksApi = newApi()
linksApi.use('*', authed)

const httpUrl = z.string().url().max(4096).regex(/^https?:\/\//i, 'must be http(s)')

const LinkInput = z.object({
  namespace: z.string().min(1).max(253).transform((s) => s.toLowerCase()),
  target_url: httpUrl,
  code: z.string().max(64).optional(),
  title: z.string().max(500).optional(),
  tags: z.array(z.string().max(64)).max(50).optional(),
  owner: z.string().max(200).optional(),
  utm: z.record(z.string(), z.string().max(200)).optional(),
  append_utm: z.boolean().optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
  fallback_url: httpUrl.optional(),
  /** Caller's own id (e.g. a vrumvrum listing id). Unique per owner: re-POSTing returns the existing link. */
  external_id: z.string().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
type LinkInput = z.infer<typeof LinkInput>

const LinkPatch = z
  .object({
    target_url: httpUrl,
    title: z.string().max(500).nullable(),
    tags: z.array(z.string().max(64)).max(50),
    owner: z.string().max(200).nullable(),
    utm: z.record(z.string(), z.string().max(200)),
    append_utm: z.boolean(),
    status: z.enum(['active', 'paused']),
    expires_at: z.string().datetime({ offset: true }).nullable(),
    fallback_url: httpUrl.nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .partial()
  .strict()

type LinkRow = {
  id: string
  namespace: string
  code: string
  target_url: string
  title: string | null
  tags: string[]
  owner: string | null
  utm: Record<string, string>
  append_utm: boolean
  status: string
  expires_at: Date | null
  fallback_url: string | null
  version: number
  external_id: string | null
  metadata: Record<string, unknown>
  created_by: string | null
  created_at: Date
  updated_at: Date
}

class ApiError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 507,
    public code: string,
    public detail?: unknown,
  ) {
    super(code)
  }
}

function fail(c: Ctx, err: unknown) {
  if (err instanceof ApiError) return c.json({ error: err.code, detail: err.detail }, err.status)
  if (err instanceof z.ZodError) return c.json({ error: 'invalid_body', detail: err.flatten() }, 400)
  if (err instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400)
  throw err
}

/** A link's namespace must be one a configured host resolves to (apex or namespace-mode subdomain). */
function domainFor(namespace: string, domains: DomainRow[]): DomainRow {
  const r = resolveHost(namespace, domains)
  if (r.kind !== 'ok' || r.namespace !== namespace) throw new ApiError(400, 'unknown_namespace', namespace)
  return r.domain
}

function present(row: LinkRow) {
  const origin = `https://${row.namespace}`
  return {
    ...row,
    short_url: `${origin}/${row.code}`,
    qr: { svg: `${origin}/_/qr/${row.code}.svg`, png: `${origin}/_/qr/${row.code}.png`, payload: shortPayload(row.namespace, row.code) },
  }
}

async function createOne(sql: Sql, c: Ctx, input: LinkInput, domains: DomainRow[]): Promise<LinkRow & { existed?: boolean }> {
  const auth = c.get('auth')
  const domain = domainFor(input.namespace, domains)
  if (!canAccess(auth, input.namespace, input.owner)) throw new ApiError(403, 'namespace_or_owner_not_allowed')

  if (input.external_id) {
    const prior = await sql<LinkRow[]>`
      select * from shortener.links
      where coalesce(owner, '') = ${input.owner ?? ''} and external_id = ${input.external_id} limit 1`
    if (prior[0]) return { ...prior[0], existed: true }
  }

  let code: string | null = null
  if (input.code) {
    code = readCode(input.code)
    if (!code || !isValidVanity(code)) throw new ApiError(400, 'invalid_code')
  }

  const insert = (cd: string) => sql<LinkRow[]>`
    insert into shortener.links (namespace, code, target_url, title, tags, owner, utm, append_utm, expires_at, fallback_url,
                                 external_id, metadata, created_by)
    values (${input.namespace}, ${cd}, ${input.target_url}, ${input.title ?? null}, ${pgArray(input.tags ?? [])}::text[],
            ${input.owner ?? null}, ${JSON.stringify(input.utm ?? {})}::jsonb, ${input.append_utm ?? false},
            ${input.expires_at ?? null}::timestamptz, ${input.fallback_url ?? null},
            ${input.external_id ?? null}, ${JSON.stringify(input.metadata ?? {})}::jsonb, ${auth.actor})
    on conflict (namespace, code) do nothing
    returning *`

  if (code) {
    const rows = await insert(code)
    if (!rows[0]) throw new ApiError(409, 'code_taken', code)
    return rows[0]
  }

  const len = await pickCodeLength(domain.code_length, async (l) => {
    const r = await sql<{ n: string }[]>`
      select count(*)::text as n from shortener.links where namespace = ${input.namespace} and length(code) = ${l}`
    return Number(r[0]!.n)
  })
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = generateCode(len, (n) => crypto.getRandomValues(new Uint8Array(n)))
    const rows = await insert(candidate)
    if (rows[0]) return rows[0]
  }
  throw new ApiError(507, 'code_space_exhausted')
}

async function audit(sql: Sql, actor: string, action: string, row: Pick<LinkRow, 'namespace' | 'code'>, before: unknown, after: unknown) {
  await sql`
    insert into shortener.audit (actor, action, namespace, code, before, after)
    values (${actor}, ${action}, ${row.namespace}, ${row.code},
            ${before == null ? null : JSON.stringify(before)}::jsonb, ${after == null ? null : JSON.stringify(after)}::jsonb)`
}

async function writeKv(c: Ctx, rows: LinkRow[]) {
  await Promise.all(rows.map((r) => c.env.LINKS.put(kvKey(r.namespace, r.code), JSON.stringify(linkToKv(r)))))
}

// POST /links
linksApi.post('/', scope('links:write'), async (c) => {
  try {
    const input = LinkInput.parse(await c.req.json())
    const domains = await loadDomains(c.env)
    const row = await withSql(
      () => adminSqlClient(c.env),
      (sql) =>
        sql.begin(async (tx) => {
          const r = await createOne(tx as unknown as Sql, c, input, domains)
          if (!r.existed) await audit(tx as unknown as Sql, c.get('auth').actor, 'link.create', r, null, r)
          return r
        }),
    )
    const { existed, ...link } = row
    if (existed) return c.json({ ...present(link), existed: true }, 200)
    await writeKv(c, [link]) // database first, then KV
    return c.json(present(link), 201)
  } catch (err) {
    return fail(c, err)
  }
})

// POST /links/bulk — all or nothing
linksApi.post('/bulk', scope('links:write'), async (c) => {
  try {
    const body = z.object({ items: z.array(LinkInput).min(1).max(500) }).parse(await c.req.json())
    const domains = await loadDomains(c.env)
    const rows = await withSql(
      () => adminSqlClient(c.env),
      (sql) =>
        sql.begin(async (tx) => {
          const out: LinkRow[] = []
          for (const [i, item] of body.items.entries()) {
            try {
              const r = await createOne(tx as unknown as Sql, c, item, domains)
              if (!r.existed) await audit(tx as unknown as Sql, c.get('auth').actor, 'link.create', r, null, r)
              out.push(r)
            } catch (err) {
              if (err instanceof ApiError) throw new ApiError(err.status, err.code, { index: i, detail: err.detail })
              throw err
            }
          }
          return out
        }),
    )
    await writeKv(c, rows)
    return c.json({ items: rows.map((r) => present(r)) }, 201)
  } catch (err) {
    return fail(c, err)
  }
})

// GET /links — keyset pagination on (updated_at, id)
linksApi.get('/', scope('links:read'), async (c) => {
  const auth = c.get('auth')
  const q = c.req.query()
  const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50))
  let cursor: { u: string; id: string } | null = null
  if (q.cursor) {
    try {
      cursor = JSON.parse(atob(q.cursor))
    } catch {
      return c.json({ error: 'bad_cursor' }, 400)
    }
  }
  const nsFilter = auth.namespaces?.length ? auth.namespaces : null
  const rows = await withSql(
    () => adminSqlClient(c.env),
    (sql) => sql<LinkRow[]>`
      select * from shortener.links
      where (${q.namespace ?? null}::text is null or namespace = ${q.namespace ?? null})
        and (${q.owner ?? null}::text is null or owner = ${q.owner ?? null})
        and (${q.tag ?? null}::text is null or ${q.tag ?? null} = any(tags))
        and (${q.external_id ?? null}::text is null or external_id = ${q.external_id ?? null})
        and (${q.status ?? null}::text is null and status <> 'archived' or status = ${q.status ?? null})
        and (${q.q ?? null}::text is null or code ilike '%' || ${q.q ?? null} || '%'
             or title ilike '%' || ${q.q ?? null} || '%' or target_url ilike '%' || ${q.q ?? null} || '%')
        and (${pgArray(nsFilter)}::text[] is null or namespace = any(${pgArray(nsFilter)}::text[]))
        and (${auth.ownerPrefix}::text is null or owner like ${(auth.ownerPrefix ?? '').replace(/[%_\\]/g, '\\$&')} || '%')
        and (${cursor?.u ?? null}::timestamptz is null
             or (updated_at, id) < (${cursor?.u ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
      order by updated_at desc, id desc
      limit ${limit}`,
  )
  const last = rows[rows.length - 1]
  const next = rows.length === limit && last ? btoa(JSON.stringify({ u: last.updated_at.toISOString(), id: last.id })) : null
  return c.json({ items: rows.map((r) => present(r)), next_cursor: next })
})

async function getLink(c: Ctx, sql: Sql): Promise<LinkRow> {
  const namespace = c.req.param('namespace')!.toLowerCase()
  const code = readCode(c.req.param('code')!)
  if (!code) throw new ApiError(400, 'invalid_code')
  const rows = await sql<LinkRow[]>`select * from shortener.links where namespace = ${namespace} and code = ${code}`
  const row = rows[0]
  if (!row || !canAccess(c.get('auth'), row.namespace, row.owner)) throw new ApiError(404, 'not_found')
  return row
}

// GET /links/by-external/:external_id?owner= — the integration lookup (owner defaults to none).
linksApi.get('/by-external/:external_id', scope('links:read'), async (c) => {
  const auth = c.get('auth')
  const owner = c.req.query('owner') ?? null
  const rows = await withSql(
    () => adminSqlClient(c.env),
    (sql) => sql<LinkRow[]>`
      select * from shortener.links
      where external_id = ${c.req.param('external_id')} and coalesce(owner, '') = ${owner ?? ''} limit 1`,
  )
  const row = rows[0]
  if (!row || !canAccess(auth, row.namespace, row.owner)) return c.json({ error: 'not_found' }, 404)
  return c.json(present(row))
})

linksApi.get('/:namespace/:code', scope('links:read'), async (c) => {
  try {
    const out = await withSql(
      () => adminSqlClient(c.env),
      async (sql) => {
        const row = await getLink(c, sql)
        const history = await sql`
          select ts, actor, action, before, after from shortener.audit
          where namespace = ${row.namespace} and code = ${row.code} order by ts desc limit 100`
        return { ...present(row), audit: history }
      },
    )
    return c.json(out)
  } catch (err) {
    return fail(c, err)
  }
})

linksApi.patch('/:namespace/:code', scope('links:write'), async (c) => {
  try {
    const patch = LinkPatch.parse(await c.req.json())
    const auth = c.get('auth')
    if (patch.owner !== undefined && !canAccess(auth, c.req.param('namespace')!.toLowerCase(), patch.owner)) {
      throw new ApiError(403, 'owner_not_allowed')
    }
    const row = await withSql(
      () => adminSqlClient(c.env),
      (sql) =>
        sql.begin(async (txRaw) => {
          const tx = txRaw as unknown as Sql
          const before = await getLink(c, tx)
          if (before.status === 'archived') throw new ApiError(409, 'archived')
          const set = (k: keyof typeof patch) => patch[k] !== undefined
          const rows = await tx<LinkRow[]>`
            update shortener.links set
              target_url   = case when ${set('target_url')} then ${patch.target_url ?? null} else target_url end,
              title        = case when ${set('title')} then ${patch.title ?? null} else title end,
              tags         = case when ${set('tags')} then ${pgArray(patch.tags ?? [])}::text[] else tags end,
              owner        = case when ${set('owner')} then ${patch.owner ?? null} else owner end,
              utm          = case when ${set('utm')} then ${JSON.stringify(patch.utm ?? {})}::jsonb else utm end,
              append_utm   = case when ${set('append_utm')} then ${patch.append_utm ?? false} else append_utm end,
              status       = case when ${set('status')} then ${patch.status ?? 'active'} else status end,
              expires_at   = case when ${set('expires_at')} then ${patch.expires_at ?? null}::timestamptz else expires_at end,
              fallback_url = case when ${set('fallback_url')} then ${patch.fallback_url ?? null} else fallback_url end,
              metadata     = case when ${set('metadata')} then ${JSON.stringify(patch.metadata ?? {})}::jsonb else metadata end,
              version = version + 1, updated_at = now()
            where id = ${before.id}::uuid
            returning *`
          const after = rows[0]!
          const action = patch.status && patch.status !== before.status ? `link.${patch.status === 'paused' ? 'pause' : 'resume'}` : 'link.update'
          await audit(tx, auth.actor, action, after, before, after)
          return after
        }),
    )
    await writeKv(c, [row])
    return c.json(present(row))
  } catch (err) {
    return fail(c, err)
  }
})

// DELETE archives; the code is never reused.
linksApi.delete('/:namespace/:code', scope('links:write'), async (c) => {
  try {
    const row = await withSql(
      () => adminSqlClient(c.env),
      (sql) =>
        sql.begin(async (txRaw) => {
          const tx = txRaw as unknown as Sql
          const before = await getLink(c, tx)
          const rows = await tx<LinkRow[]>`
            update shortener.links set status = 'archived', version = version + 1, updated_at = now()
            where id = ${before.id}::uuid returning *`
          await audit(tx, c.get('auth').actor, 'link.archive', rows[0]!, before, rows[0])
          return rows[0]!
        }),
    )
    await writeKv(c, [row])
    return c.json({ ok: true, status: 'archived' })
  } catch (err) {
    return fail(c, err)
  }
})

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

linksApi.get('/:namespace/:code/stats', scope('stats:read'), async (c) => {
  try {
    const from = c.req.query('from') ?? new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)
    const to = c.req.query('to') ?? new Date().toISOString().slice(0, 10)
    const interval = c.req.query('interval') === 'hour' ? 'hour' : 'day'
    if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw new ApiError(400, 'bad_range')
    const out = await withSql(
      () => adminSqlClient(c.env),
      async (sql) => {
        const link = await getLink(c, sql)
        const daily = await sql`
          select day::text, outcome, clicks, uniques, bots, by_country, by_city, by_device, by_os, by_browser, by_referer
          from shortener.clicks_daily
          where namespace = ${link.namespace} and code = ${link.code}
            and day >= ${from}::date and day <= ${to}::date
          order by day`
        // Raw rows for days not yet rolled up (today, and yesterday before 00:15).
        const live = await sql`
          select date_trunc(${interval}, ts) as bucket, outcome,
                 count(*)::int as clicks,
                 count(distinct visitor_hash) filter (where not is_bot)::int as uniques,
                 count(*) filter (where is_bot)::int as bots
          from shortener.clicks
          where namespace = ${link.namespace} and code = ${link.code}
            and ts >= greatest(${from}::date, coalesce((
              select max(day) + 1 from shortener.clicks_daily where namespace = ${link.namespace} and code = ${link.code}
            ), ${from}::date))
            and ts < ${to}::date + 1
          group by 1, 2 order by 1`
        const breakdown = await sql`
          select coalesce(country, '??') as country, coalesce(city, '') as city, coalesce(device, '') as device,
                 coalesce(os, '') as os, count(*)::int as n
          from shortener.clicks
          where namespace = ${link.namespace} and code = ${link.code} and ts >= current_date and not is_bot
          group by 1, 2, 3, 4`
        return { link: { namespace: link.namespace, code: link.code }, from, to, interval, daily, live, today_breakdown: breakdown }
      },
    )
    return c.json(out)
  } catch (err) {
    return fail(c, err)
  }
})

// Raw rows, without hashes; cursor = (ts, id) of the last row.
linksApi.get('/:namespace/:code/clicks', scope('stats:read'), async (c) => {
  try {
    let cursor: { ts: string; id: string } | null = null
    const raw = c.req.query('cursor')
    if (raw) {
      try {
        cursor = JSON.parse(atob(raw))
      } catch {
        throw new ApiError(400, 'bad_cursor')
      }
    }
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100) || 100))
    const rows = await withSql(
      () => adminSqlClient(c.env),
      async (sql) => {
        const link = await getLink(c, sql)
        return sql<{ id: string; ts: Date }[]>`
          select id, ts, host, outcome, method, path, query, scheme, country, region, region_code, city,
                 timezone, colo, asn, as_org, ua, device, os, browser, browser_version, lang, referer,
                 is_bot, bot_name, ray_id, source
          from shortener.clicks
          where namespace = ${link.namespace} and code = ${link.code}
            and (${cursor?.ts ?? null}::timestamptz is null or (ts, id) < (${cursor?.ts ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
          order by ts desc, id desc
          limit ${limit}`
      },
    )
    const last = rows[rows.length - 1]
    const next = rows.length === limit && last ? btoa(JSON.stringify({ ts: last.ts.toISOString(), id: last.id })) : null
    return c.json({ items: rows, next_cursor: next })
  } catch (err) {
    return fail(c, err)
  }
})
