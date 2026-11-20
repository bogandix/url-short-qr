import { CLICK_COLUMNS, type ClickEvent } from './events.js'

const COLS = CLICK_COLUMNS.length
const COL_LIST = CLICK_COLUMNS.join(', ')

/** $n placeholders for one row; ts is cast explicitly. */
function rowPlaceholders(offset: number): string {
  return CLICK_COLUMNS.map((c, j) => `$${offset + j + 1}${c === 'ts' ? '::timestamptz' : ''}`).join(', ')
}

export const INSERT_CLICK_SQL = `INSERT INTO shortener.clicks (${COL_LIST}) VALUES (${rowPlaceholders(0)}) ON CONFLICT (id, ts) DO NOTHING`

/** Parameters in CLICK_COLUMNS order; missing (older) fields become null. */
export function clickParams(ev: ClickEvent): unknown[] {
  return CLICK_COLUMNS.map((c) => {
    const v = (ev as Record<string, unknown>)[c]
    return v === undefined ? null : v
  })
}

export function buildBulkInsert(events: ClickEvent[]): { sql: string; params: unknown[] } {
  if (events.length === 0) return { sql: '', params: [] }
  const values: string[] = []
  const params: unknown[] = []
  events.forEach((ev, i) => {
    values.push(`(${rowPlaceholders(i * COLS)})`)
    params.push(...clickParams(ev))
  })
  return { sql: `INSERT INTO shortener.clicks (${COL_LIST}) VALUES ${values.join(',\n')} ON CONFLICT (id, ts) DO NOTHING`, params }
}

export { COLS as CLICK_COLUMN_COUNT }
