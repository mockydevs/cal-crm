-- Google Calendar for each team member (P2.E10, ADR-106). A member connects their own
-- Google account in a business; the worker reads the busy time of the calendars they
-- chose into the busy store below, which slots and bookings read, and writes each of
-- their appointments into the one calendar they linked. The refresh token is sealed in
-- vault.secrets for the worker (ADR-019): nothing here holds a token in clear.

-- One per member and business. 'connecting' until the worker has read the calendar list
-- once; 'disconnected' keeps the row (and the sealed token until the worker has revoked
-- it) so the member and the managers can see what happened.
create table calendar.google_connections (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'connecting'
    constraint google_connections_status_valid
      check (status in ('connecting', 'connected', 'disconnected')),
  -- member: they disconnected it; expired_or_revoked: Google refused the refresh token
  -- (invalid_grant); membership_ended: they left the business.
  disconnected_reason text
    constraint google_connections_reason_valid
      check (disconnected_reason in ('member', 'expired_or_revoked', 'membership_ended')),
  -- The Google account: `sub` is its lasting id; the email is a label and may change.
  google_sub text not null
    constraint google_connections_sub_length check (length(google_sub) between 1 and 255),
  google_email text not null
    constraint google_connections_email_length check (length(google_email) between 3 and 320),
  -- The sealed refresh token (purpose calendar.google.refresh_token).
  secret_id uuid,
  -- The calendar appointments are written into (GoHighLevel's linked calendar).
  write_calendar_id text
    constraint google_connections_write_calendar_length
      check (length(write_calendar_id) between 1 and 1024),
  -- The last refresh of the busy store that succeeded, and the last that failed since.
  busy_checked_at timestamptz,
  busy_failed_at timestamptz,
  -- When the worker's sweep next queues a refresh (every 5 minutes, ±25%).
  next_refresh_at timestamptz not null default now(),
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint google_connections_one_per_member unique (business_id, user_id),
  foreign key (business_id, secret_id) references vault.secrets (business_id, id),
  constraint google_connections_reason_when_disconnected
    check ((status = 'disconnected') = (disconnected_reason is not null)),
  constraint google_connections_live_has_secret
    check (status = 'disconnected' or secret_id is not null)
);
create index google_connections_user_idx on calendar.google_connections (user_id, business_id);
create index google_connections_secret_idx on calendar.google_connections (business_id, secret_id);
create index google_connections_due_idx on calendar.google_connections (next_refresh_at)
  where status = 'connected';
create index google_connections_account_idx on calendar.google_connections (google_sub)
  where status <> 'disconnected';
call util.add_updated_at_trigger('calendar.google_connections');

comment on table calendar.google_connections is
  'A team member''s Google Calendar connection in one business (ADR-106). Tokens are sealed in vault.secrets.';

-- A connection started and not yet finished: only the digest of the OAuth state, for
-- ten minutes, spent by the callback.
create table calendar.google_connect_attempts (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  user_id uuid not null references auth.users (id) on delete cascade,
  state_digest bytea not null
    constraint google_connect_attempts_digest_length check (length(state_digest) = 32),
  expires_at timestamptz not null default now() + interval '10 minutes',
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint google_connect_attempts_state_unique unique (state_digest)
);
create index google_connect_attempts_user_idx on calendar.google_connect_attempts (user_id, business_id);

-- The member's Google calendars, as their calendar list last said, with their choice of
-- which ones keep bookings away.
create table calendar.google_calendars (
  business_id uuid not null,
  connection_id uuid not null,
  calendar_id text not null
    constraint google_calendars_id_length check (length(calendar_id) between 1 and 1024),
  name text not null constraint google_calendars_name_length check (length(name) between 1 and 300),
  is_primary boolean not null default false,
  access_role text not null
    constraint google_calendars_access_role_valid
      check (access_role in ('freeBusyReader', 'reader', 'writerWithoutPrivateAccess', 'writer', 'owner')),
  check_conflicts boolean not null default false,
  position integer not null constraint google_calendars_position_range check (position >= 0),
  primary key (business_id, connection_id, calendar_id),
  foreign key (business_id, connection_id)
    references calendar.google_connections (business_id, id) on delete cascade
);

-- Busy time read from Google, and the windows it covers with when each was read. Time
-- outside a recent window is unknown, and unknown time is not free (ADR-106, decision 4).
create table calendar.google_busy (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  connection_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  primary key (business_id, id),
  foreign key (business_id, connection_id)
    references calendar.google_connections (business_id, id) on delete cascade,
  constraint google_busy_finite_ordered
    check (isfinite(starts_at) and isfinite(ends_at) and ends_at > starts_at)
);
create index google_busy_window_idx on calendar.google_busy (business_id, connection_id, ends_at);

create table calendar.google_busy_windows (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  connection_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  checked_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, connection_id)
    references calendar.google_connections (business_id, id) on delete cascade,
  constraint google_busy_windows_finite_ordered
    check (isfinite(starts_at) and isfinite(ends_at) and ends_at > starts_at)
);
create index google_busy_windows_window_idx
  on calendar.google_busy_windows (business_id, connection_id, ends_at);

