import { p, yes } from '../lib/ui.js'
import type { DsRecord, Registrar } from './types.js'

export class Manual implements Registrar {
  id = 'manual' as const
  async auth() {}
  async getNameservers(): Promise<string[]> {
    return []
  }
  async setNameservers(domain: string, ns: string[]) {
    p.note(
      `At your registrar, open ${domain} and:\n` +
        `  1. Turn DNSSEC off (if on).\n` +
        `  2. Set custom nameservers to:\n${ns.map((n) => `       ${n}`).join('\n')}`,
      'Change nameservers',
    )
    while (!(await yes('Done?', true))) {
      /* wait */
    }
  }
  async addDs(domain: string, ds: DsRecord) {
    p.note(
      `Add this DS record for ${domain} at your registrar:\n` +
        `  Key tag:     ${ds.keyTag}\n  Algorithm:   ${ds.algorithm}\n  Digest type: ${ds.digestType}\n  Digest:      ${ds.digest}\n\n  ${ds.ds}`,
      'DNSSEC DS record',
    )
    await yes('Added (or skip for now)?', true)
  }
}
