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
