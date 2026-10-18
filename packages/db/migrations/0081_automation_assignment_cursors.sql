-- Whose turn it is (owner.assign with several users): a step that shares contacts between
-- team members gives each contact to the member after the one the last contact went to.
-- The turn is one row per automation and step, not per published version, so publishing
-- again keeps it. The step locks its row for update in its own transaction, so two contacts
-- enrolled at the same moment, on any number of workers, take different members; a step
-- that fails rolls its turn back with everything else it did.

create table automation.assignment_cursors (
  business_id uuid not null,
  automation_id uuid not null,
  step_key text not null constraint assignment_cursors_step_key_length
    check (length(step_key) between 1 and 64),
  -- The place in the step's list the next contact goes to, counted from 0. It is read
  -- modulo the list's length, so a list that was shortened still has a next member.
  next_position integer not null default 0 constraint assignment_cursors_position_nonnegative
    check (next_position >= 0),
  updated_at timestamptz not null default now(),
  primary key (business_id, automation_id, step_key),
  constraint assignment_cursors_automation_owner foreign key (business_id, automation_id)
    references automation.automations (business_id, id) on delete cascade
);
call util.add_updated_at_trigger('automation.assignment_cursors');
call util.enable_tenant_rls('automation.assignment_cursors');
grant select, insert, delete on automation.assignment_cursors to crm_app;
grant update (next_position) on automation.assignment_cursors to crm_app;
