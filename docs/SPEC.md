# Task — Self-hosted URL shortener (multi-domain, QR-first)

**Status:** built and tested locally (unit + PGlite integration tests); not yet run against a live Cloudflare account. Where the code adds to or differs from this text, see §18.
**What it is:** a general, self-contained short-link service that anyone can deploy from the repo to their own Cloudflare account and Postgres database, on any number of domains.
**Stack:**
- **Cloudflare:** Workers, KV, R2, Analytics Engine, Hyperdrive, Cron Triggers, and optional Queues.
- **Postgres:** Supabase by default; any Postgres reachable by Hyperdrive works.
- **Registrar:** any. Its nameservers point to Cloudflare.

**Hard requirement:** every request that reaches a configured host is written to Postgres exactly once.

Placeholders used below: `short.example` (a short domain), `A7K2` (a code), `tenant:42` (an owner key).

---

## 1. What it does

- `HTTPS://SHORT.EXAMPLE/A7K2` → 302 to the stored target, from the nearest Cloudflare location.
- **One deployment serves many hosts:**
  - apex domains: `short.example`, `go.other.example`
  - `www.` variants
  - wildcard subdomains: `*.short.example`, so `acme.short.example/A7K2`
- Every request is one row in `shortener.clicks`: hits, unknown codes, paused links, bots, previews, rate-limited requests.
- **Management:** an API, a small admin UI, and a CLI create links, pause them, show stats, and render QR codes.
- **Setup:** a wizard takes a Cloudflare account, a Postgres provider, and a domain at any registrar, and ends with a working, tested service. It adds more domains later with the same command.
- **Two modes:**
  - **Free mode:** runs on free tiers up to ~100k requests/day.
  - **Paid mode** (Workers Paid, $5/month): adds a queue.

  Same database, same event format.

### Not in scope (schema leaves room)
A/B or weighted targets, geo or device routing, password-protected links, link-in-bio pages, per-tenant billing.

---

## 2. Architecture

```
                 ┌──────────────── Cloudflare (one zone per domain) ──────────────┐
 request ───────▶│ Worker "shortener-edge"                                         │
 any configured  │   routes: <apex>/*, www.<apex>/*, *.<apex>/* (per domain config) │
 host            │   router (by host + path):                                      │
                 │    /{CODE}      → lookup(host, code) → log → 302                 │
                 │    /{CODE}+     → preview page, logged                           │
                 │    /            → host home_url (302), logged                    │
                 │    /_/qr/*      → QR SVG/PNG (edge-cached, not logged)           │
                 │    /_/api/*     → admin API          (admin host only)           │
                 │    /_/admin/*   → admin UI assets    (admin host only)           │
                 │   bindings: KV LINKS · R2 FALLBACK · AE CLICKS_AE ·              │
                 │             HYPERDRIVE DB · (paid) QUEUE CLICKS · RATE_LIMIT     │
                 │   cron: */5 replay · 00:15 rollup+reconcile+partitions · 6 h sync│
                 └───────────────┬──────────────────────────────┬──────────────────┘
                                 │ Hyperdrive (pooled)          │ (paid) Queue → "shortener-consumer"
                                 ▼                              ▼    batch INSERT
                       Postgres, schema `shortener`
 Registrar(s) — nameservers point to Cloudflare. DNS, TLS and routing live in Cloudflare.
```

| Piece | Role | Why not something else |
|---|---|---|
| Worker | Code runs on every request, so every request can be logged | Redirect Rules and Page Rules answer before code runs and log nothing |
| KV | `host/code → target` at the edge | A database read per redirect adds 20–80 ms and spends the query budget |
| Hyperdrive | Pooled Postgres from Workers | Direct database hosts are often IPv6-only or connection-limited (Supabase: use the **pooler** string) |
| R2 | Fallback store when Postgres is down (free mode) | KV free writes are 1,000/day; R2 free is ~1M writes/month |
| Analytics Engine | Independent counter to prove nothing was lost | Zone analytics are sampled |
| Queues (paid) | Durable buffer, faster response, batch inserts | Free Queues: ~3,300 messages/day, 24 h retention |

**Each domain must be a full Cloudflare zone.** Partial (CNAME) setup is Business plan only. Wildcard subdomains use a Worker **route** (`*.short.example/*`) plus a proxied wildcard DNS record (`*  AAAA  100::`), because Worker custom domains do not accept wildcards.

