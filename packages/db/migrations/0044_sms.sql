-- P1.37 and P1.38: SMS through Twilio (tasks/p137-p138-sms.md). Reuses
-- messaging.provider_connections, messaging.phone_numbers, messaging.channel_accounts,
-- messaging.messages, messaging.consents and intake.webhooks as they are, and adds only
-- what they lack.

-- 1. Connections: what verification learned about the account, and the webhook capability.
alter table messaging.provider_connections
  add column account_type text
    constraint provider_connections_account_type_valid check (account_type in ('trial', 'full')),
  add column account_status text
    constraint provider_connections_account_status_valid
    check (account_status in ('active', 'suspended', 'closed')),
  -- SHA-256 of the unguessable token in this connection's webhook URLs. The token itself
  -- is sealed in the vault with the credentials; only its digest is stored readable.
  add column webhook_digest text
    constraint provider_connections_webhook_digest_format check (webhook_digest ~ '^[0-9a-f]{64}$'),
  add constraint provider_connections_twilio_account_ref
    check (provider <> 'twilio' or account_ref ~ '^AC[0-9a-fA-F]{32}$');
create unique index provider_connections_webhook_digest_unique
  on messaging.provider_connections (webhook_digest) where webhook_digest is not null;

-- 2. Connection attempts: credentials wait sealed while the worker checks them with the
--    provider, as mailbox credentials do (0029). The app can seal but not open (ADR-019).
create table messaging.sms_connection_attempts (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  provider text not null default 'twilio'
    constraint sms_attempts_provider_valid check (provider in ('twilio')),
  label text not null constraint sms_attempts_label_length check (length(btrim(label)) between 1 and 80),
  account_ref text not null constraint sms_attempts_account_ref_format
    check (account_ref ~ '^AC[0-9a-fA-F]{32}$'),
  secret_id uuid,
  status text not null default 'pending' constraint sms_attempts_status_valid
    check (status in ('pending', 'connected', 'failed')),
  connection_id uuid references messaging.provider_connections (id) on delete cascade,
  -- Our own summary (account type, status, number count). Never the provider's response,
  -- which carries the account's auth token.
  result jsonb constraint sms_attempts_result_object check (jsonb_typeof(result) = 'object'),
  failure_code text constraint sms_attempts_failure_valid check (failure_code in (
    'authentication', 'account_inactive', 'provider_unavailable', 'already_connected',
    'expired', 'credentials_unreadable')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  finished_at timestamptz,
  primary key (business_id, id),
  foreign key (business_id, secret_id) references vault.secrets (business_id, id),
  constraint sms_attempts_completion_consistent check (
    (status = 'pending' and secret_id is not null and connection_id is null
      and result is null and failure_code is null and finished_at is null)
    or (status = 'connected' and secret_id is null and connection_id is not null
      and result is not null and failure_code is null and finished_at is not null)
    or (status = 'failed' and secret_id is null and connection_id is null
      and failure_code is not null and finished_at is not null)),
  constraint sms_attempts_expiry_after_creation check (expires_at > created_at)
);
create unique index sms_attempts_pending_account_unique
  on messaging.sms_connection_attempts (business_id, provider, account_ref) where status = 'pending';
create index sms_attempts_secret_idx on messaging.sms_connection_attempts (business_id, secret_id);
create index sms_attempts_connection_idx on messaging.sms_connection_attempts (connection_id);
create index sms_attempts_expiry_idx on messaging.sms_connection_attempts (expires_at, id)
  where status = 'pending';
call util.enable_tenant_rls('messaging.sms_connection_attempts');
grant select, insert, update, delete on messaging.sms_connection_attempts to crm_app;

-- Maintenance lists identifiers only; each cleanup then runs in its own tenant transaction.
create function private.expired_sms_connection_attempts(p_limit integer)
returns table (agency_id uuid, business_id uuid, attempt_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, a.business_id, a.id
  from messaging.sms_connection_attempts a
  join tenancy.businesses b on b.id = a.business_id
  where a.status = 'pending' and a.expires_at <= now()
  order by a.expires_at, a.id
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function private.expired_sms_connection_attempts(integer) from public;
grant execute on function private.expired_sms_connection_attempts(integer) to crm_app;

-- 3. The numbers a provider account owns, as the worker last read them. A cache: the app
--    can't ask the provider itself, because it can't open the credentials. A number is
--    registered from this list, never from a number someone typed.
create table messaging.provider_numbers (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  connection_id uuid not null references messaging.provider_connections (id) on delete cascade,
  provider_number_ref text not null
    constraint provider_numbers_ref_length check (length(provider_number_ref) between 1 and 64),
  e164 text not null constraint provider_numbers_e164_format check (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  friendly_name text not null default ''
    constraint provider_numbers_friendly_name_length check (length(friendly_name) <= 120),
  capabilities text[] not null default '{}' constraint provider_numbers_capabilities_valid
    check (capabilities <@ array['sms', 'mms', 'voice']::text[]),
  seen_at timestamptz not null default now(),
  primary key (business_id, connection_id, provider_number_ref)
);
create index provider_numbers_connection_idx on messaging.provider_numbers (connection_id);
call util.enable_tenant_rls('messaging.provider_numbers');
grant select, insert, update, delete on messaging.provider_numbers to crm_app;

-- 4. A provider number is registered at most once per connection.
alter table messaging.phone_numbers
  add constraint phone_numbers_provider_ref_unique unique (provider_connection_id, provider_number_ref);

-- 5. What the provider says about each outbound SMS: one row per message. Status callbacks
--    arrive in any order and more than once, so a row only ever moves to a higher rank.
create table messaging.sms_deliveries (
  business_id uuid not null,
  message_id uuid not null,
  -- The provider's own word; 'rejected' is ours, for a send the provider refused to create.
  provider_status text not null constraint sms_deliveries_status_valid check (provider_status in (
    'accepted', 'scheduled', 'queued', 'sending', 'sent', 'partially_delivered', 'delivered',
    'undelivered', 'failed', 'canceled', 'read', 'rejected')),
  status_rank smallint not null constraint sms_deliveries_rank_range check (status_rank between 1 and 5),
  provider_error_code integer
    constraint sms_deliveries_error_code_positive check (provider_error_code > 0),
  segments integer constraint sms_deliveries_segments_nonnegative check (segments >= 0),
  -- Reports that contradicted a final status already recorded (delivered after failed).
  conflicts integer not null default 0
    constraint sms_deliveries_conflicts_nonnegative check (conflicts >= 0),
  status_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (business_id, message_id),
  foreign key (business_id, message_id) references messaging.messages (business_id, id) on delete cascade
);
call util.enable_tenant_rls('messaging.sms_deliveries');
grant select, insert, update on messaging.sms_deliveries to crm_app;

-- 6. Intake. The app stores a provider webhook before its signature can be checked,
--    because only the worker can open the signing secret (ADR-019). NULL means "not
--    checked yet": nothing acts on a row until the worker has verified it.
alter table intake.webhooks alter column signature_valid drop not null;
alter table intake.webhooks
  add column provider_connection_id uuid references messaging.provider_connections (id) on delete cascade;
create index webhooks_connection_waiting_idx on intake.webhooks (provider_connection_id)
  where processed_at is null and provider_connection_id is not null;
-- The queue index excludes completed rows and cannot support their FK cleanup.
-- PostgreSQL 18: ddl-constraints.html#DDL-CONSTRAINTS-FK.
create index webhooks_connection_idx on intake.webhooks (provider_connection_id);

-- 7. The public route's only write. One statement: the capability is resolved, the limits
--    are checked, the raw request is stored and its verification job is queued, together
--    or not at all. Storing is not believing: the row is unverified until the worker has
--    checked its signature.
--
--    Limits, all fail closed (the request is refused and nothing is stored):
--    - a body over 64 KiB, or headers over 4 KiB;
--    - 500 requests of one connection waiting for verification;
--    - 20,000 waiting across the install;
--    - 60 admissions per connection / 1,000 per install in a rolling minute;
--    - 5,000 retained rows per connection / 100,000 per install;
--    - 16 MiB retained body+headers per connection / 256 MiB per install.
--    These are local admission defaults, not Twilio provider limits. Processing a row
--    does not remove it from the rate or retained budget; expiry releases storage.
--    Someone who knows a capability can therefore fill only that connection's allowance.
create function private.accept_sms_webhook(
  p_digest text, p_endpoint text, p_headers jsonb, p_body bytea
) returns table (outcome text, webhook_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare
  v_connection uuid;
  v_agency uuid;
  v_business uuid;
  v_provider text;
  v_id uuid;
  v_received timestamptz;
  v_usage record;
  v_bytes integer;
begin
  if p_digest is null or p_digest !~ '^[0-9a-f]{64}$' then
    return query select 'unknown'::text, null::uuid;
    return;
  end if;
  -- A connection of the whole agency (no business) has no tenant to verify in yet.
  select c.id, c.agency_id, c.business_id, c.provider
    into v_connection, v_agency, v_business, v_provider
  from messaging.provider_connections c
  join tenancy.businesses b on b.id = c.business_id
  where c.webhook_digest = p_digest and c.provider = 'twilio'
    and c.status <> 'disconnected' and b.status = 'active';
  if not found then
    return query select 'unknown'::text, null::uuid;
    return;
  end if;
  if p_endpoint is null or p_body is null or p_headers is null
    or p_endpoint !~ '^(inbound|status\?m=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
    or octet_length(p_body) > 65536
    or jsonb_typeof(p_headers) <> 'object' or octet_length(p_headers::text) > 4096 then
    return query select 'refused'::text, null::uuid;
    return;
  end if;
  -- Admission is serialized across the install: a per-connection lock cannot protect
  -- the shared final slot from callbacks of different connections.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('sms-webhook:install', 0));
  -- clock_timestamp is intentionally after the lock, not the transaction's now().
  -- A transaction that waited must not insert an already-aged admission timestamp.
  v_received := clock_timestamp();
  v_bytes := octet_length(p_body) + octet_length(p_headers::text);
  -- One bounded scan accounts for completed and invalid requests as well as waiting
  -- ones. At 100,000 rows admission is refused regardless of any other aggregate.
  -- PostgreSQL 18 FILTER and sum semantics: functions-aggregate / SYNTAX-AGGREGATES.
  select count(*) as retained_install,
    count(*) filter (where w.provider_connection_id = v_connection) as retained_connection,
    count(*) filter (where w.processed_at is null) as waiting_install,
    count(*) filter (where w.provider_connection_id = v_connection and w.processed_at is null) as waiting_connection,
    count(*) filter (where w.received_at > v_received - interval '1 minute') as minute_install,
    count(*) filter (where w.provider_connection_id = v_connection and w.received_at > v_received - interval '1 minute') as minute_connection,
    coalesce(sum(octet_length(w.body) + octet_length(w.headers::text)), 0) as bytes_install,
    coalesce(sum(octet_length(w.body) + octet_length(w.headers::text))
      filter (where w.provider_connection_id = v_connection), 0) as bytes_connection
    into v_usage
  from (
    select provider_connection_id,processed_at,received_at,body,headers
    from intake.webhooks where provider_connection_id is not null limit 100000
  ) w;
  if v_usage.waiting_connection >= 500 or v_usage.waiting_install >= 20000
    or v_usage.minute_connection >= 60 or v_usage.minute_install >= 1000
    or v_usage.retained_connection >= 5000 or v_usage.retained_install >= 100000
    or v_usage.bytes_connection + v_bytes > 16777216
    or v_usage.bytes_install + v_bytes > 268435456 then
    return query select 'over_capacity'::text, null::uuid;
    return;
  end if;
  insert into intake.webhooks (provider, endpoint, headers, body, signature_valid, business_id, provider_connection_id, received_at)
  values (v_provider, p_endpoint, p_headers, p_body, null, v_business, v_connection, v_received)
  returning id into v_id;
  -- The job's scope comes from the connection, never from the request. Shaped as
  -- private.enqueue_job's payload (0020); one queue per business keeps its webhooks in
  -- a single file.
  perform graphile_worker.add_job(
    'sms.apply_webhook',
    payload := jsonb_build_object(
      'agencyId', v_agency, 'businessId', v_business,
      'correlationId', uuidv7(), 'causationId', null,
      'data', jsonb_build_object('webhookId', v_id)
    )::json,
    queue_name := 'sms-webhooks:' || v_business::text,
    job_key := 'sms-webhook:' || v_id::text
  );
  return query select 'accepted'::text, v_id;
end
$$;
revoke execute on function private.accept_sms_webhook(text, text, jsonb, bytea) from public;
grant execute on function private.accept_sms_webhook(text, text, jsonb, bytea) to crm_app;

-- 8. Queues a stored webhook again: to wait for a send that is still in flight, or to
--    replay a stored payload. The caller names only a webhook of its own business.
create function private.enqueue_sms_webhook(p_webhook_id uuid, p_delay_seconds integer default 0)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_job_id bigint;
begin
  if not exists (
    select 1 from intake.webhooks w
    join messaging.provider_connections c on c.id = w.provider_connection_id
    where w.id = p_webhook_id and w.business_id = app.business_id()
      and c.business_id = app.business_id() and c.agency_id = app.agency_id()
  ) then
    raise exception 'webhook is not available in this context';
  end if;
  select job.id into v_job_id from graphile_worker.add_job(
    'sms.apply_webhook',
    payload := jsonb_build_object(
      'agencyId', app.agency_id(), 'businessId', app.business_id(),
      'correlationId', app.correlation_id(), 'causationId', null,
      'data', jsonb_build_object('webhookId', p_webhook_id)
    )::json,
    queue_name := 'sms-webhooks:' || app.business_id()::text,
    run_at := now() + make_interval(secs => least(greatest(coalesce(p_delay_seconds, 0), 0), 300)),
    job_key := 'sms-webhook:' || p_webhook_id::text,
    job_key_mode := 'replace'
  ) as job;
  return v_job_id;
end
$$;
revoke execute on function private.enqueue_sms_webhook(uuid, integer) from public;
grant execute on function private.enqueue_sms_webhook(uuid, integer) to crm_app;

-- 9. Retention of stored provider webhooks, in batches. Verified ones are kept 30 days so
--    they can be replayed; ones with a bad signature one day; ones never verified (their
--    job is long gone) seven days, after which they stop counting against the limits.
create function private.expire_sms_webhooks(p_limit integer) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_deleted integer;
begin
  with due as (
    select w.id from intake.webhooks w
    where w.provider_connection_id is not null
      and (w.received_at < now() - interval '30 days'
        or (w.signature_valid is false and w.received_at < now() - interval '1 day')
        or (w.processed_at is null and w.received_at < now() - interval '7 days'))
    order by w.received_at
    limit least(greatest(p_limit, 1), 10000)
  )
  delete from intake.webhooks w using due where w.id = due.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;
revoke execute on function private.expire_sms_webhooks(integer) from public;
grant execute on function private.expire_sms_webhooks(integer) to crm_app;
