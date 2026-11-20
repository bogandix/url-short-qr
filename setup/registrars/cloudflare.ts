import type { Registrar } from './types.js'

/** Cloudflare Registrar: nameservers and DS are managed by Cloudflare already. */
export class CloudflareRegistrar implements Registrar {
  id = 'cloudflare' as const
  async auth() {}
  async getNameservers(): Promise<string[]> {
    return []
  }
  async setNameservers() {}
  async getDnssec() {
    return false
  }
  async addDs() {}
}
