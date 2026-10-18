-- Why an automation did not start (tasks/workflow-competitor-research.md, item 5; the fact
-- base of tasks/assistant-design.md section 3a). When an event a published automation
-- listens for is matched and the automation does not enrol the record, the match job keeps
-- one short-lived row saying why: which trigger, which reason, and the plain values that
-- were compared. An enrolment that did start needs none: the run is the record of it.
--
-- Rows are written in the transaction that matches the event, so a match that rolls back
-- keeps nothing. They are kept 30 days (private.expire_trigger_evaluations, called by the
-- worker's daily purge) and go with the automation and with the record: the values compared
-- are the contact's own, so a purged contact leaves none behind.

create table automation.trigger_evaluations (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  automation_id uuid not null,
  -- The trigger of the published version that was judged, by its id in the document.
  trigger_id text constraint trigger_evaluations_trigger_id_length
    check (length(trigger_id) between 1 and 64),
  -- The record the automation did not start for. Null when the event was about no record.
  record_id uuid,
  event_id uuid not null,
  event_type text not null constraint trigger_evaluations_event_type_length
    check (length(event_type) between 1 and 120),
  reason text not null constraint trigger_evaluations_reason_valid check (reason in (
    'filter_mismatch', 'condition_false', 'already_enrolled', 'reentry_not_allowed',
    'paused', 'contact_missing', 'stopped_by_rule', 'refused_loop')),
  -- What was compared, in plain values: the filter with what it wanted and what the event
  -- had, or the values the trigger's condition read.
  detail jsonb not null default '{}' constraint trigger_evaluations_detail_object
    check (jsonb_typeof(detail) = 'object'),
  evaluated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint trigger_evaluations_automation_owner foreign key (business_id, automation_id)
    references automation.automations (business_id, id) on delete cascade,
  constraint trigger_evaluations_record_owner foreign key (business_id, record_id)
    references crm.records (business_id, id) on delete cascade
);
-- One row per event, automation, trigger and record: a match job that runs twice for an
-- event writes its findings once.
create unique index trigger_evaluations_once_idx on automation.trigger_evaluations
  (business_id, automation_id, event_id, record_id, trigger_id) nulls not distinct;
-- An automation's evaluations, newest first; and a record's, for "why not for this contact".
create index trigger_evaluations_automation_idx on automation.trigger_evaluations
  (business_id, automation_id, evaluated_at desc, id desc);
create index trigger_evaluations_record_idx on automation.trigger_evaluations
  (business_id, record_id, automation_id, evaluated_at desc, id desc)
  where record_id is not null;
-- The sweep's scan across businesses.
create index trigger_evaluations_age_idx on automation.trigger_evaluations (evaluated_at);

call util.enable_tenant_rls('automation.trigger_evaluations');
grant select, insert, delete on automation.trigger_evaluations to crm_app;

-- Removes evaluations older than p_days, in every business, a bounded number at a time.
create function private.expire_trigger_evaluations(p_days integer default 30, p_limit integer default 5000)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  with due as (
    select e.business_id, e.id from automation.trigger_evaluations e
    where e.evaluated_at < now() - make_interval(days => greatest(p_days, 1))
    order by e.evaluated_at
    limit least(greatest(p_limit, 1), 50000)
    for update skip locked
  )
  delete from automation.trigger_evaluations e using due
  where e.business_id = due.business_id and e.id = due.id;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;
revoke execute on function private.expire_trigger_evaluations(integer, integer) from public;
grant execute on function private.expire_trigger_evaluations(integer, integer) to crm_app;