---

## 3. Domains and hosts (the wildcard model)

```sql
shortener.domains (
  id uuid pk, apex text unique,              -- 'short.example'
  zone_id text, registrar text,              -- 'godaddy' | 'namecheap' | 'porkbun' | 'cloudflare' | 'route53' | 'manual'
  serve_www boolean default true,
  wildcard boolean default false,            -- serve *.apex
  wildcard_mode text default 'namespace',    -- 'namespace' (each subdomain has its own codes) | 'alias' (subdomains share the apex codes)
  home_url text, not_found_url text,
  code_length int default 4,
  is_admin_host boolean default false,       -- /_/api and /_/admin answer only here
  status text default 'active'               -- active | pending_ns | disabled
)
```

Resolving a request:
1. Lowercase the host and strip `www.` when `serve_www` is set.
2. Exact `apex` match → namespace `apex`.
3. Otherwise, if a parent apex has `wildcard`: in `namespace` mode the namespace is the full host (`acme.short.example`); in `alias` mode it is the apex.
4. Unknown host → 404 with outcome `invalid`, still logged, using the zone's apex as the namespace.

Links belong to a **namespace** (a host string). The same code may exist in different namespaces.

---

## 4. Caching rules (logging stays at 100%)

| Response | Headers | Cached |
|---|---|---|
| Redirect 302 | `Cache-Control: private, no-store, max-age=0`, `X-Robots-Tag: noindex` | **Nowhere.** Never 301: browsers keep it forever, so later requests skip the Worker and the target can never change. |
| 404 / 410 / 429 / preview pages | same | Nowhere |
| `/_/qr/{CODE}.svg\|png` | `public, max-age=31536000, immutable` | Browser and Cloudflare (an image is not an access) |
| Admin UI assets | hashed filenames, immutable | Cloudflare |
| KV reads | `cacheTtl: 60` | Edge memory: a change reaches every location within ~60 s |
| Unknown codes | in-isolate `Map`, 60 s | Memory only |

**Zone settings** the wizard sets on every domain, and `doctor` re-checks:
- **Turned off:** Always Use HTTPS (the Worker handles `http://`, logs it, then redirects to https), and Always Online.
- **Must not exist on the zone:** Page Rules, Redirect Rules, Cache Rules.
- **Turned on:** HSTS, which is allowed because the browser upgrades `http://` locally after the first visit.
- **Worker routes:** fail closed.

---

## 5. Logging guarantee

### Event
Built for every request except `/_/qr`, admin assets, and `/_/api`, which writes `shortener.audit` instead.

```ts
type ClickEvent = {
  id: string; ts: string                      // randomUUID + ISO time set at the edge; together the PK
  host: string; namespace: string; code: string
  link_id: string | null
  outcome: 'redirect' | 'not_found' | 'paused' | 'expired' | 'preview' | 'rate_limited' | 'home' | 'invalid'
  method: string; path: string; query: string | null; scheme: 'http' | 'https'
  country, region, region_code, city, timezone, colo: string | null      // request.cf
  asn: number | null; as_org: string | null
  ua, device, os, browser, browser_version, lang, referer: string | null
  ip_hash: string; visitor_hash: string
  is_bot: boolean; bot_name: string | null
  ray_id: string; source: 'live' | 'replay'
}
```

- **`ip_hash`:** `hex(HMAC-SHA256(daySalt, ip)).slice(0,32)`, with `daySalt = HMAC-SHA256(SECRET_SALT, 'YYYY-MM-DD')`. The raw IP is never stored.
- **`visitor_hash`:** the same with `ip|ua|lang`. It gives unique visitors per day without cookies.
- **Bots:** `HEAD` requests, or a UA matching `/(bot|crawl|spider|preview|facebookexternalhit|WhatsApp|Slack|TelegramBot|Discord|Twitterbot|LinkedInBot|SkypeUriPreview|curl|wget|python-requests|HeadlessChrome)/i`. They are redirected and logged, then left out of unique and human counts.
- **UA parsing:** `ua-parser-js` in the Worker.

