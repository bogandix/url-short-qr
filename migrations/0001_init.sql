-- Schema for the short-link service. Never expose `shortener` through a REST layer
-- (on Supabase: remove it from "Exposed schemas"). gen_random_uuid() is core in PG 13+.
create schema if not exists shortener;


create table if not exists shortener.domains (
  id uuid primary key default gen_random_uuid(),
  apex text not null unique,
  zone_id text,
  registrar text,
  serve_www boolean not null default true,
  wildcard boolean not null default false,
  wildcard_mode text not null default 'namespace'
    check (wildcard_mode in ('namespace', 'alias')),
  home_url text,
  not_found_url text,
  code_length int not null default 4,
  is_admin_host boolean not null default false,
  status text not null default 'active'
    check (status in ('active', 'pending_ns', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists shortener.links (
  id uuid primary key default gen_random_uuid(),
  namespace text not null,
  code text not null check (code ~ '^[0-9A-Z-]{2,32}$'),
  target_url text not null check (target_url ~ '^https?://'),
  title text,
  tags text[] not null default '{}',
  owner text,
  utm jsonb not null default '{}',
  append_utm boolean not null default false,
  status text not null default 'active'
    check (status in ('active', 'paused', 'archived')),
  expires_at timestamptz,
  fallback_url text,
  version int not null default 1,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (namespace, code)
);

create index if not exists links_owner_idx on shortener.links (owner);
create index if not exists links_updated_at_idx on shortener.links (updated_at);

create table if not exists shortener.clicks (
  id uuid not null,
  ts timestamptz not null,
  host text not null,
  namespace text not null,
  code text not null,
  link_id uuid,
  outcome text not null,
  method text,
  path text,
  query text,
  scheme text,
  country char(2),
  region text,
  region_code text,
  city text,
  timezone text,
  colo text,
  asn int,
  as_org text,
  ua text,
  device text,
  os text,
  browser text,
  browser_version text,
  lang text,
  referer text,
  ip_hash text not null,
  visitor_hash text not null,
  is_bot boolean not null default false,
  bot_name text,
  ray_id text,
  source text not null default 'live',
  inserted_at timestamptz not null default now(),
  primary key (id, ts)
) partition by range (ts);

create index if not exists clicks_link_ts_idx on shortener.clicks (link_id, ts);
create index if not exists clicks_ns_code_ts_idx on shortener.clicks (namespace, code, ts);

-- Default catch-all partition so inserts work before ensure_partitions runs.
create table if not exists shortener.clicks_default partition of shortener.clicks default;

create table if not exists shortener.clicks_daily (
  day date not null,
  namespace text not null,
  code text not null,
  outcome text not null,
  link_id uuid,
  clicks int not null,
  uniques int not null,
  bots int not null,
  by_country jsonb not null default '{}',
  by_city jsonb not null default '{}',
  by_device jsonb not null default '{}',
  by_os jsonb not null default '{}',
  primary key (day, namespace, code, outcome)
);

create table if not exists shortener.api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_hash text not null unique,
  scopes text[] not null,
  owner_prefix text,
  namespaces text[],
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table if not exists shortener.admins (
  email text primary key,
  created_at timestamptz not null default now()
);

create table if not exists shortener.audit (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  actor text not null,
  action text not null,
  namespace text,
  code text,
  before jsonb,
  after jsonb
);

create table if not exists shortener.reconcile_runs (
  day date primary key,
  db_count bigint,
  edge_count bigint,
  diff bigint,
  status text,
  checked_at timestamptz default now()
);

create table if not exists shortener.meta (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
