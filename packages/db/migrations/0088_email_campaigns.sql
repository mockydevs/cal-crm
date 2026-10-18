-- Marketing plan stage 2 (ADR-090): email campaigns. A campaign is one email to many
-- contacts. Its audience is fixed when sending starts, as one row per contact, and each row
-- is then released to the outbound pipeline (0032) on the campaign lane, a few at a time,
-- inside the mailbox's allowance. Nothing here sends: messaging.messages and
-- messaging.outbound_dispatch still hold what leaves.

-- Folders ----------------------------------------------------------------------------------
-- Campaigns are filed in the nested folders templates have (0069), as a tree of their own:
-- a folder is of one kind, its parent is of the same kind, and names are unique among the
-- folders of one kind in one place.
alter table messaging.template_folders add column kind text not null default 'template'
  constraint template_folders_kind_valid check (kind in ('template', 'campaign'));
alter table messaging.template_folders add constraint template_folders_kind_key
  unique (business_id, id, kind);
alter table messaging.template_folders drop constraint template_folders_name_unique;
alter table messaging.template_folders add constraint template_folders_name_unique
  unique nulls not distinct (business_id, kind, parent_id, name_normalized) deferrable initially immediate;
alter table messaging.template_folders drop constraint template_folders_parent_business;
alter table messaging.template_folders add constraint template_folders_parent_business
  foreign key (business_id, parent_id, kind) references messaging.template_folders (business_id, id, kind);

-- A template is only ever in a folder of templates.
alter table messaging.templates add column folder_kind text not null default 'template'
  constraint templates_folder_kind_fixed check (folder_kind = 'template');
alter table messaging.templates drop constraint templates_folder_business;
alter table messaging.templates add constraint templates_folder_business
  foreign key (business_id, folder_id, folder_kind)
  references messaging.template_folders (business_id, id, kind);
create index templates_folder_kind_idx on messaging.templates (business_id, folder_id, folder_kind);

-- The business's ceiling ---------------------------------------------------------------------
-- The most campaign emails a business releases in 24 hours, over all its campaigns. Null
-- means each campaign mailbox's own daily limit (marketing plan, owner's decision 13).
alter table messaging.settings add column campaign_daily_limit integer
  constraint settings_campaign_daily_limit_range check (campaign_daily_limit between 1 and 100000);