### Free mode (`mode: "free"`)
```ts
const ev = buildEvent(req, ctx)
let stored = false
try { await insertClick(env.DB, ev); stored = true }      // INSERT … ON CONFLICT (id, ts) DO NOTHING
catch { try { await env.FALLBACK.put(`pending/${ev.ts.slice(0,10)}/${ev.id}.json`, JSON.stringify(ev)); stored = true } catch {} }
env.CLICKS_AE.writeDataPoint({ indexes: [ev.namespace], blobs: [ev.namespace, ev.code, ev.outcome, ev.id], doubles: [1] })
if (!stored) { console.error('click-lost', ev); if (env.STRICT_LOGGING === 'true') return unavailable() }
return respond(ev.outcome, link)
```
Cron `*/5`: read up to 1,000 objects under `pending/`, batch insert them with `source = 'replay'`, then delete those objects.

### Paid mode (`mode: "paid"`)
`await env.CLICKS.send(ev)`, durable once it resolves, with the same R2 fallback if it throws. The consumer runs with `max_batch_size: 100`, `max_batch_timeout: 10`, one multi-row `INSERT … ON CONFLICT DO NOTHING`, `retry_delay: 30`, the dead-letter queue `clicks-dlq`, and 14-day retention.

### Exactly once, and proof
- **Exactly once:** primary key `(id, ts)` plus `ON CONFLICT DO NOTHING`, so retries and replays never duplicate.
- **Proof:** a daily cron at 00:15 UTC counts yesterday per `namespace, code, outcome` in Postgres and in Analytics Engine (SQL API, `CF_ANALYTICS_TOKEN`). It writes the result to `shortener.reconcile_runs` and alerts `ALERT_WEBHOOK_URL` when any difference is not 0.

### Never loggable
Requests that never reach Cloudflare, and requests Cloudflare drops before Workers (DDoS mitigation). Rate limiting therefore runs **inside** the Worker, with the Workers Rate Limiting binding, or an in-isolate token bucket where that binding is not available. It answers 429 and logs the request as `rate_limited`.

---

## 6. Codes

- **Alphabet:** `0123456789ABCDEFGHJKMNPQRSTUVWXYZ`, 33 characters, without `I L O`. This uses QR alphanumeric mode, the smallest symbols.
- **Reading:** uppercase the code, map `O→0`, `I→1`, `L→1`, and strip a trailing `/`.
- **Generated codes:** random with collision retry, with length from `domains.code_length` (4 gives 1.18M codes). The generator moves to the next length when 50% of the namespace's space at that length is used.
- **Vanity codes:** `^[0-9A-Z-]{2,32}$`, unique per namespace.
- **Reserved:** everything under `/_/`, plus `ROBOTS.TXT`, `FAVICON.ICO`, `SITEMAP.XML`, `.WELL-KNOWN`.
- **QR payload:** always uppercase, `HTTPS://SHORT.EXAMPLE/A7K2`. Lowercase forces byte mode and a larger symbol.

---

## 7. Database

Its own Postgres database, or a dedicated Supabase project, is recommended. The schema `shortener` is never exposed through a REST layer; on Supabase, remove it from "exposed schemas".

