-- Settings → Integrations: the accounts a business connects on that page, one row per
-- business and provider account. The provider's credentials (an OAuth token pair or a pasted
-- key) are sealed in vault.secrets for the worker, which alone opens them (ADR-019): the app
-- seals what the provider gave at the callback, or the key that was pasted, and never reads
-- one back. Connections that live on pages of their own (Google Calendar, mailboxes, the
-- phone system, email verification, AI models) keep their own tables; the page reads them.
--
-- What is kept, and for how long:
-- - integrations.connections: the account's id and name at the provider, its health and its
--   settings. A disconnected one stays thirty days, without its credentials, so the page can
--   say what happened.
-- - integrations.connect_attempts: only the digest of an OAuth state, for ten minutes.
-- - integrations.external_ids: which record here is which record at the provider, for a
--   sync that must not make anything twice. Kept with its connection.
-- - integrations.activity: what happened to a connection (connected, checked, failed,
--   disconnected). Thirty days, and at most two hundred rows a connection.
-- - intake.webhooks rows of a connection: what a provider sent, unverified until the worker
--   has checked its signature (ADR-045). Thirty days verified, a day with a bad signature.
-- private.maintain_integrations is called by the worker's schedule.

create schema integrations;
grant usage on schema integrations to crm_app;

create table integrations.connections (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  -- The catalogue's key: the provider. 'google' is Google Calendar's own (0106).
  provider text not null
    constraint connections_provider_format
      check (provider ~ '^[a-z][a-z0-9_]{1,39}$' and provider <> 'google'),
  -- The account at the provider (a workspace id, a realm id, a shop's domain) and its name.
  -- Unknown until the worker has read it once.
  account_ref text
    constraint connections_account_ref_length check (length(account_ref) between 1 and 255),
  account_label text
    constraint connections_account_label_length check (length(account_label) between 1 and 200),
  status text not null default 'connecting'
    constraint connections_status_valid
      check (status in ('connecting', 'connected', 'needs_attention', 'disconnected')),
  error_code text
    constraint connections_error_code_valid check (error_code in (
      'reauthorize', 'missing_permission', 'rate_limited', 'provider_error', 'plan_limit',
      'config_missing'
    )),
  -- Plain words for people; never a token, a key or the provider's raw answer.
  error_detail text
    constraint connections_error_detail_length check (length(error_detail) between 1 and 300),
  scopes_granted text[] not null default '{}'
    constraint connections_scopes_count check (cardinality(scopes_granted) <= 100),
  -- The sealed credentials (purpose integrations.<provider>.credentials). Removed by the
  -- worker once it has revoked them at the provider.
  secret_id uuid,
  settings jsonb not null default '{}'
    constraint connections_settings_object
      check (jsonb_typeof(settings) = 'object' and octet_length(settings::text) <= 16384),
  is_primary boolean not null default false,
  -- The SHA-256 of the capability in the provider's webhook address, in hex.
  webhook_digest text
    constraint connections_webhook_digest_format check (webhook_digest ~ '^[0-9a-f]{64}$'),
  last_ok_at timestamptz,
  last_error_at timestamptz,
  -- When the worker's sweep next checks the account (about daily, spread).
  next_check_at timestamptz not null default now(),
  connected_by uuid references auth.users (id) on delete set null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  -- user: someone disconnected it; provider_revoked: the provider refused it for good.
  disconnected_reason text
    constraint connections_disconnected_reason_valid
      check (disconnected_reason in ('user', 'provider_revoked')),
  revision integer not null default 1 constraint connections_revision_positive check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, secret_id) references vault.secrets (business_id, id),
  constraint connections_reason_when_disconnected
    check ((status = 'disconnected') = (disconnected_reason is not null)
      and (status = 'disconnected') = (disconnected_at is not null)),
  constraint connections_error_when_attention
    check ((status = 'needs_attention') = (error_code is not null)),
  constraint connections_live_has_secret check (status = 'disconnected' or secret_id is not null),
  constraint connections_connected_has_account
    check (status <> 'connected' or (account_ref is not null and account_label is not null)),
  constraint connections_primary_is_live check (not is_primary or status <> 'disconnected')
);
-- One live row per account, and at most one primary account per provider.
create unique index connections_account_unique
  on integrations.connections (business_id, provider, account_ref)
  where status <> 'disconnected' and account_ref is not null;
create unique index connections_one_primary
  on integrations.connections (business_id, provider) where is_primary;
create index connections_secret_idx on integrations.connections (business_id, secret_id);
create index connections_connected_by_idx on integrations.connections (connected_by);
create index connections_due_idx on integrations.connections (next_check_at)
  where status <> 'disconnected';
