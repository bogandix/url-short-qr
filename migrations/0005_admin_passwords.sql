-- Built-in admin login (independent of any auth provider; works on a shared database).
alter table shortener.admins add column if not exists password_hash text;
alter table shortener.admins add column if not exists must_change_password boolean not null default false;
alter table shortener.admins add column if not exists failed_attempts int not null default 0;
alter table shortener.admins add column if not exists locked_until timestamptz;
alter table shortener.admins add column if not exists password_changed_at timestamptz;
-- Bumping this invalidates every session issued before (sign out everywhere).
alter table shortener.admins add column if not exists session_epoch int not null default 0;