```sql
-- migrations/0001_init.sql
create schema if not exists shortener;

create table shortener.domains ( /* see §3 */ );

create table shortener.links (
  id uuid primary key default gen_random_uuid(),
  namespace text not null,                          -- host string, see §3
  code text not null check (code ~ '^[0-9A-Z-]{2,32}$'),
  target_url text not null check (target_url ~ '^https?://'),
  title text, tags text[] not null default '{}',
  owner text,                                       -- free-form tenant key, e.g. 'tenant:42'
  utm jsonb not null default '{}', append_utm boolean not null default false,
  status text not null default 'active' check (status in ('active','paused','archived')),
  expires_at timestamptz, fallback_url text,
  version int not null default 1,
  created_by text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (namespace, code)
);
create index on shortener.links (owner);
create index on shortener.links (updated_at);

create table shortener.clicks (
  id uuid not null, ts timestamptz not null,
  host text not null, namespace text not null, code text not null,
  link_id uuid, outcome text not null,
  method text, path text, query text, scheme text,
  country char(2), region text, region_code text, city text, timezone text, colo text,
  asn int, as_org text,
  ua text, device text, os text, browser text, browser_version text, lang text, referer text,
  ip_hash text not null, visitor_hash text not null,
  is_bot boolean not null default false, bot_name text,
  ray_id text, source text not null default 'live',
  inserted_at timestamptz not null default now(),
  primary key (id, ts)
) partition by range (ts);
create index on shortener.clicks (link_id, ts);
create index on shortener.clicks (namespace, code, ts);

create table shortener.clicks_daily (
  day date not null, namespace text not null, code text not null, outcome text not null,
  link_id uuid, clicks int not null, uniques int not null, bots int not null,
  by_country jsonb not null default '{}', by_city jsonb not null default '{}',
  by_device jsonb not null default '{}', by_os jsonb not null default '{}',
  primary key (day, namespace, code, outcome)
);

create table shortener.api_keys (
  id uuid primary key default gen_random_uuid(), name text not null,
  key_hash text not null unique,                    -- sha256 of 'sk_live_…'; shown once
  scopes text[] not null,                           -- links:read links:write stats:read domains:admin keys:admin
  owner_prefix text, namespaces text[],             -- optional restrictions
  created_at timestamptz not null default now(), last_used_at timestamptz, revoked_at timestamptz
);
create table shortener.admins (email text primary key, created_at timestamptz default now());
create table shortener.audit (id bigint generated always as identity primary key, ts timestamptz not null default now(),
  actor text not null, action text not null, namespace text, code text, before jsonb, after jsonb);
create table shortener.reconcile_runs (day date primary key, db_count bigint, edge_count bigint, diff bigint,
  status text, checked_at timestamptz default now());

create function shortener.ensure_partitions(months_ahead int default 2) returns void ...;
create function shortener.drop_partitions_older_than(months int default 13) returns int ...;
create function shortener.rollup_day(d date) returns void ...;

-- 0003_roles.sql creates both roles NOLOGIN; the wizard then runs ALTER ROLE … LOGIN PASSWORD with generated passwords.
create role shortener_edge  nologin;   -- INSERT clicks (+ SELECT (id, ts) for ON CONFLICT); SELECT links, domains, api_keys; EXECUTE functions
create role shortener_admin nologin;   -- CRUD links, domains, api_keys, admins, meta; INSERT/SELECT audit; SELECT clicks*; reconcile_runs
-- RLS enabled on every table; no grants to anon/public roles.
```

**Sizing:** about 350–500 bytes per click row with indexes, so about 2M clicks per GB. Raw clicks are kept for `retentionMonths` (default 13), and the daily rollups are kept forever. `doctor` warns at 70% of the provider's storage quota.

---

## 8. KV

- **Key:** `${namespace}/${code}`.
- **Value** (≤ 1 KB):
  ```json
  { "id": "uuid", "t": "https://target", "s": "active", "x": null, "f": null, "u": {}, "v": 3 }
  ```
- **Domain config:** cached under `__domain/${apex}`.
- **Writes:** the database first, then `KV.put`.
- **Resync cron (every 6 h):** pushes every link with `updated_at > last_sync`. It repairs missed writes.
- **UTM merge:** only when `append_utm` is set; keys already in the target's query win.

---

## 9. Admin API (`/_/api`, admin host only)

**Auth:**
- `Bearer sk_live_…`: hash lookup through Hyperdrive, cached in-isolate for 60 s.
- An OIDC/JWT from the admin UI: Supabase Auth by default, verified against JWKS, with the email in `shortener.admins`.

| Method & path | Scope | Notes |
|---|---|---|
| `POST /_/api/links` | links:write | `{ namespace, target_url, code?, title?, tags?, owner?, utm?, append_utm?, expires_at?, fallback_url? }` → `201 { short_url, code, qr: { svg, png } }` |
| `POST /_/api/links/bulk` | links:write | ≤ 500 items, all or nothing |
| `GET /_/api/links?namespace=&owner=&q=&status=&tag=&cursor=` | links:read | Keyset pagination |
| `GET` · `PATCH` · `DELETE /_/api/links/:namespace/:code` | links:* | `PATCH` bumps `version`, writes KV and audit; `DELETE` archives (codes are never reused) |
| `GET /_/api/links/:namespace/:code/stats?from=&to=&interval=day\|hour` | stats:read | Daily rollups plus today's raw rows |
| `GET /_/api/links/:namespace/:code/clicks?cursor=` | stats:read | Raw rows, without hashes |
| `GET /_/api/stats/summary?namespace=&owner=&from=&to=` | stats:read | |
| `GET` · `POST` · `PATCH /_/api/domains` | domains:admin | Registers a domain; zone and DNS work is done by the CLI (§11) |
| `POST /_/api/keys` · `DELETE /_/api/keys/:id` | keys:admin | Returns the key once |
| `GET /_/health` | none | KV, database, R2 pending count, last reconcile |

