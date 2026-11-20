import type { Env } from './env.js'
import { api } from './api/index.js'
import { runScheduled } from './lib/cron.js'
import { handleRequest } from './router.js'

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(req, env, ctx, (r, e, c) => api.fetch(r, e, c))
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(event.cron, env, event.scheduledTime))
  },
} satisfies ExportedHandler<Env>