-- A fresh look at one slot, asked for by a booking (decision 5): the app writes the row
-- and a job, the worker answers it, the app waits a few seconds for the answer.
create table calendar.google_busy_checks (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  connection_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  requested_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text constraint google_busy_checks_outcome_valid check (outcome in ('ok', 'failed')),
  primary key (business_id, id),
  foreign key (business_id, connection_id)
    references calendar.google_connections (business_id, id) on delete cascade,
  constraint google_busy_checks_finite_ordered
    check (isfinite(starts_at) and isfinite(ends_at) and ends_at > starts_at),
  constraint google_busy_checks_finished_with_outcome
    check ((finished_at is null) = (outcome is null))
);
create index google_busy_checks_connection_idx
  on calendar.google_busy_checks (business_id, connection_id, requested_at);

-- What the worker wrote to Google for an appointment. No foreign key to the appointment:
-- the event outlives a deleted appointment until the worker has removed it. A deleted
-- event's id stays taken in its calendar, so the next one takes the next generation.
create table calendar.google_event_syncs (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  appointment_id uuid not null,
  connection_id uuid not null,
  google_calendar_id text not null
    constraint google_event_syncs_calendar_length
      check (length(google_calendar_id) between 1 and 1024),
  -- base32hex, 5 to 1024 characters: Google's rule for an event id the client chooses.
  event_id text not null constraint google_event_syncs_event_id_valid
    check (event_id ~ '^[a-v0-9]+$' and length(event_id) between 5 and 1024),
  generation integer not null default 1 constraint google_event_syncs_generation_range
    check (generation >= 1),
  state text not null constraint google_event_syncs_state_valid check (state in ('written', 'deleted')),
  -- A digest of what was written, so a change that alters nothing in Google sends nothing.
  fingerprint text constraint google_event_syncs_fingerprint_length check (length(fingerprint) = 64),
  written_starts_at timestamptz,
  written_ends_at timestamptz,
  meet_url text constraint google_event_syncs_meet_url_valid
    check (meet_url ~ '^https://' and length(meet_url) <= 1300),
  meet_attempts smallint not null default 0
    constraint google_event_syncs_meet_attempts_range check (meet_attempts between 0 and 100),
  -- Google refused the event itself (400, or 403 other than a rate limit): not retried.
  rejected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, appointment_id),
  foreign key (business_id, connection_id)
    references calendar.google_connections (business_id, id) on delete cascade,
  constraint google_event_syncs_written_interval check (
    (written_starts_at is null) = (written_ends_at is null)
    and (written_starts_at is null or written_ends_at > written_starts_at)
  )
);
create index google_event_syncs_connection_idx
  on calendar.google_event_syncs (business_id, connection_id, written_ends_at);
call util.add_updated_at_trigger('calendar.google_event_syncs');

