-- Contacts → bulk actions from the list: export as CSV, send an email or a text message,
-- set do not disturb, and add an opportunity, beside the tags, trash, owner and workflow
-- actions there were. A send, a tag change, an enrolment or an opportunity can also start
-- at a later time, or go out in timed batches (drip mode), as GoHighLevel's bulk actions do.
--
-- Only the list of kinds grows; no row is rewritten. The reasons a contact is skipped are
-- already any short code (contact_bulk_action_items_reason_format).

alter table crm.contact_bulk_actions
  drop constraint contact_bulk_actions_action_valid,
  add constraint contact_bulk_actions_action_valid
    check (action in (
      'add_tags', 'remove_tags', 'trash', 'assign_owner', 'add_to_workflow',
      'export', 'send_email', 'send_sms', 'set_dnd', 'add_opportunity'
    ));

-- failed: an export whose file could not be kept, or an action whose starter is no longer
-- on the team or no longer allowed to do it; failure says why.
alter table crm.contact_bulk_actions
  drop constraint contact_bulk_actions_status_valid,
  add constraint contact_bulk_actions_status_valid
    check (status in ('queued', 'running', 'completed', 'cancelled', 'failed')),
  drop constraint contact_bulk_actions_finished_when_ended,
  add constraint contact_bulk_actions_finished_when_ended
    check ((finished_at is not null) = (status in ('completed', 'cancelled', 'failed')));

alter table crm.contact_bulk_actions
  -- What the person wrote for the action to use: a message and its subject, or why do not
  -- disturb changes. parameters holds ids alone; this is kept apart so it can be let go:
  -- it is cleared when the action ends, since the messages sent keep their own copy and
  -- the audit log keeps the reason.
  add column content jsonb
    constraint contact_bulk_actions_content_object
      check (content is null or jsonb_typeof(content) = 'object'),
  -- An export's file, once written. Set null if the file is deleted.
  add column file_id uuid,
  -- Why a failed action failed, as a code the application has words for.
  add column failure text
    constraint contact_bulk_actions_failure_format check (failure ~ '^[a-z][a-z_]{0,39}$'),
  -- Drip mode: how many contacts a batch reaches, and the seconds from one batch to the
  -- next. Both or neither.
  add column drip_batch_size integer
    constraint contact_bulk_actions_drip_batch_bounded
      check (drip_batch_size between 1 and 10000),
  add column drip_interval_seconds integer
    constraint contact_bulk_actions_drip_interval_bounded
      check (drip_interval_seconds between 60 and 2592000),
  -- When the next contacts may be reached: the start time, or the next batch of a drip.
  -- Null: now.
  add column next_run_at timestamptz,
  -- The place of the last contact the current drip batch reaches. Null: no drip.
  add column window_end integer
    constraint contact_bulk_actions_window_positive check (window_end >= 1),
  add constraint contact_bulk_actions_drip_whole
    check ((drip_batch_size is null) = (drip_interval_seconds is null)),
  add constraint contact_bulk_actions_failure_when_failed
    check ((failure is not null) = (status = 'failed')),
  add constraint contact_bulk_actions_file_fkey foreign key (business_id, file_id)
    references files.files (business_id, id) on delete set null (file_id);

create index contact_bulk_actions_file_idx
  on crm.contact_bulk_actions (business_id, file_id) where file_id is not null;

-- What a file is kept for, when only one way may reach it. contact_export: a bulk export's
-- CSV, every contact's details in one file. Only the export's own link, with the export
-- permission, may open it: never the general link of any file, an import, an attachment or
-- the media library. Null: a file as every other is.
alter table files.files
  add column purpose text constraint files_purpose_valid check (purpose in ('contact_export')),
  add constraint files_purpose_private
    check (purpose is null or (library = false and public_key is null));

-- Runs one of an action's jobs at a time of day: its batches from the start time or the
-- next batch of a drip (contacts.bulk_run), or the removal of an export's file once it has
-- been kept thirty days (contacts.bulk_expire_export). Each job is keyed by the action and
-- the task, so asking again moves the one waiting job rather than adding a second; it
-- carries the caller's tenant context, as every job does.
create function private.enqueue_contact_bulk(
  p_bulk_action_id uuid, p_run_at timestamptz, p_task text default 'contacts.bulk_run'
)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_job_id bigint;
begin
  if p_task not in ('contacts.bulk_run', 'contacts.bulk_expire_export') then
    raise exception '"%" is not a task of a bulk action', p_task;
  end if;
  perform 1
  from crm.contact_bulk_actions a
  join tenancy.businesses b on b.id = a.business_id
  where a.id = p_bulk_action_id and a.business_id = app.business_id()
    and b.agency_id = app.agency_id();
  if not found then
    raise exception 'bulk action is not available in this context';
  end if;
  select job.id into v_job_id from graphile_worker.add_job(
    p_task,
    payload := jsonb_build_object(
      'agencyId', app.agency_id(), 'businessId', app.business_id(),
      'correlationId', app.correlation_id(), 'causationId', null,
      'data', jsonb_build_object('bulkActionId', p_bulk_action_id)
    )::json,
    run_at := p_run_at,
    job_key := p_task || ':' || p_bulk_action_id::text,
    job_key_mode := 'replace'
  ) as job;
  return v_job_id;
end
$$;
revoke execute on function private.enqueue_contact_bulk(uuid, timestamptz, text) from public;
grant execute on function private.enqueue_contact_bulk(uuid, timestamptz, text) to crm_app;

-- A bulk email is a campaign email in all but name, so it counts against the install's
-- ceiling on one agency's campaign emails in 24 hours (CAMPAIGN_AGENCY_DAILY_LIMIT), as a
-- campaign's do, both ways: a campaign sees the bulk emails, and a bulk send the
-- campaigns'. A bulk email is one queued under a bulk action's key and not refused.
create index messages_bulk_email_idx on messaging.messages (business_id, created_at)
  where channel = 'email' and direction = 'outbound' and idempotency_key like 'contact-bulk:%';

create or replace function private.agency_campaign_released() returns bigint
language sql stable security definer set search_path = ''
as $$
  select
    (select count(*)
     from messaging.email_campaign_recipients r
     join tenancy.businesses b on b.id = r.business_id
     where b.agency_id = app.agency_id() and r.released_at > now() - interval '24 hours')
    +
    (select count(*)
     from messaging.messages m
     join tenancy.businesses b on b.id = m.business_id
     where b.agency_id = app.agency_id()
       and m.channel = 'email' and m.direction = 'outbound'
       and m.idempotency_key like 'contact-bulk:%'
       and m.created_at > now() - interval '24 hours'
       and m.status <> 'failed')
$$;

-- Where a file is used, so the media library never deletes one from under its user: an
-- export's file is a bulk action's. The body is 0087's with this one place added. An
-- export's file is never a library file (files_purpose_private), so the library's own list
-- of uses (the contract's mediaUses) has no need to name it. A later migration that adds a
-- place keeps this one.
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
$$;
