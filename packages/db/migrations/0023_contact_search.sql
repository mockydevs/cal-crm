-- Contact search and the by-name order under row-level security (task P1.12, ADR-028).
--
-- Postgres uses a condition as an index condition under a row-level security policy only
-- when its functions are LEAKPROOF. ILIKE, LIKE, full-text @@ and lower() aren't, so as
-- crm_app the list's trigram, full-text and lower(name) indexes went unused: each search
-- and each by-name page read every contact of the business.

-- The name as the list sorts it. Plain text comparisons are leakproof, so the by-name
-- keyset reads this index in order. (A generated column can't use display_name, itself
-- generated, so it repeats its expression.)
alter table crm.contacts add column sort_name text generated always as (
  lower(nullif(btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), ''))) stored;

drop index crm.contacts_name_idx;
create index contacts_name_idx
  on crm.contacts (business_id, sort_name, id) where deleted_at is null;

-- The ids of the request's business's contacts a search matches, read through the full
-- text and trigram indexes as the owner, outside row-level security. It reads only the
-- business the request works in (app.require_business_id() fails closed when there's
-- none), and its callers join the ids back to crm.contacts under row-level security.
-- Each search argument may be null to skip that lookup: a tsquery of word prefixes, a LIKE
-- pattern for names and email addresses, and phone number digits. Each lookup stops at
-- p_limit ids, so a caller can tell a narrow search (fewer than p_limit in all, all of
-- them here) from a broad one cheaply. An id can come more than once.
create function private.search_contacts(
  p_words text, p_part text, p_digits text, p_limit integer
) returns setof uuid
language sql stable security definer set search_path = ''
-- Planned with the search's own values each time: a plan for any value would read the
-- whole table to fill a LIMIT that a narrow search never reaches.
set plan_cache_mode = force_custom_plan
as $$
  (select c.id from crm.contacts c
   where p_words is not null
     and c.business_id = (select app.require_business_id())
     and c.search @@ pg_catalog.to_tsquery('pg_catalog.simple', p_words)
   limit p_limit)
  union all
  (select c.id from crm.contacts c
   where p_part is not null
     and c.business_id = (select app.require_business_id())
     and c.display_name ilike p_part
   limit p_limit)
  union all
  (select i.contact_id from crm.contact_identities i
   where p_part is not null
     and i.business_id = (select app.require_business_id())
     and i.kind = 'email'
     and i.value_normalized like pg_catalog.lower(p_part)
   limit p_limit)
  union all
  (select i.contact_id from crm.contact_identities i
   where p_digits is not null
     and i.business_id = (select app.require_business_id())
     and i.kind = 'phone'
     and i.value_normalized like '%' || p_digits || '%'
   limit p_limit)
$$;

revoke execute on function private.search_contacts(text, text, text, integer) from public;
grant execute on function private.search_contacts(text, text, text, integer) to crm_app;
