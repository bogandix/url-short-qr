import { Hono, type Context, type MiddlewareHandler } from 'hono'
import type { Env } from '../env.js'
import { authenticate, requireScope, type AuthContext } from '../lib/auth.js'

export type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }
export type Ctx = Context<AppEnv>

export function newApi() {
  return new Hono<AppEnv>()
}

/** Authenticate once per request; 401 when missing/invalid. */
export const authed: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ctx = await authenticate(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext)
  if (!ctx) return c.json({ error: 'unauthorized' }, 401)
  c.set('auth', ctx)
  await next()
}

export function scope(s: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!requireScope(c.get('auth'), s)) return c.json({ error: 'forbidden', need: s }, 403)
    await next()
  }
}

type PgError = { code?: string; message?: string; detail?: string; constraint_name?: string; column_name?: string }

/** Postgres errors that are the caller's fault → 400/409 with a reason instead of a bare 500. */
export function pgErrorResponse(err: unknown): { status: 400 | 409; body: { error: string; detail?: string } } | null {
  const e = err as PgError
  if (!e || typeof e.code !== 'string') return null
  if (e.code === '23505') return { status: 409, body: { error: 'conflict', detail: e.constraint_name } }
  if (e.code === '23514') return { status: 400, body: { error: 'invalid_value', detail: e.constraint_name } }
  if (e.code === '23502') return { status: 400, body: { error: 'missing_value', detail: e.column_name } }
  if (e.code.startsWith('22')) return { status: 400, body: { error: 'invalid_value', detail: e.message } }
  return null
}

/** One log line with what Postgres actually said (postgres.js keeps it out of the stack). */
export function describeError(err: unknown): Record<string, unknown> {
  const e = err as PgError & { name?: string; stack?: string; severity?: string; routine?: string }
  return {
    name: e?.name,
    message: e?.message,
    code: e?.code,
    detail: e?.detail,
    constraint: e?.constraint_name,
    column: e?.column_name,
    stack: e?.stack?.split('\n').slice(0, 6).join(' | '),
  }
}
