import { Hono } from 'hono'
import { describeError, pgErrorResponse, type AppEnv } from './app.js'
import { authApi } from './auth.js'
import { domainsApi } from './domains.js'
import { keysApi } from './keys.js'
import { linksApi } from './links.js'
import { opsApi } from './ops.js'
import { openapi } from './openapi.js'
import { statsApi } from './stats.js'

export const api = new Hono<AppEnv>().basePath('/_/api')

api.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'private, no-store, max-age=0')
  c.header('X-Robots-Tag', 'noindex')
})

/** Public: what the admin UI needs to start its login flow. */
api.get('/config', (c) =>
  c.json({
    auth: c.env.SUPABASE_URL && c.env.SUPABASE_ANON_KEY
      ? { provider: 'supabase', url: c.env.SUPABASE_URL, anon_key: c.env.SUPABASE_ANON_KEY, password: true }
      : { provider: 'password' },
    mode: c.env.MODE,
  }),
)

api.get('/openapi.json', (c) => c.json(openapi(`${new URL(c.req.url).origin}/_/api`)))

api.route('/auth', authApi)
api.route('/links', linksApi)
api.route('/domains', domainsApi)
api.route('/keys', keysApi)
api.route('/stats', statsApi)
api.route('/ops', opsApi)

api.notFound((c) => c.json({ error: 'not_found' }, 404))
api.onError((err, c) => {
  const pg = pgErrorResponse(err)
  console.error('api-error', JSON.stringify({ method: c.req.method, path: new URL(c.req.url).pathname, ...describeError(err) }))
  if (pg) return c.json(pg.body, pg.status)
  return c.json({ error: 'internal' }, 500)
})
