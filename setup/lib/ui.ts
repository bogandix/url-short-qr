import * as p from '@clack/prompts'

export { p }

export function bail(msg = 'Cancelled.'): never {
  p.cancel(msg)
  process.exit(1)
}

/** Unwrap a clack answer; exit cleanly on Ctrl-C. */
export function must<T>(v: T): Exclude<T, symbol> {
  if (p.isCancel(v)) bail()
  return v as Exclude<T, symbol>
}

/** SHORTENER_NONINTERACTIVE=1 (or no TTY): answer from env/initial values; fail instead of prompting. */
export const NONINTERACTIVE = process.env.SHORTENER_NONINTERACTIVE === '1' || !process.stdin.isTTY

function fromEnv(env?: string): string | undefined {
  return env ? process.env[env] : undefined
}

export async function ask(
  message: string,
  opts: { initial?: string; placeholder?: string; validate?: (v: string) => string | undefined; env?: string; optional?: boolean } = {},
) {
  const v = fromEnv(opts.env) ?? (NONINTERACTIVE ? opts.initial ?? (opts.optional ? '' : undefined) : undefined)
  if (v !== undefined) {
    const bad = opts.validate?.(v)
    if (bad && !(opts.optional && v === '')) throw new Error(`${message}: ${bad}${opts.env ? ` (from $${opts.env})` : ''}`)
    return v.trim()
  }
  if (NONINTERACTIVE) throw new Error(`${message}: no value${opts.env ? ` — set $${opts.env}` : ''}`)
  return must(
    await p.text({
      message,
      initialValue: opts.initial,
      placeholder: opts.placeholder,
      validate: opts.validate ? (v) => opts.validate!(v ?? '') : undefined,
    }),
  ).trim()
}

export async function secret(message: string, env?: string): Promise<string> {
  if (env && process.env[env]) {
    p.log.info(`${message}: using $${env}`)
    return process.env[env]!
  }
  if (NONINTERACTIVE) throw new Error(`${message}: set $${env ?? '(no env var)'}`)
  return must(await p.password({ message, validate: (v) => (v ? undefined : 'Required') })).trim()
}

export async function choose<T extends string>(
  message: string,
  options: { value: T; label: string; hint?: string }[],
  initial?: T,
  env?: string,
): Promise<T> {
  const v = fromEnv(env)
  if (v !== undefined) {
    if (!options.some((o) => o.value === v)) throw new Error(`${message}: $${env}=${v} is not one of ${options.map((o) => o.value).join(', ')}`)
    return v as T
  }
  if (NONINTERACTIVE) {
    if (initial !== undefined) return initial
    if (options.length === 1) return options[0]!.value
    throw new Error(`${message}: no default${env ? ` — set $${env}` : ''}`)
  }
  return must(await p.select({ message, options: options as never, initialValue: initial })) as T
}

export async function yes(message: string, initial = true): Promise<boolean> {
  if (NONINTERACTIVE) return initial
  return must(await p.confirm({ message, initialValue: initial }))
}

export async function task<T>(title: string, fn: () => Promise<T>): Promise<T> {
  const s = p.spinner()
  s.start(title)
  try {
    const r = await fn()
    s.stop(`${title} ✓`)
    return r
  } catch (err) {
    s.error(`${title} ✗`)
    throw err
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function randomSecret(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url')
}

/** Never let a secret reach a log line. */
export function redact(s: string, secrets: (string | undefined)[]): string {
  let out = s
  for (const x of secrets) if (x && x.length >= 6) out = out.split(x).join('***')
  return out
}