**QR (any host):** `GET /_/qr/{CODE}.svg|png?size=512&ecc=M&margin=4`, using the request host as the namespace. Generated with `uqr`, uppercase payload, edge-cached.

---

## 10. Admin UI (`/_/admin`, admin host only)

Vite + Preact, served as Workers Static Assets with `run_worker_first`.

**Login:** email OTP through the configured OIDC provider.

**Screens:**
- **Links:** filter by domain, namespace, tag, owner and status.
- **New link:** QR preview, plus SVG/PNG download.
- **Link detail:** per-day chart, uniques, countries, cities, devices, bots apart, pause / resume / archive, and audit history.
- **Domains:** status, wildcard mode, home URL.
- **Health:** reconcile per day, R2 pending, storage.

---

## 11. Setup wizard and CLI

**Commands:**
- `npm run setup`: first install.
- `npm run domain:add`: each extra domain.
- Also: `doctor`, `smoke`, `replay`, `teardown`.

**How it runs:**
- **Tooling:** Node ≥ 22.12 (required by current wrangler), `@clack/prompts`, the official `cloudflare` TS SDK, and `wrangler`.
- **Idempotent:** every step looks up the resource by name (`shortener-*`) first, and stores IDs in `.shortener/state.json` (gitignored). Re-runs resume.
- **Secrets:** held in memory only, then pushed to `wrangler secret put` or the Hyperdrive config.

### Provider adapters (pluggable)

```ts
interface Registrar {           // setup/registrars/*.ts
  id: 'godaddy' | 'namecheap' | 'porkbun' | 'cloudflare' | 'route53' | 'manual'
  auth(): Promise<void>                                   // prompts for that provider's credentials
  getNameservers(domain: string): Promise<string[]>
  setNameservers(domain: string, ns: string[]): Promise<void>
  getDnssec?(domain: string): Promise<boolean>; disableDnssec?(domain: string): Promise<void>
  addDs?(domain: string, ds: DsRecord): Promise<void>
}
interface Database {            // setup/databases/*.ts
  id: 'supabase' | 'neon' | 'postgres-url'
  auth(): Promise<void>
  provision(opts: { region: string }): Promise<{ poolerUrl: string; adminUrl: string }>
  runSql(sql: string): Promise<void>
  jwks?(): Promise<string>       // admin UI login (Supabase Auth); otherwise configure any OIDC issuer
}
```

**Registrar notes:**
- **GoDaddy:** API key and secret; it limits its production API to larger accounts, so on 401/403 the wizard falls back to `manual`.
- **Namecheap:** needs a whitelisted IP.
- **Porkbun:** API key.
- **Cloudflare Registrar:** no-op.
- **Manual:** prints the nameservers and waits.

### Steps (`setup`)

| # | Step | Detail |
|---|---|---|
| 0 | Preflight | Node, git, wrangler; asks mode (`free`/`paid`), first domain, registrar, database provider and region, code length, retention, `STRICT_LOGGING` |
| 1 | Cloudflare auth | Opens a **pre-filled API-token page**, the user pastes the token, the wizard verifies it (`GET /user/tokens/verify`) and asks for the account. `wrangler login` (OAuth) is accepted for deploy-only steps |
| 2 | Database | `Database.auth` + `provision`. Runs migrations; creates `shortener_edge` and `shortener_admin` with generated passwords; hides the schema from REST; reads JWKS when there is one |
| 3 | Cloudflare resources | KV `shortener-links`, R2 `shortener-fallback`, Hyperdrive `shortener-edge` and `shortener-admin` (pooler URL, caching **off**), Analytics Engine `shortener_clicks`; paid mode adds the queues `shortener-clicks` and `shortener-clicks-dlq` |
| 4 | Secrets and config | `SECRET_SALT` (random 32 bytes), `CF_ANALYTICS_TOKEN`, `ALERT_WEBHOOK_URL`, `MODE`, `STRICT_LOGGING`; `wrangler.jsonc` bindings generated from state |
| 5 | Deploy | `wrangler deploy` (edge, plus consumer in paid mode), cron triggers |
| 6 | First domain | Runs `domain:add` (below) with `is_admin_host = true` |
| 7 | First admin | Admin email into `shortener.admins`; first API key, printed once |
| 8 | Smoke | `smoke` against the first domain |
| 9 | Summary | URLs, free-tier limits in force, DS record to add, GitHub secrets to set |

