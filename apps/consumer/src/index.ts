import postgres from 'postgres'
import { buildBulkInsert, ClickEventSchema, type ClickEvent } from '@shortener/shared'

export type Env = { DB: Hyperdrive }

/**
 * Paid mode: one multi-row INSERT … ON CONFLICT DO NOTHING per batch.
 * Duplicate deliveries are harmless (PK id, ts). Malformed messages are acked
 * individually after logging so they cannot block the batch; on database
 * failure the whole batch is retried (retry_delay 30 s, then the DLQ).
 */
export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const good: { msg: Message<unknown>; ev: ClickEvent }[] = []
    for (const msg of batch.messages) {
      const parsed = ClickEventSchema.safeParse(msg.body)
      if (parsed.success) good.push({ msg, ev: parsed.data })
      else {
        console.error('consumer-bad-message', msg.id, JSON.stringify(msg.body).slice(0, 2000))
        msg.ack()
      }
    }
    if (good.length === 0) return

    const sql = postgres(env.DB.connectionString, { max: 1, fetch_types: false, prepare: false, connect_timeout: 5 })
    try {
      const { sql: text, params } = buildBulkInsert(good.map((g) => g.ev))
      await sql.unsafe(text, params as never[])
      for (const g of good) g.msg.ack()
    } catch (err) {
      console.error('consumer-insert-failed', good.length, String(err))
      for (const g of good) g.msg.retry({ delaySeconds: 30 })
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {})
    }
  },
} satisfies ExportedHandler<Env>
