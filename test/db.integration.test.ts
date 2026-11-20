import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildBulkInsert, clickParams, INSERT_CLICK_SQL, type ClickEvent } from '../packages/shared/src/index.js'

const dir = join(import.meta.dirname, '..', 'migrations')
let pg: PGlite

function ev(over: Partial<ClickEvent> = {}): ClickEvent {
  return {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    host: 'short.example',
    namespace: 'short.example',
    code: 'A7K2',
    link_id: null,
    outcome: 'redirect',
    method: 'GET',
    path: '/A7K2',
    query: null,
    scheme: 'https',
    country: 'RO',
    region: 'Bucharest',
    region_code: 'B',
    city: 'Bucharest',
    timezone: 'Europe/Bucharest',
    colo: 'OTP',
    asn: 8708,
    as_org: 'RCS',
    ua: 'Mozilla',
    device: 'mobile',
    os: 'iOS 18',
    browser: 'Safari',
    browser_version: '18',
    lang: 'ro',
    referer: null,
    ip_hash: 'a'.repeat(32),
    visitor_hash: 'v1',
    is_bot: false,
    bot_name: null,
    ray_id: 'ray',
    source: 'live',
    ...over,
  }
}

beforeAll(async () => {
  pg = new PGlite()
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(dir, f), 'utf8'))
  }
  // migrations are idempotent
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(dir, f), 'utf8'))
  }
}, 60_000)

describe('migrations', () => {
  it('create monthly partitions', async () => {
    const r = await pg.query<{ relname: string }>(
      `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
       join pg_class p on p.oid = i.inhparent where p.relname = 'clicks' order by 1`,
    )
    const names = r.rows.map((x) => x.relname)
    expect(names).toContain('clicks_default')
    const month = new Date().toISOString().slice(0, 7).replace('-', '_')
    expect(names).toContain(`clicks_${month}`)
  })

  it('insert is idempotent on (id, ts)', async () => {
    const e = ev()
    await pg.query(INSERT_CLICK_SQL, clickParams(e))
    await pg.query(INSERT_CLICK_SQL, clickParams(e))
    const { sql, params } = buildBulkInsert([e, ev(), ev()])
    const r = await pg.query(sql, params)
    expect(r.affectedRows).toBe(2)
    const n = await pg.query<{ n: number }>(`select count(*)::int as n from shortener.clicks where id = $1`, [e.id])
    expect(n.rows[0]!.n).toBe(1)
  })

  it('rollup counts bots apart and leaves them out of uniques', async () => {
    const day = '2026-01-15'
    await pg.exec(`select shortener.ensure_partitions(0)`) // current month only; Jan 2026 rows go to default
    const ts = (h: number) => `${day}T${String(h).padStart(2, '0')}:00:00.000Z`
    const rows = [
      ev({ code: 'R1', ts: ts(1), visitor_hash: 'v1' }),
      ev({ code: 'R1', ts: ts(2), visitor_hash: 'v1' }),
      ev({ code: 'R1', ts: ts(3), visitor_hash: 'v2', country: 'DE', city: 'Berlin', device: 'desktop' }),
      ev({ code: 'R1', ts: ts(4), visitor_hash: 'v3', is_bot: true, bot_name: 'Slack' }),
      ev({ code: 'R1', ts: ts(5), outcome: 'not_found', visitor_hash: 'v9' }),
      ev({ code: 'R1', ts: '2026-01-16T00:00:00.000Z' }), // next day
    ]
    const { sql, params } = buildBulkInsert(rows)
    await pg.query(sql, params)
    await pg.query(`select shortener.rollup_day($1::date)`, [day])
    await pg.query(`select shortener.rollup_day($1::date)`, [day]) // re-run is safe
    const r = await pg.query<{ outcome: string; clicks: number; uniques: number; bots: number; by_country: Record<string, number> }>(
      `select outcome, clicks, uniques, bots, by_country from shortener.clicks_daily
       where day = $1 and code = 'R1' order by outcome`,
      [day],
    )
    expect(r.rows).toEqual([
      { outcome: 'not_found', clicks: 1, uniques: 1, bots: 0, by_country: { RO: 1 } },
      { outcome: 'redirect', clicks: 4, uniques: 2, bots: 1, by_country: { RO: 2, DE: 1 } },
    ])
  })

  it('drop_partitions_older_than keeps recent months', async () => {
    const r = await pg.query<{ n: number }>(`select shortener.drop_partitions_older_than(13) as n`)
    expect(r.rows[0]!.n).toBe(0)
  })
})

describe('roles', () => {
  async function as<T>(role: string, fn: () => Promise<T>): Promise<T> {
    await pg.exec(`set role ${role}`)
    try {
      return await fn()
    } finally {
      await pg.exec('reset role')
    }
  }

  it('edge can insert clicks and read links, but not read clicks or write links', async () => {
    await as('shortener_edge', async () => {
      await pg.query(INSERT_CLICK_SQL, clickParams(ev()))
      await pg.query(`select * from shortener.links limit 1`)
      await expect(pg.query(`select * from shortener.clicks limit 1`)).rejects.toThrow(/permission denied/)
      await expect(pg.query(`select ip_hash from shortener.clicks limit 1`)).rejects.toThrow(/permission denied/)
      await expect(pg.query(`select * from shortener.api_keys limit 1`)).resolves.toBeTruthy()
      await expect(
        pg.query(`insert into shortener.links (namespace, code, target_url) values ('a', 'AB', 'https://x')`),
      ).rejects.toThrow(/permission denied/)
    })
  })

  it('admin can manage links and read clicks, but not write clicks', async () => {
    await as('shortener_admin', async () => {
      await pg.query(`insert into shortener.links (namespace, code, target_url) values ('short.example', 'ADM1', 'https://x.example')`)
      const r = await pg.query(`select count(*) from shortener.clicks`)
      expect(r.rows).toHaveLength(1)
      await pg.query(`select shortener.rollup_day(current_date)`)
      await expect(pg.query(INSERT_CLICK_SQL, clickParams(ev()))).rejects.toThrow(/permission denied/)
    })
  })

  it('links table enforces code and url checks', async () => {
    await expect(
      pg.query(`insert into shortener.links (namespace, code, target_url) values ('s', 'lower', 'https://x')`),
    ).rejects.toThrow(/check/)
    await expect(
      pg.query(`insert into shortener.links (namespace, code, target_url) values ('s', 'AB', 'javascript:alert(1)')`),
    ).rejects.toThrow(/check/)
  })
})