-- Campaigns --------------------------------------------------------------------------------
create table messaging.email_campaigns (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  name text not null constraint email_campaigns_name_length check (length(btrim(name)) between 1 and 120),
  folder_id uuid,
  folder_kind text not null default 'campaign'
    constraint email_campaigns_folder_kind_fixed check (folder_kind = 'campaign'),
  status text not null default 'draft' constraint email_campaigns_status_valid
    check (status in ('draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled', 'failed')),
  -- Why it paused itself or failed. Null when a person did it, or nothing is wrong.
  status_reason text constraint email_campaigns_status_reason_valid check (status_reason in
    ('bounce_rate', 'audience_unavailable', 'audience_too_large', 'audience_empty', 'mailbox_unavailable')),
  mailbox_id uuid,
  from_name text constraint email_campaigns_from_name_valid
    check (from_name is null or (length(from_name) between 1 and 120 and from_name !~ '[\r\n]')),
  reply_to text constraint email_campaigns_reply_to_valid
    check (reply_to is null or (length(reply_to) <= 320 and reply_to ~ '^[^@\s]+@[^@\s]+$')),
  -- One line: a line break in a subject would let text become another header.
  subject text not null default '' constraint email_campaigns_subject_valid
    check (length(subject) <= 255 and subject !~ '[\r\n]'),
  preheader text constraint email_campaigns_preheader_valid
    check (preheader is null or (length(preheader) between 1 and 150 and preheader !~ '[\r\n]')),
  format text not null default 'text' constraint email_campaigns_format_valid check (format in ('text', 'html')),
  body_text text not null default '' constraint email_campaigns_body_text_length check (length(body_text) <= 100000),
  body_html text constraint email_campaigns_body_html_length check (length(body_html) <= 500000),
  -- The template its text was copied from; the copy is the campaign's own.
  template_id uuid,
  -- Who it is for, as the API takes it; read live while it is a draft.
  audience jsonb constraint email_campaigns_audience_object check (jsonb_typeof(audience) = 'object'),
  -- The same, with a smart list replaced by the filter it held when sending started.
  audience_fixed jsonb constraint email_campaigns_audience_fixed_object check (jsonb_typeof(audience_fixed) = 'object'),
  send_at timestamptz,
  batch_size integer constraint email_campaigns_batch_size_range check (batch_size between 1 and 100000),
  batch_every integer constraint email_campaigns_batch_every_range check (batch_every between 1 and 1440),
  batch_unit text constraint email_campaigns_batch_unit_valid check (batch_unit in ('minutes', 'hours', 'days')),
  window_from time,
  window_to time,
  revision integer not null default 1 constraint email_campaigns_revision_positive check (revision > 0),
  -- Progress, written by the campaign task.
  started_at timestamptz,
  finished_at timestamptz,
  -- When a person last resumed it: the bounce rate is counted over what left since.
  resumed_at timestamptz,
  -- The audience is written a batch of contacts at a time, in id order; this is the last one.
  audience_cursor uuid,
  audience_fixed_at timestamptz,
  -- The batch being released (1 is the first) and how many emails of it have been.
  batch_number integer not null default 0 constraint email_campaigns_batch_number_valid check (batch_number >= 0),
  batch_released integer not null default 0 constraint email_campaigns_batch_released_valid check (batch_released >= 0),
  -- When the task looks at it next. Null when there is nothing left to do.
  next_run_at timestamptz,
  wait_reason text constraint email_campaigns_wait_reason_valid check (wait_reason in
    ('batch_interval', 'window', 'mailbox_daily_limit', 'mailbox_warmup_limit', 'business_daily_limit',
     'agency_daily_limit', 'mailbox_pacing')),
  wait_until timestamptz,
  audience_count integer not null default 0,
  pending_count integer not null default 0,
  queued_count integer not null default 0,
  sent_count integer not null default 0,
  skipped_count integer not null default 0,
  failed_count integer not null default 0,
  -- Whoever sent or scheduled it: the audience is read with their eyes.
  started_by_kind text,
  started_by_id uuid,
  created_by_kind text not null constraint email_campaigns_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint email_campaigns_folder foreign key (business_id, folder_id, folder_kind)
    references messaging.template_folders (business_id, id, kind),
  constraint email_campaigns_mailbox foreign key (business_id, mailbox_id)
    references messaging.mailboxes (business_id, id) on delete set null (mailbox_id),
  constraint email_campaigns_template foreign key (business_id, template_id)
    references messaging.templates (business_id, id) on delete set null (template_id),
  constraint email_campaigns_html_by_format check ((format = 'html') = (body_html is not null)),
  constraint email_campaigns_batches_whole check (
    (batch_size is null and batch_every is null and batch_unit is null and window_from is null and window_to is null)
    or (batch_size is not null and batch_every is not null and batch_unit is not null
        and ((window_from is null) = (window_to is null)))),
  -- A draft has no schedule and no progress; anything else was started by someone.
  constraint email_campaigns_draft_unstarted check (
    status <> 'draft' or (send_at is null and started_at is null and batch_size is null and next_run_at is null)),
  constraint email_campaigns_started_by check (status = 'draft' or started_by_kind is not null),
  constraint email_campaigns_finish_needs_start check (finished_at is null or started_at is not null)
);
create index email_campaigns_list_idx on messaging.email_campaigns (business_id, id desc);
create index email_campaigns_folder_idx on messaging.email_campaigns (business_id, folder_id, folder_kind);
create index email_campaigns_mailbox_idx on messaging.email_campaigns (business_id, mailbox_id);
create index email_campaigns_template_idx on messaging.email_campaigns (business_id, template_id);
-- What the sweep reads, over every business: the few campaigns with work due.
create index email_campaigns_due_idx on messaging.email_campaigns (next_run_at) where next_run_at is not null;
call util.enable_tenant_rls('messaging.email_campaigns');
call util.add_updated_at_trigger('messaging.email_campaigns');
grant select, insert, update, delete on messaging.email_campaigns to crm_app;

-- Recipients -------------------------------------------------------------------------------
-- One row per campaign and contact, so nobody is sent a campaign twice whatever is retried.
create table messaging.email_campaign_recipients (
  business_id uuid not null,
  campaign_id uuid not null,
  contact_id uuid not null,
  status text not null default 'pending' constraint email_campaign_recipients_status_valid
    check (status in ('pending', 'queued', 'sent', 'skipped', 'failed')),
  reason text constraint email_campaign_recipients_reason_valid check (reason in
    ('no_email', 'do_not_contact', 'unsubscribed', 'bounced', 'complained', 'suppressed', 'no_consent',
     'no_time_zone', 'contact_removed', 'missing_merge_values', 'mailbox_unavailable',
     'unsubscribe_unavailable', 'cancelled', 'refused')),
  -- For missing_merge_values: the merge fields with no value. Field names, never values.
  fields text[],
  batch integer constraint email_campaign_recipients_batch_positive check (batch > 0),
  message_id uuid,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (business_id, campaign_id, contact_id),
  foreign key (business_id, campaign_id) references messaging.email_campaigns (business_id, id) on delete cascade,
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade,
  foreign key (business_id, message_id) references messaging.messages (business_id, id)
    on delete set null (message_id),
  constraint email_campaign_recipients_skip_has_reason check ((status = 'skipped') = (reason is not null)),
  constraint email_campaign_recipients_release_whole check ((message_id is null) or (released_at is not null))
);
-- The next contacts to release, in id order.
create index email_campaign_recipients_pending_idx
  on messaging.email_campaign_recipients (business_id, campaign_id, contact_id) where status = 'pending';
