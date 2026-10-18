-- P1.50 (ADR-043): an event starts the automations it triggers. Whoever writes the event,
-- the same transaction queues one matching job for it, so nothing is lost and nothing
-- starts from a change that rolled back (ARCHITECTURE.md section 5.3). A business with no
-- active automation, and no enrolment waiting, for the event's type gets no job at all.

create index trigger_subscriptions_match_idx
  on automation.trigger_subscriptions (business_id, event_type, automation_id, version_id);

create function private.queue_automation_match() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.business_id is not null and exists (
    select 1
    from automation.trigger_subscriptions s
    join automation.automations a
      on a.business_id = s.business_id and a.id = s.automation_id
      and a.published_version_id = s.version_id
    where s.business_id = new.business_id and s.event_type = new.type and a.status = 'active'
  ) or exists (
    -- A running enrolment waits for this kind of event: a stop condition (goal) or a reply.
    select 1
    from automation.event_waits w
    where w.business_id = new.business_id and w.event_type = new.type
  ) then
    -- As private.enqueue_job's payload (0020), with the event as the job's cause. The key
    -- keeps one waiting match per event.
    perform graphile_worker.add_job(
      'automations.match_event',
      payload := jsonb_build_object(
        'agencyId', new.agency_id,
        'businessId', new.business_id,
        'correlationId', new.correlation_id,
        'causationId', new.id,
        'data', jsonb_build_object('eventId', new.id)
      )::json,
      job_key := 'automation-match:' || new.id::text,
      job_key_mode := 'preserve_run_at'
    );
  end if;
  return null;
end
$$;
revoke execute on function private.queue_automation_match() from public;

create trigger events_queue_automation_match
  after insert on events.events
  for each row execute function private.queue_automation_match();
