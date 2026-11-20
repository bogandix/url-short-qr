import { UAParser } from 'ua-parser-js'

export function parseUa(ua: string | null): {
  device: string | null
  os: string | null
  browser: string | null
  browser_version: string | null
} {
  if (!ua) return { device: null, os: null, browser: null, browser_version: null }
  const p = new UAParser(ua)
  const device = p.getDevice()
  const os = p.getOS()
  const browser = p.getBrowser()
  return {
    device: device.type || device.model || 'desktop',
    os: os.name ? `${os.name}${os.version ? ' ' + os.version : ''}` : null,
    browser: browser.name ?? null,
    browser_version: browser.version ?? null,
  }
}