### `domain:add <apex>`

1. Create the zone (`POST /zones`, type `full`), or reuse it; read its nameservers.
2. Through the registrar adapter, turn DNSSEC off if it is on, then set the nameservers.
3. Poll the zone until it is `active` (resumable; can take hours).
4. Apply the zone settings from §4. Turn on Cloudflare DNSSEC; add the DS record through the adapter or print it.
5. Attach the Worker as a custom domain on the apex (and `www` when set). When `wildcard` is set, add the proxied record `*  AAAA  100::` and the route `*.apex/*`.
6. Insert into `shortener.domains`, and write `__domain/<apex>` to KV.
7. Run smoke for that host.

**Cloudflare token permissions:**
- Account: Workers Scripts, KV, R2, Queues and Hyperdrive Edit; Account Analytics Read; Account Settings Read.
- Zone (all zones, or the listed ones): Zone, DNS, Zone Settings, Workers Routes and SSL Edit; Page Rules, Single Redirect and Cache Settings Read (for `doctor`).
- Analytics: a separate token with Account Analytics Read only, stored as `CF_ANALYTICS_TOKEN`; the Worker never holds the setup token.

### Other commands

- **`doctor`:** checks zone settings for every domain, the bindings, cron triggers, roles, exposed schemas, storage, the last reconcile and R2 pending. Exits non-zero on drift.
- **`smoke [host]`:**
  1. Create `SMOKE1-xxxx` (random suffix, because archived codes are never reused; stored as `SM0KE1-xxxx`), request it, and expect 302 with `no-store`.
  2. Wait for the row in the database (≤ 30 s) and check the Analytics Engine counter.
  3. Request `/NOPE99-xxxx` and expect a 404 with its row (stored under the normalized code `N0PE99-xxxx`).
  4. Delete the link.
- **`replay`:** forces the R2 replay.
- **`teardown`:** removes everything the wizard created, after typing the account name. Pass `--with-database` to drop the database too.

**Deploy to Cloudflare button:** optional, in the README. It covers steps 3 and 5 only.

---

## 12. Repo layout

```
shortener/
├─ apps/edge/              # Worker: src/router.ts, src/api/* (links, domains, keys, stats, ops), src/lib/* (auth, jwt, db, domains, lookup, event, log, qr, ratelimit, respond, health, cron)
├─ apps/consumer/          # paid mode queue consumer
├─ apps/admin/             # Vite + Preact → apps/edge/public/_/admin
├─ packages/shared/        # ClickEvent + zod, alphabet, codes, host resolution, hashes, UTM, bots, SQL builders
├─ migrations/             # 0001_init.sql, 0002_functions.sql, 0003_roles.sql
├─ setup/                  # cli.ts, setup.ts, domain.ts, lib/ (state, cf, zone, wrangler, migrate, …), registrars/, databases/
├─ scripts/                # doctor, smoke, replay, teardown, migrate, gen-config, load/k6.js
├─ test/                   # PGlite integration tests (migrations, roles, API + router + crons)
├─ docs/SPEC.md            # this file
├─ .github/workflows/deploy.yml   # typecheck, tests, migrations, wrangler deploy, smoke
├─ shortener.config.example.json  # mode, retentionMonths, strictLogging, database, domains[]
└─ README.md
```

**Libraries:** `hono`, `postgres` (postgres.js, with `nodejs_compat`), `ua-parser-js`, `uqr`, `zod`.

---

## 13. Tests

- **Unit** (`vitest` with in-memory KV/R2/AE fakes):
  - Host resolution: apex, `www`, wildcard namespace vs alias, unknown host.
  - Code reading and UTM merge.
  - Bot detection.
  - Hashes stable within a day and different across days.
  - Status and headers per outcome: no 301 anywhere, `no-store` on every logged response.
- **Logging:**
  - Database down → event lands in R2 → replay inserts it once.
  - A duplicate event gives one row.
  - `STRICT_LOGGING=true` with both stores down → 503.
- **Integration:** PGlite (real Postgres in WASM, no Docker) over a socket; migrations, roles/RLS, partitions, rollups (bots left out of uniques), and the whole API + router + crons through postgres.js.
- **Smoke:** in CI after every deploy, on every domain.
- **Load:** k6, 200 rps for 2 minutes across two domains and one wildcard host; reconcile diff 0 afterwards.

---

## 14. Privacy

