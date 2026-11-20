-- URL schemes are case-insensitive (RFC 3986): accept HTTPS:// as well as https://.
-- The API also stores the scheme lowercase; this keeps the database from rejecting it.
alter table shortener.links drop constraint if exists links_target_url_check;
alter table shortener.links add constraint links_target_url_check check (target_url ~* '^https?://');
