-- Email verification from a workflow and from the contact list: the Email verification
-- step checks a contact's primary address in a job of its own, and the list's bulk
-- actions gain "Verify emails", whose checks wait behind all other work. No row is
-- rewritten.

-- Only the list of kinds grows. Added NOT VALID, then validated: the new check is looser,
-- so every row already passes it.
alter table crm.contact_bulk_actions
  drop constraint contact_bulk_actions_action_valid;
alter table crm.contact_bulk_actions
  add constraint contact_bulk_actions_action_valid
    check (action in (
      'add_tags', 'remove_tags', 'trash', 'assign_owner', 'add_to_workflow',
      'export', 'send_email', 'send_sms', 'set_dnd', 'add_opportunity', 'verify_emails'
    )) not valid;
alter table crm.contact_bulk_actions validate constraint contact_bulk_actions_action_valid;

-- An Email verification step never holds its transaction open across the check: it arms,
-- the enrolment waits at the step, and this job checks the address with no transaction
-- open, records the result under the enrolment's lock, and runs the step again. As a
-- webhook delivery does, it runs in the enrolment's own queue, so it never overlaps a step
-- of the same run, and it is keyed by the enrolment, so asking again moves the one job.
create function private.enqueue_automation_email_check(
  p_enrolment_id uuid, p_run_at timestamptz default now()
)
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
         (e.state #>> '{emailCheck,attempt}')::integer,
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
    raise exception 'enrolment is not waiting on an email check';
  end if;
  -- A database without the job queue (a schema check) queues nothing.
  if to_regprocedure('graphile_worker.remove_job(text)') is null then
    return null;
  end if;
  select job.id into v_job_id from graphile_worker.add_job(
    'automations.check_email',
    payload := jsonb_build_object(
      'agencyId', app.agency_id(), 'businessId', app.business_id(),
      'correlationId', v_correlation_id, 'causationId', null,
      'data', jsonb_build_object(
        'enrolmentId', p_enrolment_id, 'sequence', v_sequence, 'attempt', v_attempt)
    )::json,
    queue_name := 'automation-enrolment:' || p_enrolment_id::text,
    run_at := p_run_at,
    priority := private.automation_job_priority(app.agency_id(), app.business_id()),
    job_key := 'automation-email-check:' || p_enrolment_id::text,
    job_key_mode := 'replace'
  ) as job;
  return v_job_id;
end
$$;
revoke execute on function private.enqueue_automation_email_check(uuid, timestamptz) from public;
grant execute on function private.enqueue_automation_email_check(uuid, timestamptz) to crm_app;

-- A bulk action's checks: queued as the contact page queues one, but at a priority the
-- worker takes after all other work (graphile-worker takes the lowest priority first, and
-- every other job here is 0 to 8), and at the time the action paces it for. A send held for
-- the same address queues its check again at the ordinary priority, which replaces this
-- job (job key replace), so it never waits behind a bulk action.
create function private.enqueue_email_verification(
  p_id uuid, p_check_id uuid, p_run_at timestamptz, p_priority integer
)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_job_id bigint;
begin
  if p_priority is null or p_priority < 0 then
    raise exception 'a priority is a whole number from 0';
  end if;
  perform 1 from messaging.email_verifications v
    join tenancy.businesses b on b.id=v.business_id
    where v.id=p_id and v.business_id=app.business_id() and b.agency_id=app.agency_id();
  if not found then raise exception 'verification is not available in this context'; end if;
  if to_regprocedure('graphile_worker.remove_job(text)') is null then return null; end if;
  select j.id into v_job_id from graphile_worker.add_job('messaging.verify_address',
    payload := jsonb_build_object('agencyId',app.agency_id(),'businessId',app.business_id(),
      'correlationId',app.correlation_id(),'causationId',null,
      'data',jsonb_build_object('verificationId',p_id,'checkId',p_check_id))::json,
    run_at := p_run_at, priority := p_priority,
    job_key := 'email-verification:' || p_id::text, job_key_mode := 'replace') as j;
  return v_job_id;
end $$;
revoke execute on function private.enqueue_email_verification(uuid,uuid,timestamptz,integer) from public;
grant execute on function private.enqueue_email_verification(uuid,uuid,timestamptz,integer) to crm_app;

-- What the daily verification limit counts besides the day's ledger: the checks that are
-- reserved or waiting to be made. Few rows of a business are either, so this stays small.
create index email_verifications_pending_idx on messaging.email_verifications (business_id)
  where provider_reserved_at is not null or current_check_id is not null;