call util.enable_tenant_rls('calendar.google_connections');
call util.enable_tenant_rls('calendar.google_connect_attempts');
call util.enable_tenant_rls('calendar.google_calendars');
call util.enable_tenant_rls('calendar.google_busy');
call util.enable_tenant_rls('calendar.google_busy_windows');
call util.enable_tenant_rls('calendar.google_busy_checks');
call util.enable_tenant_rls('calendar.google_event_syncs');
grant select, insert, update, delete on
  calendar.google_connections, calendar.google_connect_attempts, calendar.google_calendars,
  calendar.google_busy, calendar.google_busy_windows, calendar.google_busy_checks,
  calendar.google_event_syncs
  to crm_app;

-- The callback reads its attempt before it knows the business: the state's digest names
-- it, and only its tenant and person are given back, never another row.
create function private.find_google_connect_attempt(p_state_digest bytea)
returns table (agency_id uuid, business_id uuid, user_id uuid, attempt_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, a.business_id, a.user_id, a.id
  from calendar.google_connect_attempts a
  join tenancy.businesses b on b.id = a.business_id
  where a.state_digest = p_state_digest and a.expires_at > now() and b.status = 'active'
$$;
revoke execute on function private.find_google_connect_attempt(bytea) from public;
grant execute on function private.find_google_connect_attempt(bytea) to crm_app;

-- Connections whose busy time is due a refresh, across tenants, ids only.
create function private.due_google_refreshes(p_limit integer)
returns table (agency_id uuid, business_id uuid, connection_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, c.business_id, c.id
  from calendar.google_connections c
  join tenancy.businesses b on b.id = c.business_id
  where c.status = 'connected' and b.status = 'active' and c.next_refresh_at <= now()
  order by c.next_refresh_at, c.business_id, c.id
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function private.due_google_refreshes(integer) from public;
grant execute on function private.due_google_refreshes(integer) to crm_app;

-- Old attempts and answered checks go, across tenants. Neither holds anything secret.
create function private.expire_google_scratch() returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_attempts integer;
  v_checks integer;
begin
  delete from calendar.google_connect_attempts where expires_at <= now() - interval '1 hour';
  get diagnostics v_attempts = row_count;
  delete from calendar.google_busy_checks where requested_at <= now() - interval '1 hour';
  get diagnostics v_checks = row_count;
  return v_attempts + v_checks;
end
$$;
revoke execute on function private.expire_google_scratch() from public;
grant execute on function private.expire_google_scratch() to crm_app;

-- A Google job, queued from a tenant transaction as private.enqueue_job queues one (0020),
-- with a key that keeps one waiting job per subject, and an optional start time.
create function private.enqueue_google_job(
  p_task text, p_data jsonb, p_job_key text, p_run_at timestamptz default null
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_agency_id uuid := app.agency_id();
  v_business_id uuid := app.business_id();
  v_job_id bigint;
begin
  if v_agency_id is null or v_business_id is null then
    raise exception 'a Google job needs a business context';
  end if;
  if p_task is null or p_task !~ '^calendar\.google\.[a-z_]+$' then
    raise exception '"%" isn''t a Google task', p_task;
  end if;
  select job.id into v_job_id
  from graphile_worker.add_job(
    p_task,
    payload := jsonb_build_object(
      'agencyId', v_agency_id,
      'businessId', v_business_id,
      'correlationId', coalesce(app.correlation_id(), uuidv7()),
      'causationId', null,
      'data', coalesce(p_data, '{}'::jsonb)
    )::json,
    run_at := p_run_at,
    job_key := p_job_key,
    job_key_mode := 'replace'
  ) as job;
  return v_job_id;
end
$$;
revoke execute on function private.enqueue_google_job(text, jsonb, text, timestamptz) from public;
grant execute on function private.enqueue_google_job(text, jsonb, text, timestamptz) to crm_app;

-- Every write to an appointment queues its sync with Google, in the writer's transaction,
-- whatever wrote it: the booking page, the team, a move, a proposal, an automation. Only
-- where the business has a Google connection for its old or new host, or the appointment
-- is already in Google. One queue per business keeps its writes in order; the key keeps
-- one waiting job per appointment, so a burst of changes is written once.
create function private.queue_google_event_sync() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_business_id uuid;
  v_appointment_id uuid;
  v_old_user uuid;
  v_new_user uuid;
  v_agency_id uuid;
begin
  if tg_op = 'DELETE' then
    v_business_id := old.business_id;
    v_appointment_id := old.id;
  else
    v_business_id := new.business_id;
    v_appointment_id := new.id;
  end if;
  if tg_op <> 'INSERT' then v_old_user := old.assigned_user_id; end if;
  if tg_op <> 'DELETE' then v_new_user := new.assigned_user_id; end if;
  if not exists (
    select 1 from calendar.google_connections c
    where c.business_id = v_business_id and c.status <> 'disconnected'
      and c.user_id in (v_old_user, v_new_user)
  ) and not exists (
    select 1 from calendar.google_event_syncs s
    where s.business_id = v_business_id and s.appointment_id = v_appointment_id
      and s.state = 'written'
  ) then
    return null;
  end if;
  select b.agency_id into v_agency_id from tenancy.businesses b where b.id = v_business_id;
  perform graphile_worker.add_job(
    'calendar.google.sync_appointment',
    payload := jsonb_build_object(
      'agencyId', v_agency_id,
      'businessId', v_business_id,
      'correlationId', coalesce(app.correlation_id(), uuidv7()),
      'causationId', null,
      'data', jsonb_build_object('appointmentId', v_appointment_id)
    )::json,
    queue_name := 'calendar-google:' || v_business_id::text,
    job_key := 'calendar-google-event:' || v_appointment_id::text,
    job_key_mode := 'replace'
  );
  return null;
end
$$;
revoke execute on function private.queue_google_event_sync() from public;

create trigger appointments_queue_google_sync
  after insert or delete or update of status, starts_at, ends_at, assigned_user_id, title, location
  on calendar.appointments
  for each row execute function private.queue_google_event_sync();

-- The member is told when Google stops answering for them (decision 8). The notification
-- opens their Connections page, which has no id of its own, as the AI settings have none.
alter table notifications.notifications
  drop constraint notifications_kind_valid,
  add constraint notifications_kind_valid check (kind in (
    'conversation.assigned', 'message.received', 'message.received_other', 'task.assigned',
    'task.due', 'appointment.booked', 'appointment.rescheduled', 'appointment.cancelled',
    'form.submitted', 'ai.limit_reached', 'automation.notice', 'calendar.google_disconnected'
  )),
  drop constraint notifications_subject_kind_valid,
  add constraint notifications_subject_kind_valid check (subject_kind in (
    'conversation', 'task', 'form', 'appointment', 'ai_settings', 'automation',
    'calendar_connections'
  )),
  drop constraint notifications_subject_named,
  add constraint notifications_subject_named
    check ((subject_id is null) = (subject_kind in ('ai_settings', 'calendar_connections')));

alter table notifications.preferences
  drop constraint preferences_kind_valid,
  add constraint preferences_kind_valid check (kind in (
    'conversation.assigned', 'message.received', 'message.received_other', 'task.assigned',
    'task.due', 'appointment.booked', 'appointment.rescheduled', 'appointment.cancelled',
    'form.submitted', 'ai.limit_reached', 'automation.notice', 'calendar.google_disconnected'
  ));

-- Revoking a token at Google ends the account's whole grant to this install's client. A
-- connection is revoked only when no other live connection, in any business, uses the
-- same Google account; the answer is a yes or no, never a row.
create function private.google_account_in_use(p_sub text, p_except uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from calendar.google_connections c
    where c.google_sub = p_sub and c.id <> p_except and c.status <> 'disconnected'
  )
$$;
revoke execute on function private.google_account_in_use(text, uuid) from public;
grant execute on function private.google_account_in_use(text, uuid) to crm_app;
