import { hashPassword, passwordProblem, verifyPassword } from '@shortener/shared'
import { z } from 'zod'
import { adminSqlClient, withSql } from '../lib/db.js'
import { checkRateLimit } from '../lib/ratelimit.js'
import { issueSession, readSession } from '../lib/session.js'
import { clearAuthCaches } from '../lib/auth.js'
import { newApi } from './app.js'

/** Built-in admin login: POST /_/api/auth/login, /auth/password, /auth/logout-all. */
export const authApi = newApi()

const MAX_FAILS = 10
const LOCK_MINUTES = 15

type AdminRow = {
  email: string
  password_hash: string | null
  must_change_password: boolean
  failed_attempts: number
  locked_until: Date | null
  session_epoch: number
}

const Login = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(200) })

authApi.post('/login', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
  if (!(await checkRateLimit(c.env, `login:${ip}`))) return c.json({ error: 'rate_limited' }, 429)
  const parsed = Login.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const email = parsed.data.email.toLowerCase()

  const result = await withSql(
    () => adminSqlClient(c.env),
    async (sql) => {
      const rows = await sql<AdminRow[]>`
        select email, password_hash, must_change_password, failed_attempts, locked_until, session_epoch
        from shortener.admins where email = ${email}`
      const a = rows[0]
      if (a?.locked_until && a.locked_until.getTime() > Date.now()) {
        await verifyPassword(parsed.data.password, null) // constant cost
        return { error: 'locked' as const }
      }
      const ok = await verifyPassword(parsed.data.password, a?.password_hash)
      if (!a || !ok) {
        if (a) {
          await sql`
            update shortener.admins set
              failed_attempts = failed_attempts + 1,
              locked_until = case when failed_attempts + 1 >= ${MAX_FAILS} then now() + make_interval(mins => ${LOCK_MINUTES}) else locked_until end
            where email = ${email}`
        }
        return { error: 'invalid_credentials' as const }
      }
      await sql`update shortener.admins set failed_attempts = 0, locked_until = null where email = ${email}`
      await sql`insert into shortener.audit (actor, action) values (${`admin:${email}`}, 'auth.login')`
      return { admin: a }
    },
  )
  if ('error' in result) return c.json({ error: result.error }, result.error === 'locked' ? 429 : 401)
  const s = await issueSession(c.env, email, result.admin.session_epoch, result.admin.must_change_password)
  return c.json({ token: s.token, expires_at: new Date(s.exp * 1000).toISOString(), email, must_change_password: result.admin.must_change_password })
})

const Change = z.object({ current_password: z.string().min(1).max(200), new_password: z.string() })

/** Works with a must-change session too; bumps the epoch so older sessions stop working. */
authApi.post('/password', async (c) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/, '') ?? ''
  const claims = await readSession(c.env, token)
  if (!claims) return c.json({ error: 'unauthorized' }, 401)
  const parsed = Change.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const problem = passwordProblem(parsed.data.new_password)
  if (problem) return c.json({ error: 'weak_password', detail: problem }, 400)
  if (parsed.data.new_password === parsed.data.current_password) return c.json({ error: 'same_password' }, 400)

  const out = await withSql(
    () => adminSqlClient(c.env),
    async (sql) => {
      const rows = await sql<AdminRow[]>`select * from shortener.admins where email = ${claims.sub}`
      const a = rows[0]
      if (!a || a.session_epoch !== claims.ep) return { error: 'unauthorized' as const }
      if (!(await verifyPassword(parsed.data.current_password, a.password_hash))) return { error: 'invalid_credentials' as const }
      const hash = await hashPassword(parsed.data.new_password)
      const up = await sql<{ session_epoch: number }[]>`
        update shortener.admins set password_hash = ${hash}, must_change_password = false, password_changed_at = now(),
          session_epoch = session_epoch + 1, failed_attempts = 0, locked_until = null
        where email = ${claims.sub} returning session_epoch`
      await sql`insert into shortener.audit (actor, action) values (${`admin:${claims.sub}`}, 'auth.password_change')`
      return { epoch: up[0]!.session_epoch }
    },
  )
  if ('error' in out) return c.json({ error: out.error }, 401)
  clearAuthCaches()
  const s = await issueSession(c.env, claims.sub, out.epoch, false)
  return c.json({ token: s.token, expires_at: new Date(s.exp * 1000).toISOString(), email: claims.sub, must_change_password: false })
})

authApi.post('/logout-all', async (c) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/, '') ?? ''
  const claims = await readSession(c.env, token)
  if (!claims) return c.json({ error: 'unauthorized' }, 401)
  await withSql(
    () => adminSqlClient(c.env),
    (sql) => sql`update shortener.admins set session_epoch = session_epoch + 1 where email = ${claims.sub} and session_epoch = ${claims.ep}`,
  )
  clearAuthCaches()
  return c.json({ ok: true })
})
