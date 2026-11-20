import { UAParser } from 'ua-parser-js'

export type ParsedUa = {
  device: string | null
  device_vendor: string | null
  device_model: string | null
  os: string | null
  browser: string | null
  browser_version: string | null
  browser_major: string | null
  engine: string | null
  cpu_arch: string | null
}

const EMPTY: ParsedUa = {
  device: null,
  device_vendor: null,
  device_model: null,
  os: null,
  browser: null,
  browser_version: null,
  browser_major: null,
  engine: null,
  cpu_arch: null,
}

/** User-Agent → device/OS/browser. Client hints (when sent) fill gaps the UA string hides. */
export function parseUa(ua: string | null, hints: { platform?: string | null; mobile?: boolean | null; model?: string | null } = {}): ParsedUa {
  if (!ua) return EMPTY
  const p = new UAParser(ua)
  const device = p.getDevice()
  const os = p.getOS()
  const browser = p.getBrowser()
  const engine = p.getEngine()
  const cpu = p.getCPU()
  const type = device.type || (hints.mobile ? 'mobile' : null) || 'desktop'
  const osName = os.name ?? hints.platform ?? null
  return {
    device: type,
    device_vendor: device.vendor ?? null,
    device_model: device.model ?? hints.model ?? null,
    os: osName ? `${osName}${os.version ? ' ' + os.version : ''}` : null,
    browser: browser.name ?? null,
    browser_version: browser.version ?? null,
    browser_major: browser.major ?? null,
    engine: engine.name ?? null,
    cpu_arch: cpu.architecture ?? null,
  }
}
