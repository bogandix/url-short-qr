-- Codes may be 1–32 characters (random codes: 1–8, default 4).
alter table shortener.links drop constraint if exists links_code_check;
alter table shortener.links add constraint links_code_check check (code ~ '^[0-9A-Z-]{1,32}$');
alter table shortener.domains drop constraint if exists domains_code_length_check;
alter table shortener.domains add constraint domains_code_length_check check (code_length between 1 and 8);
