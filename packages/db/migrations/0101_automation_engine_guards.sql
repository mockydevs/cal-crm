-- Guards for the workflow engine (tasks/edge-cases/automation.md, ADR-097): functions that
-- queue the engine's jobs, and at the end a new table for webhook header secrets. No row is
-- rewritten.

-- 1. Fairness between businesses. Graphile Worker takes the ready job with the lowest
-- priority first, then the earliest run_at (graphile-worker 0.18, getJobs: "order by
-- priority asc, run_at asc"; add_job takes a priority). Every automation job was priority 0,
-- so one business's burst of a thousand events put another business's new lead behind all
-- of them. A job's priority is now the size of its business's last minute, in powers of two:
-- the first event of a quiet business is 0, the thousandth of a burst is 8. A quiet
-- business's job goes before the bulk of a busy one's, and a busy business's own jobs keep
-- their order within the burst. At most 256 index entries are read for it.
create function private.automation_job_priority(p_agency_id uuid, p_business_id uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select floor(log(2::numeric, greatest(count(*), 1)::numeric))::integer
  from (
    select 1
    from events.events e
    where e.agency_id = p_agency_id and e.business_id = p_business_id
      and e.recorded_at > now() - interval '1 minute'
    limit 256
  ) as recent
$$;
revoke execute on function private.automation_job_priority(uuid, uuid) from public;

-- 2. The match job (0036), with that priority, and also when the only automation that
-- listens is paused: the match then records "paused" as why it started for nobody, which
-- "Why didn't this run?" reads (tasks/edge-cases/automation.md, case 13).
create or replace function private.queue_automation_match() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.business_id is not null and exists (
    select 1
    from automation.trigger_subscriptions s
    join automation.automations a
      on a.business_id = s.business_id and a.id = s.automation_id
      and a.published_version_id = s.version_id
    where s.business_id = new.business_id and s.event_type = new.type
      and a.status in ('active', 'paused')
  ) or exists (
    -- A running enrolment waits for this kind of event: a stop condition (goal) or a reply.
    select 1
    from automation.event_waits w
    where w.business_id = new.business_id and w.event_type = new.type
  ) or (new.type = 'contact.trashed' and exists (
    -- A contact moved to the trash leaves the workflows it is in: the match ends its runs.
    select 1
    from automation.enrolments e
    where e.business_id = new.business_id and e.record_id = new.subject_id
      and e.status in ('running', 'waiting')
  )) then
    perform graphile_worker.add_job(
      'automations.match_event',
      payload := jsonb_build_object(
        'agencyId', new.agency_id,
        'businessId', new.business_id,
        'correlationId', new.correlation_id,
        'causationId', new.id,
        'data', jsonb_build_object('eventId', new.id)
      )::json,
      priority := private.automation_job_priority(new.agency_id, new.business_id),
      job_key := 'automation-match:' || new.id::text,
      job_key_mode := 'preserve_run_at'
    );
  end if;
  return null;
end
$$;

-- 3. A run's step (0037) runs under the run's own correlation, whoever queues it: the match
-- that started it, a step before it, the event that woke its wait, or the sweeper. So every
-- event a run's steps write carries the correlation of the change that started the run, and
-- the match can tell a run's own writes from a new change (ADR-097). It had the queuer's,
-- which an event's wake or the sweeper changed.
create or replace function private.enqueue_automation_step(p_enrolment_id uuid, p_run_at timestamptz default now())
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_sequence integer;
  v_correlation_id uuid;
  v_job_id bigint;
begin
  select coalesce((e.state ->> 'sequence')::integer, 0), e.correlation_id
    into v_sequence, v_correlation_id
  from automation.enrolments e
  join tenancy.businesses b on b.id = e.business_id
  where e.id = p_enrolment_id and e.business_id = app.business_id() and b.agency_id = app.agency_id()
    and e.status in ('running', 'waiting')
  for update of e;
  if not found then
    raise exception 'enrolment is not available in this context';
  end if;
  select job.id into v_job_id from graphile_worker.add_job(
    'automations.run_step',
    payload := jsonb_build_object(
      'agencyId', app.agency_id(), 'businessId', app.business_id(),
      'correlationId', v_correlation_id, 'causationId', null,
      'data', jsonb_build_object('enrolmentId', p_enrolment_id, 'sequence', v_sequence)
    )::json,
    queue_name := 'automation-enrolment:' || p_enrolment_id::text,
    run_at := p_run_at,
    priority := private.automation_job_priority(app.agency_id(), app.business_id()),
    job_key := 'automation-enrolment:' || p_enrolment_id::text,
    job_key_mode := 'replace'
  ) as job;
  return v_job_id;
end
$$;

-- The same for a webhook's delivery (0043): the run's correlation, and its business's priority.
create or replace function private.enqueue_automation_webhook(p_enrolment_id uuid, p_run_at timestamptz default now())
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_sequence integer;
  v_attempt integer;
  v_correlation_id uuid;
  v_job_id bigint;
begin
  select coalesce((e.state ->> 'sequence')::integer, 0),
         (e.state #>> '{webhook,attempt}')::integer,
         e.correlation_id
    into v_sequence, v_attempt, v_correlation_id
  from automation.enrolments e
  join tenancy.businesses b on b.id = e.business_id
  where e.id = p_enrolment_id and e.business_id = app.business_id() and b.agency_id = app.agency_id()
    and e.status = 'waiting'
  for update of e;
  if not found then
    raise exception 'enrolment is not available in this context';
  end if;
  if v_attempt is null then
    raise exception 'enrolment is not waiting on a webhook';
  end if;
  select job.id into v_job_id from graphile_worker.add_job(
    'automations.call_webhook',
    payload := jsonb_build_object(
      'agencyId', app.agency_id(), 'businessId', app.business_id(),
      'correlationId', v_correlation_id, 'causationId', null,
      'data', jsonb_build_object(
        'enrolmentId', p_enrolment_id, 'sequence', v_sequence, 'attempt', v_attempt)
    )::json,
    queue_name := 'automation-enrolment:' || p_enrolment_id::text,
    run_at := p_run_at,
    priority := private.automation_job_priority(app.agency_id(), app.business_id()),
    job_key := 'automation-webhook:' || p_enrolment_id::text,
    job_key_mode := 'replace'
  ) as job;
  return v_job_id;
end
$$;

-- WEBHOOK HEADER SECRETS (section written by the webhook-headers helper; keep it last)
-- A business's named webhook secrets (case 15): values a webhook step's header sends, such
-- as an API key, so none has to go in the URL, which the document, its versions and every
-- run's history keep. Like the signing secret (0043), each value is sealed in the vault;
-- this row holds only its name and which vault secret it is. Deleting one deletes its row
-- here first, then the vault row (crm_app may delete vault.secrets, 0012), in one
-- transaction, so no sealed value is left behind and none is named by nothing.
create table automation.webhook_secrets (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  -- What a step's header names it by, such as crm_key.
  name text not null constraint webhook_secrets_name_valid
    check (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  secret_id uuid not null,
  created_at timestamptz not null default now(),
  -- When its value was last written, and by whom.
  rotated_at timestamptz not null default now(),
  rotated_by_kind text not null constraint webhook_secrets_rotated_by_kind_valid
    check (rotated_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  rotated_by_id uuid,
  primary key (business_id, id),
  constraint webhook_secrets_name_key unique (business_id, name),
  -- Only a secret of the same business can be named, and each by one row.
  constraint webhook_secrets_secret_key unique (business_id, secret_id),
  foreign key (business_id, secret_id) references vault.secrets (business_id, id)
);
call util.enable_tenant_rls('automation.webhook_secrets');
grant select, insert, update, delete on automation.webhook_secrets to crm_app;
