-- Triggers the clock fires (tasks/automation-date-triggers-design.md): a date trigger has no
-- event to hear, so the worker's minute sweep asks which dates came round since it last
-- looked. The cursor is that "last looked", one per trigger of an automation. Each contact
-- is enrolled in a transaction of its own, so the cursor alone cannot say what a sweep that
-- died half way had done: the firings are that record, one per contact and occurrence.

create table automation.trigger_cursors (
  business_id uuid not null,
  automation_id uuid not null,
  trigger_id text not null constraint trigger_cursors_trigger_id_length
    check (length(trigger_id) between 1 and 64),
  swept_through timestamptz not null,
  primary key (business_id, automation_id, trigger_id),
  constraint trigger_cursors_automation_owner foreign key (business_id, automation_id)
    references automation.automations (business_id, id) on delete cascade
);
call util.enable_tenant_rls('automation.trigger_cursors');
grant select, insert, delete on automation.trigger_cursors to crm_app;
grant update (swept_through) on automation.trigger_cursors to crm_app;

-- A date that came round for a contact, by a trigger: written with the enrolment it led to,
-- or alone when the contact was not enrolled (already in the automation, or the trigger's
-- condition did not hold). A second sweep of the same stretch finds it and does nothing, and
-- so does a date edited away and back. occurrence is the date on the contact's calendar.
create table automation.trigger_firings (
  business_id uuid not null,
  automation_id uuid not null,
  trigger_id text not null constraint trigger_firings_trigger_id_length
    check (length(trigger_id) between 1 and 64),
  record_id uuid not null,
  occurrence date not null,
  fired_at timestamptz not null default now(),
  primary key (business_id, automation_id, trigger_id, record_id, occurrence),
  constraint trigger_firings_automation_owner foreign key (business_id, automation_id)
    references automation.automations (business_id, id) on delete cascade
);
call util.enable_tenant_rls('automation.trigger_firings');
grant select, insert, delete on automation.trigger_firings to crm_app;

-- The sweep lists timer subscriptions across businesses; the event index leads with the
-- business, which that list does not have.
create index trigger_subscriptions_timer_idx
  on automation.trigger_subscriptions (automation_id)
  where event_type = 'date.reached';

-- Automations whose published version has a date trigger, with their agency so each is swept
-- in its own tenant context. A paused one is listed too: its cursor moves on while nothing
-- fires, so resuming it starts from then rather than catching up. Identifiers only, in id
-- order, a page at a time after p_after.
create function private.automations_with_timers(p_after uuid, p_limit integer)
returns table (agency_id uuid, business_id uuid, automation_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, a.business_id, a.id
  from automation.automations a
  join tenancy.businesses b on b.id = a.business_id
  where a.status in ('active', 'paused') and b.status = 'active'
    and (p_after is null or a.id > p_after)
    and exists (
      select 1 from automation.trigger_subscriptions s
      where s.automation_id = a.id and s.business_id = a.business_id
        and s.version_id = a.published_version_id and s.event_type = 'date.reached'
    )
  order by a.id
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function private.automations_with_timers(uuid, integer) from public;
grant execute on function private.automations_with_timers(uuid, integer) to crm_app;