create unique index connections_webhook_idx on integrations.connections (webhook_digest)
  where webhook_digest is not null;
call util.add_updated_at_trigger('integrations.connections');

comment on table integrations.connections is
  'An account a business connected in Settings → Integrations. Credentials are sealed in vault.secrets.';

-- A connection started and not yet finished: only the digest of the OAuth state, for ten
-- minutes, spent by the callback. The PKCE verifier is made from the state with the
-- operator's client secret, so nothing more is kept.
create table integrations.connect_attempts (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  provider text not null
    constraint connect_attempts_provider_format check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  state_digest bytea not null
    constraint connect_attempts_digest_length check (length(state_digest) = 32),
  expires_at timestamptz not null default now() + interval '10 minutes',
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint connect_attempts_state_unique unique (state_digest)
);
create index connect_attempts_user_idx on integrations.connect_attempts (user_id, business_id);

-- Which record here is which record at the provider, both ways, for a sync that must never
-- make anything twice. The provider's version (a sync token, an etag) says what was seen.
create table integrations.external_ids (
  business_id uuid not null,
  connection_id uuid not null,
  entity_kind text not null
    constraint external_ids_entity_kind_format check (entity_kind ~ '^[a-z][a-z_]{1,39}$'),
  entity_id uuid not null,
  external_id text not null
    constraint external_ids_external_id_length check (length(external_id) between 1 and 255),
  external_version text
    constraint external_ids_external_version_length check (length(external_version) between 1 and 255),
  synced_at timestamptz not null default now(),
  primary key (business_id, connection_id, entity_kind, entity_id),
  constraint external_ids_external_unique unique (business_id, connection_id, entity_kind, external_id),
  foreign key (business_id, connection_id)
    references integrations.connections (business_id, id) on delete cascade
);

-- What happened to a connection, for its Activity list. Written once, never changed.
create table integrations.activity (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  connection_id uuid not null,
  kind text not null
    constraint activity_kind_valid check (kind in (
      'connected', 'confirmed', 'check_ok', 'check_failed', 'webhook_received',
      'settings_changed', 'disconnected', 'revoked'
    )),
  error_code text
    constraint activity_error_code_valid check (error_code in (
      'reauthorize', 'missing_permission', 'rate_limited', 'provider_error', 'plan_limit',
      'config_missing'
    )),
  detail text constraint activity_detail_length check (length(detail) between 1 and 300),
  at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, connection_id)
    references integrations.connections (business_id, id) on delete cascade
);
create index activity_connection_idx on integrations.activity (business_id, connection_id, at desc);

call util.enable_tenant_rls('integrations.connections');
call util.enable_tenant_rls('integrations.connect_attempts');
call util.enable_tenant_rls('integrations.external_ids');
call util.enable_tenant_rls('integrations.activity');
grant select, insert, update, delete on
  integrations.connections, integrations.connect_attempts, integrations.external_ids
  to crm_app;
-- Activity is appended to; only the schedule below removes old rows.
grant select, insert on integrations.activity to crm_app;

-- A provider's callback, stored before its signature can be checked: only the worker can
-- open the secret it is signed with. NULL signature_valid means not checked yet (0044).
alter table intake.webhooks add column integration_connection_id uuid;
alter table intake.webhooks
  add constraint webhooks_integration_connection_fk
    foreign key (business_id, integration_connection_id)
    references integrations.connections (business_id, id) on delete cascade not valid;
alter table intake.webhooks validate constraint webhooks_integration_connection_fk;
create index webhooks_integration_connection_idx
  on intake.webhooks (business_id, integration_connection_id);
create index webhooks_integration_waiting_idx on intake.webhooks (integration_connection_id)
  where processed_at is null and integration_connection_id is not null;

-- The callback reads its attempt before it knows the business: the state's digest names
-- it, and only its tenant, person and provider are given back, never another row.
create function private.find_integration_connect_attempt(p_state_digest bytea)
returns table (agency_id uuid, business_id uuid, user_id uuid, attempt_id uuid, provider text)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, a.business_id, a.user_id, a.id, a.provider
  from integrations.connect_attempts a
  join tenancy.businesses b on b.id = a.business_id
  where a.state_digest = p_state_digest and a.expires_at > now() and b.status = 'active'
$$;
revoke execute on function private.find_integration_connect_attempt(bytea) from public;
grant execute on function private.find_integration_connect_attempt(bytea) to crm_app;

