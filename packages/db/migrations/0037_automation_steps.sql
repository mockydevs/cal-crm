-- P1.51 (ADR-043): each step runs as a job, a wait sets wake_at, and a sweeper finds what's
-- due. One lock order everywhere, the enrolment row before its job, so the sweeper and a
-- running step can't deadlock (the inversion found in 0035's review).

-- Enrolments whose wait is over, with their agency so each runs in its own tenant context.
-- Identifiers only; private.due_enrolments (0012) stays as it was.
create function private.due_automation_enrolments(p_limit integer)
returns table (agency_id uuid, business_id uuid, enrolment_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, e.business_id, e.id
  from automation.enrolments e
  join tenancy.businesses b on b.id = e.business_id
  where e.status = 'waiting' and e.wake_at is not null and e.wake_at <= now()
    and b.status = 'active'
  order by e.wake_at
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function private.due_automation_enrolments(integer) from public;
grant execute on function private.due_automation_enrolments(integer) to crm_app;

-- Queues an enrolment's current step to run at p_run_at. The caller names only an enrolment
-- its tenant context can see. The job carries the enrolment's step sequence, so a job left
-- from an earlier visit of the same step never runs it again; one key per enrolment keeps
-- a single pending job, which a later call replaces.
create function private.enqueue_automation_step(p_enrolment_id uuid, p_run_at timestamptz default now())
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_sequence integer;
  v_job_id bigint;
begin
  select coalesce((e.state ->> 'sequence')::integer, 0) into v_sequence
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
      'correlationId', app.correlation_id(), 'causationId', null,
      'data', jsonb_build_object('enrolmentId', p_enrolment_id, 'sequence', v_sequence)
    )::json,
    queue_name := 'automation-enrolment:' || p_enrolment_id::text,
    run_at := p_run_at,
    job_key := 'automation-enrolment:' || p_enrolment_id::text,
    job_key_mode := 'replace'
  ) as job;
  return v_job_id;
end
$$;
revoke execute on function private.enqueue_automation_step(uuid, timestamptz) from public;
grant execute on function private.enqueue_automation_step(uuid, timestamptz) to crm_app;