- **No raw IPs, no cookies on public responses:** the redirect needs no consent banner.
- **Retention:** raw clicks for `retentionMonths`, rollups kept.
- **The deployer's privacy notice must state:** that requests are logged, which fields (location at city level, device, language), the retention, and the purpose: counting and abuse prevention.
- **Hashes:** they cannot be reversed without that day's salt, which is derived and never stored, so per-person access requests cannot be served. This is by design.

---

## 15. Costs (per deployment)

| | Free mode | Paid mode |
|---|---|---|
| Cloudflare | $0 up to ~100k requests/day across all domains. Above that: Error 1027, meaning no redirect **and** no log | $5/month: 10M requests, then ~$0.30/M; queue ~330k clicks/month included, then ~$1.20 per extra million |
| Postgres | Supabase free: 500 MB ≈ 1M stored clicks | Provider's paid tier as storage grows |
| Domains | Registrar price per domain | same |

**Switch to paid mode** when daily requests pass about 50k, when a spike could hit the cap, or when a long database outage should not depend on the R2 replay.

---

## 16. Acceptance criteria

1. **Fresh install:** `setup` on a fresh Cloudflare account, a database provider, and a domain at any supported registrar ends with smoke passing. Manual waits are only nameserver propagation and, where the adapter cannot do it, the DS record.
2. **Extra domains:** `domain:add` adds a second apex and a wildcard; requests to `a.<apex>/X` and `b.<apex>/X` resolve to different links in namespace mode.
3. **Redirect speed:** a redirect answers 302 at ≤ 50 ms p50 (paid mode) or ≤ 120 ms p50 (free mode) from the region of the database, with `Cache-Control: private, no-store, max-age=0`.
4. **100% logged:** after 100k mixed requests (hits, misses, bots, `http://`, lowercase, `O/0` typos, unknown hosts), database rows equal requests sent and reconcile shows diff 0.
5. **Database outage:** with Postgres blocked for 30 minutes, no redirect fails, and every event is in the database exactly once within 10 minutes of recovery.
6. **Pausing:** a paused link stops redirecting everywhere within 90 s.
7. **Drift check:** `doctor` passes on a fresh install and fails when someone turns Always Use HTTPS on or adds a Redirect Rule.
8. **No leaked secrets:** none in the repo, the state file, CI logs or wizard output, except the first API key, shown once.
9. **Caching:** `/_/qr` responses are edge-cached; no logged response is.

---

## 17. Open points (decided)

- **`STRICT_LOGGING` default:** `false`. When both Postgres and R2 fail, the redirect still happens; the loss goes to Workers Logs and shows in reconcile.
- **Default wildcard mode:** `namespace`.
- **Admin UI login:** Supabase email OTP in the UI; the Worker verifies any OIDC JWT against `ADMIN_JWKS_URL` (RS256/ES256, issuer, audience). The UI also accepts an API key.
- **Registrar adapters in v1:** GoDaddy, Porkbun, Cloudflare, Manual. Namecheap and Route 53 use the manual steps.
- **Multi-tenant UI:** single-operator in v1; API keys enforce `owner_prefix` and `namespaces`.

---

## 18. Implementation notes (where the code adds to or differs from the text above)

- **Vanity codes are normalized on create** with the same rules as reading (`promo-24` → `PR0M0-24`), so every spelling resolves.
- **Rollups:** `clicks` includes bots and `bots` counts them; `uniques` and the `by_*` breakdowns count humans only.
- **Analytics Engine:** each point also stores the event's UTC day (blob5) so reconcile matches Postgres exactly at midnight. At very high volume AE samples, and counts are estimates.
- **postgres.js runs with `fetch_types: false`** (Hyperdrive), so `text[]` values use an explicit codec in `apps/edge/src/lib/db.ts`.
- **Wrangler config:** `apps/edge/wrangler.jsonc` is generated from state, including all routes (custom domains for apex/`www`, zone routes for wildcards), because `wrangler deploy` replaces the script's routes.
- **Wildcard route "fail closed":** `domain:add` sets it via the API when possible and warns otherwise; custom domains have no origin and fail closed by design.
- **Extra admin API:** `GET /_/api/config` (public login settings) and `/_/api/ops/{replay, sync, reconcile/:day, health, clicks}` for the CLI and the Health screen.
- **Admin assets** under `/_/admin/assets/` are served `public, max-age=31536000, immutable`.