-- Connections whose check is due, across tenants, ids only: a working one, one still
-- waiting for its first reading, and one whose provider did not answer. A connection
-- waiting for its person to sign in again (reauthorize) or for the operator
-- (config_missing) is not checked: nothing would change until they act.
create function private.due_integration_checks(p_limit integer)
returns table (agency_id uuid, business_id uuid, connection_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, c.business_id, c.id
  from integrations.connections c
  join tenancy.businesses b on b.id = c.business_id
  where b.status = 'active' and c.next_check_at <= now()
    and (c.status in ('connected', 'connecting')
      or (c.status = 'needs_attention' and c.error_code not in ('reauthorize', 'config_missing')))
  order by c.next_check_at, c.business_id, c.id
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function private.due_integration_checks(integer) from public;
grant execute on function private.due_integration_checks(integer) to crm_app;

-- An integration job, queued from a tenant transaction as private.enqueue_job queues one
-- (0020), with a key that keeps one waiting job per subject, and an optional start time.
create function private.enqueue_integration_job(
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
    raise exception 'an integration job needs a business context';
  end if;
  if p_task is null or p_task !~ '^integrations\.[a-z_]+$' then
    raise exception '"%" isn''t an integration task', p_task;
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
    queue_name := 'integrations:' || v_business_id::text,
    run_at := p_run_at,
    job_key := p_job_key,
    job_key_mode := 'replace'
  ) as job;
  return v_job_id;
end
$$;
revoke execute on function private.enqueue_integration_job(text, jsonb, text, timestamptz) from public;
grant execute on function private.enqueue_integration_job(text, jsonb, text, timestamptz) to crm_app;

-- The public webhook route's only write. One statement: the capability is resolved, the
-- limits are checked, the raw request is stored and its verification job is queued,
-- together or not at all. Storing is not believing: the row is unverified until the worker
-- has checked its signature, and nothing acts on it before.
--
-- Limits, all fail closed (the request is refused and nothing is stored): a body over
-- 256 KiB or headers over 8 KiB; 500 requests of one connection waiting, 20,000 across the
-- install; 120 admissions a minute per connection, 2,000 across the install; 5,000 retained
-- rows per connection, 100,000 across the install. These are this install's admission
-- defaults, not any provider's limits.
create function private.accept_integration_webhook(
  p_provider text, p_digest text, p_headers jsonb, p_body bytea
) returns table (outcome text, webhook_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare
  v_connection uuid;
  v_agency uuid;
  v_business uuid;
  v_id uuid;
  v_received timestamptz;
  v_usage record;
begin
  if p_digest is null or p_digest !~ '^[0-9a-f]{64}$'
    or p_provider is null or p_provider !~ '^[a-z][a-z0-9_]{1,39}$' then
    return query select 'unknown'::text, null::uuid;
    return;
  end if;
  select c.id, b.agency_id, c.business_id into v_connection, v_agency, v_business
  from integrations.connections c
  join tenancy.businesses b on b.id = c.business_id
  where c.webhook_digest = p_digest and c.provider = p_provider
    and c.status <> 'disconnected' and b.status = 'active';
  if not found then
    return query select 'unknown'::text, null::uuid;
    return;
  end if;
  if p_body is null or p_headers is null or octet_length(p_body) > 262144
    or jsonb_typeof(p_headers) <> 'object' or octet_length(p_headers::text) > 8192 then
    return query select 'refused'::text, null::uuid;
    return;
  end if;
  -- Admission is serialized across the install, so the last free slot is taken once.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('integration-webhook:install', 0));
  v_received := clock_timestamp();
  select count(*) as retained_install,
    count(*) filter (where w.integration_connection_id = v_connection) as retained_connection,
    count(*) filter (where w.processed_at is null) as waiting_install,
    count(*) filter (where w.integration_connection_id = v_connection and w.processed_at is null)
      as waiting_connection,
    count(*) filter (where w.received_at > v_received - interval '1 minute') as minute_install,
    count(*) filter (where w.integration_connection_id = v_connection
      and w.received_at > v_received - interval '1 minute') as minute_connection
    into v_usage
  from (
    select integration_connection_id, processed_at, received_at
    from intake.webhooks where integration_connection_id is not null limit 100000
  ) w;
  if v_usage.waiting_connection >= 500 or v_usage.waiting_install >= 20000
    or v_usage.minute_connection >= 120 or v_usage.minute_install >= 2000
    or v_usage.retained_connection >= 5000 or v_usage.retained_install >= 100000 then
    return query select 'over_capacity'::text, null::uuid;
    return;
  end if;
  insert into intake.webhooks
    (provider, endpoint, headers, body, signature_valid, business_id, integration_connection_id,
     received_at)
  values (p_provider, 'integration', p_headers, p_body, null, v_business, v_connection, v_received)
  returning id into v_id;
  -- The job's scope comes from the connection, never from the request. One queue per
  -- business keeps its webhooks in order.
  perform graphile_worker.add_job(
    'integrations.verify_webhook',
    payload := jsonb_build_object(
      'agencyId', v_agency, 'businessId', v_business,
      'correlationId', uuidv7(), 'causationId', null,
      'data', jsonb_build_object('webhookId', v_id)
    )::json,
    queue_name := 'integration-webhooks:' || v_business::text,
    job_key := 'integration-webhook:' || v_id::text
  );
  return query select 'accepted'::text, v_id;
end
$$;
revoke execute on function private.accept_integration_webhook(text, text, jsonb, bytea) from public;
grant execute on function private.accept_integration_webhook(text, text, jsonb, bytea) to crm_app;

-- What the schedule clears, across tenants, in batches; none of it holds a secret:
-- attempts an hour past their time; activity past thirty days or beyond a connection's
-- latest two hundred; connections disconnected thirty days ago whose credentials are gone;
-- their webhooks after thirty days, a day when the signature was bad, or seven days never
-- checked.
create function private.maintain_integrations(p_limit integer) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_limit integer := least(greatest(p_limit, 1), 10000);
  v_total integer := 0;
  v_count integer;
begin
  delete from integrations.connect_attempts where expires_at <= now() - interval '1 hour';
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;
  with ranked as (
    select a.business_id, a.id,
      row_number() over (partition by a.business_id, a.connection_id order by a.at desc, a.id desc)
        as place,
      a.at
    from integrations.activity a
  ), due as (
    select business_id, id from ranked
    where place > 200 or at < now() - interval '30 days'
    limit v_limit
  )
  delete from integrations.activity a using due
  where a.business_id = due.business_id and a.id = due.id;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;
  with due as (
    select w.id from intake.webhooks w
    where w.integration_connection_id is not null
      and (w.received_at < now() - interval '30 days'
        or (w.signature_valid is false and w.received_at < now() - interval '1 day')
        or (w.processed_at is null and w.received_at < now() - interval '7 days'))
    order by w.received_at
    limit v_limit
  )
  delete from intake.webhooks w using due where w.id = due.id;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;
  with due as (
    select c.business_id, c.id from integrations.connections c
    where c.status = 'disconnected' and c.secret_id is null
      and c.disconnected_at < now() - interval '30 days'
    limit v_limit
  )
  delete from integrations.connections c using due
  where c.business_id = due.business_id and c.id = due.id;
  get diagnostics v_count = row_count;
  return v_total + v_count;
end
$$;
revoke execute on function private.maintain_integrations(integer) from public;
grant execute on function private.maintain_integrations(integer) to crm_app;

-- Those who manage the business's integrations are told when one needs them. The
-- notification opens Settings → Integrations, which has no id of its own.
alter table notifications.notifications
  drop constraint notifications_kind_valid,
  add constraint notifications_kind_valid check (kind in (
    'conversation.assigned', 'message.received', 'message.received_other',
    'message.received_following', 'task.assigned', 'task.reminder', 'task.due',
    'appointment.booked', 'appointment.rescheduled', 'appointment.cancelled', 'form.submitted',
    'ai.limit_reached', 'automation.notice', 'calendar.google_disconnected',
    'integration.needs_attention'
  )) not valid,
  drop constraint notifications_subject_kind_valid,
  add constraint notifications_subject_kind_valid check (subject_kind in (
    'conversation', 'task', 'form', 'appointment', 'ai_settings', 'automation',
    'calendar_connections', 'integrations'
  )) not valid,
  drop constraint notifications_subject_named,
  add constraint notifications_subject_named
    check ((subject_id is null)
      = (subject_kind in ('ai_settings', 'calendar_connections', 'integrations'))) not valid;
alter table notifications.notifications validate constraint notifications_kind_valid;
alter table notifications.notifications validate constraint notifications_subject_kind_valid;
alter table notifications.notifications validate constraint notifications_subject_named;

alter table notifications.preferences
  drop constraint preferences_kind_valid,
  add constraint preferences_kind_valid check (kind in (
    'conversation.assigned', 'message.received', 'message.received_other',
    'message.received_following', 'task.assigned', 'task.reminder', 'task.due',
    'appointment.booked', 'appointment.rescheduled', 'appointment.cancelled', 'form.submitted',
    'ai.limit_reached', 'automation.notice', 'calendar.google_disconnected',
    'integration.needs_attention'
  )) not valid;
alter table notifications.preferences validate constraint preferences_kind_valid;
