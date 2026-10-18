-- The trash (task P1.24, ADR-032): contacts, companies and deals in it, most recently
-- trashed first, and the daily purge of those past their business's retention days.

-- The trash's order, (deleted_at, id) descending, read from an index per kind. Timestamp
-- and uuid comparisons are leakproof, so these work under row-level security.
create index contacts_trash_idx
  on crm.contacts (business_id, deleted_at desc, id desc) where deleted_at is not null;
create index companies_trash_idx
  on crm.companies (business_id, deleted_at desc, id desc) where deleted_at is not null;
create index deals_trash_idx
  on crm.deals (business_id, deleted_at desc, id desc) where deleted_at is not null;

-- The businesses with something in the trash past their retention days, for the worker's
-- daily purge, which then purges inside each business under row-level security. Like
-- private.due_enrolments it crosses businesses, so it returns ids only.
create function private.businesses_with_expired_trash(p_limit integer)
returns table (agency_id uuid, business_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, b.id
  from tenancy.businesses b
  cross join lateral (
    select now() - pg_catalog.make_interval(days => coalesce(
      (select s.trash_retention_days from crm.settings s where s.business_id = b.id), 30)) as cutoff
  ) expiry
  where exists (select 1 from crm.contacts c
                where c.business_id = b.id and c.deleted_at < expiry.cutoff)
     or exists (select 1 from crm.companies c
                where c.business_id = b.id and c.deleted_at < expiry.cutoff)
     or exists (select 1 from crm.deals d
                where d.business_id = b.id and d.deleted_at < expiry.cutoff)
  order by b.id
  limit p_limit
$$;

revoke execute on function private.businesses_with_expired_trash(integer) from public;
grant execute on function private.businesses_with_expired_trash(integer) to crm_app;
