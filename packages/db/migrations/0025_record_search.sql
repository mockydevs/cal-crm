-- Searching companies and deals by name under row-level security (task P1.25, ADR-033),
-- for the command bar, as contacts are searched (ADR-028): through their full-text and
-- trigram indexes, in functions bound to the request's business, since Postgres won't use
-- those indexes for @@ or ILIKE under a row-level security policy.

-- Deals had no search index. Their names' words, as companies' and contacts' search columns
-- hold them, and a trigram index for any part of a name.
alter table crm.deals add column search tsvector
  generated always as (pg_catalog.to_tsvector('pg_catalog.simple', name)) stored;
create index deals_search_idx on crm.deals using gin (search);
create index deals_name_trgm_idx on crm.deals using gin (name gin_trgm_ops);

-- The ids of the request's business's companies not in the trash whose name or domain has
-- words starting with p_words (a tsquery of word prefixes), or whose name contains p_part
-- (an ILIKE pattern). Either may be null to skip that lookup. Each lookup stops at p_limit
-- ids, and an id can come twice. It reads only the business the request works in
-- (app.require_business_id() fails closed without one); callers read the companies
-- themselves under row-level security.
create function private.search_companies(p_words text, p_part text, p_limit integer)
returns setof uuid
language sql stable security definer set search_path = ''
-- Planned with the search's own values each time, as private.search_contacts is.
set plan_cache_mode = force_custom_plan
as $$
  (select c.id from crm.companies c
   where p_words is not null
     and c.business_id = (select app.require_business_id())
     and c.deleted_at is null
     and c.search @@ pg_catalog.to_tsquery('pg_catalog.simple', p_words)
   limit p_limit)
  union all
  (select c.id from crm.companies c
   where p_part is not null
     and c.business_id = (select app.require_business_id())
     and c.deleted_at is null
     and c.name ilike p_part
   limit p_limit)
$$;

revoke execute on function private.search_companies(text, text, integer) from public;
grant execute on function private.search_companies(text, text, integer) to crm_app;

-- The same for deals, by name.
create function private.search_deals(p_words text, p_part text, p_limit integer)
returns setof uuid
language sql stable security definer set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
  (select d.id from crm.deals d
   where p_words is not null
     and d.business_id = (select app.require_business_id())
     and d.deleted_at is null
     and d.search @@ pg_catalog.to_tsquery('pg_catalog.simple', p_words)
   limit p_limit)
  union all
  (select d.id from crm.deals d
   where p_part is not null
     and d.business_id = (select app.require_business_id())
     and d.deleted_at is null
     and d.name ilike p_part
   limit p_limit)
$$;

revoke execute on function private.search_deals(text, text, integer) from public;
grant execute on function private.search_deals(text, text, integer) to crm_app;
