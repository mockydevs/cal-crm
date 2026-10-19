-- Call recordings a business's retention setting removed (Phone System stage PS5): the row
-- stays, so the call still says it was recorded, but its audio is gone from the business's
-- files and from the provider.
alter table messaging.call_recordings
  add column deleted_at timestamptz,
  add constraint call_recordings_deleted_no_file check (deleted_at is null or file_id is null);
create index call_recordings_retention_idx on messaging.call_recordings (business_id, created_at)
  where deleted_at is null;

-- Which businesses have a recording older than they keep them, for the worker's daily sweep,
-- which has no tenant context of its own until it picks a business.
create function private.businesses_with_expired_call_recordings(p_limit integer)
returns table (agency_id uuid, business_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, b.id
  from tenancy.businesses b
  join messaging.phone_system_settings s on s.business_id = b.id
  where s.recording_retention_days is not null
    and exists (
      select 1 from messaging.call_recordings r
      where r.business_id = b.id and r.deleted_at is null
        and r.created_at < now() - pg_catalog.make_interval(days => s.recording_retention_days))
  order by b.id
  limit p_limit
$$;
revoke execute on function private.businesses_with_expired_call_recordings(integer) from public;
grant execute on function private.businesses_with_expired_call_recordings(integer) to crm_app;