-- Counts by status and reason, and the recipients list's filters.
create index email_campaign_recipients_status_idx
  on messaging.email_campaign_recipients (business_id, campaign_id, status, reason, contact_id);
-- From a message to its campaign: dispatch asks whether the campaign still sends.
create unique index email_campaign_recipients_message_idx
  on messaging.email_campaign_recipients (business_id, message_id) where message_id is not null;
-- What was released in the last day, for the ceilings; and the contact's cascade.
create index email_campaign_recipients_released_idx
  on messaging.email_campaign_recipients (business_id, released_at) where released_at is not null;
create index email_campaign_recipients_contact_idx
  on messaging.email_campaign_recipients (business_id, contact_id);
call util.enable_tenant_rls('messaging.email_campaign_recipients');
grant select, insert, update on messaging.email_campaign_recipients to crm_app;

-- Tests ------------------------------------------------------------------------------------
-- A test is sent by the worker, which alone opens a mailbox's password, so the request
-- waits here: where it goes stays out of the job queue. Rows older than a day are removed
-- when the next test is asked for.
create table messaging.email_campaign_tests (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  campaign_id uuid not null,
  addresses text[] not null constraint email_campaign_tests_addresses_count
    check (cardinality(addresses) between 1 and 5),
  contact_id uuid,
  status text not null default 'queued' constraint email_campaign_tests_status_valid
    check (status in ('queued', 'sent', 'failed')),
  requested_by_kind text not null,
  requested_by_id uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (business_id, id),
  foreign key (business_id, campaign_id) references messaging.email_campaigns (business_id, id) on delete cascade,
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete set null (contact_id)
);
create index email_campaign_tests_recent_idx on messaging.email_campaign_tests (business_id, created_at);
create index email_campaign_tests_campaign_idx on messaging.email_campaign_tests (business_id, campaign_id);
create index email_campaign_tests_contact_idx on messaging.email_campaign_tests (business_id, contact_id);
call util.enable_tenant_rls('messaging.email_campaign_tests');
grant select, insert, update, delete on messaging.email_campaign_tests to crm_app;

-- The task's reach ---------------------------------------------------------------------------
-- Identifiers only, over every business, as private.due_mailbox_checks: each campaign is
-- then read and locked inside its own business.
create function private.due_email_campaigns(p_limit integer)
returns table (agency_id uuid, business_id uuid, campaign_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, c.business_id, c.id
  from messaging.email_campaigns c
  join tenancy.businesses b on b.id = c.business_id
  where c.next_run_at is not null and c.next_run_at <= now() and b.status = 'active'
  order by c.next_run_at, c.business_id, c.id
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function private.due_email_campaigns(integer) from public;
grant execute on function private.due_email_campaigns(integer) to crm_app;

-- One job per campaign at a time: the key keeps a second request from adding another, and
-- the queue keeps two workers from running one campaign together. Scope comes from the
-- transaction, never from the caller.
create function private.enqueue_email_campaign(p_campaign_id uuid) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_job_id bigint;
begin
  perform 1 from messaging.email_campaigns c
  join tenancy.businesses b on b.id = c.business_id
  where c.id = p_campaign_id and c.business_id = app.business_id() and b.agency_id = app.agency_id();
  if not found then
    raise exception 'email campaign is not available in this context';
  end if;
  select job.id into v_job_id from graphile_worker.add_job(
    'campaigns.run',
    payload := jsonb_build_object(
      'agencyId', app.agency_id(), 'businessId', app.business_id(),
      'correlationId', app.correlation_id(),
      'data', jsonb_build_object('campaignId', p_campaign_id)
    )::json,
    queue_name := 'campaign:' || p_campaign_id::text,
    job_key := 'campaign:' || p_campaign_id::text,
    job_key_mode := 'preserve_run_at',
    -- Behind replies and workflow steps (0 and 1), with campaign mail (2).
    priority := 2
  ) as job;
  return v_job_id;
end
$$;
revoke execute on function private.enqueue_email_campaign(uuid) from public;
grant execute on function private.enqueue_email_campaign(uuid) to crm_app;

-- How many campaign emails the whole agency released in the last 24 hours, for the
-- install's per-agency ceiling. A count only: no business's rows are shown to another.
create function private.agency_campaign_released() returns bigint
language sql stable security definer set search_path = ''
as $$
  select count(*)
  from messaging.email_campaign_recipients r
  join tenancy.businesses b on b.id = r.business_id
  where b.agency_id = app.agency_id() and r.released_at > now() - interval '24 hours'
$$;
revoke execute on function private.agency_campaign_released() from public;
grant execute on function private.agency_campaign_released() to crm_app;
