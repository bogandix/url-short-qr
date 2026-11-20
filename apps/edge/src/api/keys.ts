import { z } from 'zod'
import { ALL_SCOPES, clearAuthCaches, sha256Hex } from '../lib/auth.js'
import { adminSqlClient, pgArray, withSql } from '../lib/db.js'
import { authed, newApi, scope } from './app.js'

export const keysApi = newApi()
keysApi.use('*', authed, scope('keys:admin'))

export function randomApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return `sk_live_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

const KeyInput = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(ALL_SCOPES)).min(1),
  owner_prefix: z.string().max(200).nullable().optional(),
  namespaces: z.array(z.string().max(253)).max(100).nullable().optional(),
})

keysApi.get('/', async (c) => {
  const rows = await withSql(
    () => adminSqlClient(c.env),
    (sql) => sql`select id, name, scopes, owner_prefix, namespaces, created_at, last_used_at, revoked_at
                 from shortener.api_keys order by created_at desc`,
  )
  return c.json({ items: rows })
})

keysApi.post('/', async (c) => {
  const parsed = KeyInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400)
  const b = parsed.data
  const key = randomApiKey()
  const hash = await sha256Hex(key)
  const actor = c.get('auth').actor
  const row = await withSql(
    () => adminSqlClient(c.env),
    async (sql) => {
      const rows = await sql`
        insert into shortener.api_keys (name, key_hash, scopes, owner_prefix, namespaces)
        values (${b.name}, ${hash}, ${pgArray(b.scopes)}::text[], ${b.owner_prefix ?? null}, ${pgArray(b.namespaces)}::text[])
        returning id, name, scopes, owner_prefix, namespaces, created_at`
      await sql`insert into shortener.audit (actor, action, after)
                values (${actor}, 'key.create', ${JSON.stringify(rows[0])}::jsonb)`
      return rows[0]
    },
  )
  // The only time the key is ever returned.
  return c.json({ ...row, key }, 201)
})

keysApi.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: 'bad_id' }, 400)
  const actor = c.get('auth').actor
  const n = await withSql(
    () => adminSqlClient(c.env),
    async (sql) => {
      const r = await sql`update shortener.api_keys set revoked_at = now() where id = ${id}::uuid and revoked_at is null`
      await sql`insert into shortener.audit (actor, action, after) values (${actor}, 'key.revoke', ${JSON.stringify({ id })}::jsonb)`
      return r.count
    },
  )
  clearAuthCaches() // this isolate; others expire within 60 s
  return n ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
})
