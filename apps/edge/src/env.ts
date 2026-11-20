export type Env = {
  LINKS: KVNamespace
  /** Optional: without it the outage buffer uses KV (see lib/fallback.ts). */
  FALLBACK?: R2Bucket
  /** Hyperdrive "shortener-edge": shortener_edge role (insert clicks, read links). */
  DB: Hyperdrive
  /** Hyperdrive "shortener-admin": shortener_admin role (API + crons). Falls back to DB. */
  DB_ADMIN?: Hyperdrive
  CLICKS_AE?: AnalyticsEngineDataset
  CLICKS?: Queue
  ASSETS?: Fetcher
  RATE_LIMIT?: RateLimit

  SECRET_SALT: string
  MODE: 'free' | 'paid'
  STRICT_LOGGING: string
  RETENTION_MONTHS?: string
  CF_ACCOUNT_ID?: string
  CF_ANALYTICS_TOKEN?: string
  AE_DATASET?: string
  ALERT_WEBHOOK_URL?: string
  /** Admin UI login (OIDC). Supabase Auth: issuer = https://<ref>.supabase.co/auth/v1 */
  OIDC_ISSUER?: string
  OIDC_AUDIENCE?: string
  ADMIN_JWKS_URL?: string
  /** Public values handed to the admin UI so it can run the email-OTP login. */
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
}

export type RateLimit = {
  limit(opts: { key: string }): Promise<{ success: boolean }>
}
