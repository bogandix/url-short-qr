import { defaultState } from '../setup/lib/state.js'
import { writeConfigs } from '../setup/lib/wrangler.js'

/** Writes placeholder wrangler configs (no IDs) so the Worker can be built/typechecked before setup. */
const s = defaultState()
s.mode = 'paid'
writeConfigs(s) // consumer config is only written in paid mode
s.mode = 'free'
writeConfigs(s) // edge config defaults to free mode
console.log('wrote apps/edge/wrangler.jsonc and apps/consumer/wrangler.jsonc (placeholders)')
