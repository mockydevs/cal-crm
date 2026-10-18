-- P1.54 webhook.call: each business signs the webhooks its automations send with a secret
-- of its own, sealed in the vault. This row only says which vault secret it is and when it
-- last changed; the secret itself is never stored here.
create table automation.webhook_signing (
  business_id uuid primary key references tenancy.businesses (id) on delete cascade,
  secret_id uuid not null,
  created_at timestamptz not null default now(),
  -- When the secret was last made or replaced, and by whom.
  rotated_at timestamptz not null default now(),
  rotated_by_kind text not null constraint webhook_signing_rotated_by_kind_valid
    check (rotated_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  rotated_by_id uuid,
  -- Only a secret of the same business can be named.
  foreign key (business_id, secret_id) references vault.secrets (business_id, id)
);
create index webhook_signing_secret_idx on automation.webhook_signing (business_id, secret_id);
call util.enable_tenant_rls('automation.webhook_signing');
grant select, insert, update on automation.webhook_signing to crm_app;

-- Queues the delivery of the webhook an enrolment is waiting on, now or later (a retry).
-- Like private.enqueue_automation_step (0037): the enrolment's row is locked before the job
-- is added, the job carries the visit and attempt it is for so a stale one does nothing,
-- and one job per enrolment is kept, in the enrolment's own queue so its jobs never overlap.
create function private.enqueue_automation_webhook(p_enrolment_id uuid, p_run_at timestamptz default now())
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_sequence integer;
  v_attempt integer;
  v_job_id bigint;
begin
  select coalesce((e.state ->> 'sequence')::integer, 0),
         (e.state #>> '{webhook,attempt}')::integer
    into v_sequence, v_attempt
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
      'correlationId', app.correlation_id(), 'causationId', null,
      'data', jsonb_build_object(
        'enrolmentId', p_enrolment_id, 'sequence', v_sequence, 'attempt', v_attempt)
    )::json,
    queue_name := 'automation-enrolment:' || p_enrolment_id::text,
    run_at := p_run_at,
    job_key := 'automation-webhook:' || p_enrolment_id::text,
    job_key_mode := 'replace'
  ) as job;
  return v_job_id;
end
$$;
revoke execute on function private.enqueue_automation_webhook(uuid, timestamptz) from public;
grant execute on function private.enqueue_automation_webhook(uuid, timestamptz) to crm_app;
