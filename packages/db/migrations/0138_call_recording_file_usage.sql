-- Where a file is used: a call recording's audio too (0136), so the media library never
-- deletes one and the integrity check knows every reference to a file.
create or replace function files.file_usage(p_file_id uuid)
returns table (place text)
language sql stable set search_path = ''
as $$
  select 'business_logo' where exists (
    select 1 from tenancy.businesses where logo_file_id = p_file_id)
  union all
  select 'agency_logo' where exists (
    select 1 from tenancy.agencies where logo_file_id = p_file_id)
  union all
  select 'user_picture' where exists (
    select 1 from tenancy.user_profiles where avatar_file_id = p_file_id)
  union all
  select 'calendar' where exists (
    select 1 from calendar.calendars where logo_file_id = p_file_id or cover_file_id = p_file_id)
  union all
  select 'message_attachment' where exists (
    select 1 from messaging.message_attachments where file_id = p_file_id)
  union all
  select 'import' where exists (
    select 1 from imports.jobs where file_id = p_file_id or error_file_id = p_file_id)
  union all
  select 'site_template' where exists (
    select 1 from sites.templates where preview_file_id = p_file_id)
  union all
  select 'contact_export' where exists (
    select 1 from crm.contact_bulk_actions where file_id = p_file_id)
  union all
  select 'record_file' where exists (
    select 1 from crm.record_files where file_id = p_file_id)
  union all
  select 'call_recording' where exists (
    select 1 from messaging.call_recordings where file_id = p_file_id)
$$;
