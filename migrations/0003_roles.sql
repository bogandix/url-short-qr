-- Least-privilege roles. Created NOLOGIN here; the setup wizard then runs
--   alter role shortener_edge  login password '<generated>';
--   alter role shortener_admin login password '<generated>';
-- so passwords never live in a file.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'shortener_edge') then
    create role shortener_edge nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'shortener_admin') then
    create role shortener_admin nologin;
  end if;
end $$;

revoke all on schema shortener from public;
revoke all on all tables in schema shortener from public;
grant usage on schema shortener to shortener_edge, shortener_admin;

-- Edge (Hyperdrive "shortener-edge"): log clicks, read config.
grant insert on shortener.clicks to shortener_edge;
-- ON CONFLICT (id, ts) needs SELECT on the arbiter columns; nothing else is readable.
grant select (id, ts) on shortener.clicks to shortener_edge;
grant select on shortener.links, shortener.domains, shortener.api_keys to shortener_edge;
grant execute on function shortener.ensure_partitions(int), shortener.drop_partitions_older_than(int),
  shortener.rollup_day(date) to shortener_edge;

-- Admin (Hyperdrive "shortener-admin"): API + crons.
grant select, insert, update, delete on shortener.links, shortener.domains, shortener.api_keys,
  shortener.admins, shortener.meta to shortener_admin;
grant select, insert on shortener.audit to shortener_admin;
grant select on shortener.clicks, shortener.clicks_daily to shortener_admin;
grant select, insert, update on shortener.reconcile_runs to shortener_admin;
grant execute on function shortener.ensure_partitions(int), shortener.drop_partitions_older_than(int),
  shortener.rollup_day(date) to shortener_admin;

-- RLS on every table; only these two roles get policies.
do $$
declare
  t text;
begin
  foreach t in array array['domains','links','clicks','clicks_daily','api_keys','admins','audit','reconcile_runs','meta'] loop
    execute format('alter table shortener.%I enable row level security', t);
    execute format('drop policy if exists admin_all on shortener.%I', t);
    execute format('create policy admin_all on shortener.%I to shortener_admin using (true) with check (true)', t);
  end loop;
  foreach t in array array['links','domains','api_keys'] loop
    execute format('drop policy if exists edge_read on shortener.%I', t);
    execute format('create policy edge_read on shortener.%I for select to shortener_edge using (true)', t);
  end loop;
  drop policy if exists edge_insert on shortener.clicks;
  create policy edge_insert on shortener.clicks for insert to shortener_edge with check (true);
  -- ON CONFLICT needs a SELECT policy too; the column grant above limits it to (id, ts).
  drop policy if exists edge_conflict on shortener.clicks;
  create policy edge_conflict on shortener.clicks for select to shortener_edge using (true);
end $$;

-- Supabase: make sure the API roles cannot reach this schema even if it gets exposed by mistake.
do $$
declare
  r text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema shortener from %I', r);
      execute format('revoke all on all tables in schema shortener from %I', r);
      execute format('revoke all on all functions in schema shortener from %I', r);
      execute format('alter default privileges in schema shortener revoke all on tables from %I', r);
    end if;
  end loop;
end $$;

