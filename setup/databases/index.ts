import type { DatabaseId, State } from '../lib/state.js'
import { Neon } from './neon.js'
import { PostgresUrl } from './postgres-url.js'
import { Supabase } from './supabase.js'
import type { Database } from './types.js'

export function databaseFor(id: DatabaseId, s?: State): Database {
  switch (id) {
    case 'supabase':
      return new Supabase({ projectRef: s?.database?.projectRef })
    case 'neon':
      return new Neon({ projectId: s?.database?.projectId })
    case 'postgres-url':
      return new PostgresUrl()
  }
}

export const DATABASE_REGIONS: Record<DatabaseId, { value: string; label: string }[]> = {
  supabase: [
    { value: 'eu-central-1', label: 'Frankfurt (eu-central-1)' },
    { value: 'eu-west-1', label: 'Ireland (eu-west-1)' },
    { value: 'us-east-1', label: 'N. Virginia (us-east-1)' },
    { value: 'us-west-1', label: 'N. California (us-west-1)' },
    { value: 'ap-southeast-1', label: 'Singapore (ap-southeast-1)' },
  ],
  neon: [
    { value: 'aws-eu-central-1', label: 'Frankfurt (aws-eu-central-1)' },
    { value: 'aws-us-east-2', label: 'Ohio (aws-us-east-2)' },
    { value: 'aws-us-west-2', label: 'Oregon (aws-us-west-2)' },
    { value: 'aws-ap-southeast-1', label: 'Singapore (aws-ap-southeast-1)' },
  ],
  'postgres-url': [{ value: 'custom', label: 'Wherever your server is' }],
}

export type { Database }
