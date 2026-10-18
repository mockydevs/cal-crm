-- Automations: documents, published versions, trigger subscriptions, enrolments (the
-- state machine), waits, step runs and test runs. See docs/AUTOMATIONS.md
-- and docs/ARCHITECTURE.md section 6.

create schema automation;

create table automation.automations (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  name text not null constraint automations_name_length check (length(btrim(name)) between 1 and 120),
  description text not null default '',
  status text not null default 'draft' constraint automations_status_valid
    check (status in ('draft', 'active', 'paused', 'archived')),
  -- The working document. Editors send the draft_revision they started from; a stale
  -- revision is a conflict (HTTP 409), never a silent overwrite.
  draft jsonb not null constraint automations_draft_object check (jsonb_typeof(draft) = 'object'),
  draft_revision integer not null default 1 constraint automations_draft_revision_positive check (draft_revision > 0),
  published_version_id uuid,
  created_by_kind text not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  primary key (business_id, id),
  constraint automations_active_is_published check (status not in ('active', 'paused') or published_version_id is not null),
  constraint automations_archived_complete check ((status = 'archived') = (archived_at is not null))
);

-- Published versions never change; running enrolments stay on the version they began on.
create table automation.versions (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  automation_id uuid not null,
  version integer not null constraint versions_version_positive check (version > 0),
  document jsonb not null constraint versions_document_object check (jsonb_typeof(document) = 'object'),
  change_summary text not null default '',
  published_by_kind text not null,
  published_by_id uuid,
  published_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, automation_id) references automation.automations (business_id, id) on delete cascade,
  constraint versions_number_unique unique (business_id, automation_id, version)
);

alter table automation.automations
  add foreign key (business_id, published_version_id) references automation.versions (business_id, id);
create index automations_published_version_idx on automation.automations (business_id, published_version_id);

-- Which events start which automations, derived from the published version when it is
-- published, so matching an incoming event is one index lookup.
create table automation.trigger_subscriptions (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  automation_id uuid not null,
  version_id uuid not null,
  event_type text not null constraint trigger_subscriptions_event_type_format
    check (event_type ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  conditions jsonb not null default '{}' constraint trigger_subscriptions_conditions_object
    check (jsonb_typeof(conditions) = 'object'),
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, automation_id) references automation.automations (business_id, id) on delete cascade,
  foreign key (business_id, version_id) references automation.versions (business_id, id) on delete cascade
);
create index trigger_subscriptions_event_idx on automation.trigger_subscriptions (business_id, event_type);
create index trigger_subscriptions_automation_idx on automation.trigger_subscriptions (business_id, automation_id);
create index trigger_subscriptions_version_idx on automation.trigger_subscriptions (business_id, version_id);

-- One row per record going through an automation: the state machine. After any restart
-- or upgrade it simply continues from current_step.
create table automation.enrolments (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  automation_id uuid not null,
  version_id uuid not null,
  record_id uuid not null,
  status text not null default 'running' constraint enrolments_status_valid
    check (status in ('running', 'waiting', 'completed', 'exited', 'failed', 'cancelled')),
  -- The record id when the automation doesn't allow re-entry, otherwise the enrolment's
  -- own id. The unique index below then blocks a second live enrolment of the same record.
  reentry_key uuid not null,
  current_step text,
  state jsonb not null default '{}' constraint enrolments_state_object check (jsonb_typeof(state) = 'object'),
  wake_at timestamptz,
  trigger_event_id uuid,
  correlation_id uuid not null,
  exit_reason text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (business_id, id),
  foreign key (business_id, automation_id) references automation.automations (business_id, id) on delete cascade,
  foreign key (business_id, version_id) references automation.versions (business_id, id) on delete cascade,
  foreign key (business_id, record_id) references crm.records (business_id, id) on delete cascade,
  constraint enrolments_finished_complete
    check ((status in ('completed', 'exited', 'failed', 'cancelled')) = (finished_at is not null))
);
create unique index enrolments_one_live_idx on automation.enrolments (business_id, automation_id, reentry_key)
  where status in ('running', 'waiting');
-- The sweeper's scan for due waits across all businesses (private.due_enrolments).
create index enrolments_due_idx on automation.enrolments (wake_at)
  where status = 'waiting' and wake_at is not null;
create index enrolments_record_idx on automation.enrolments (business_id, record_id, started_at desc);
create index enrolments_automation_idx on automation.enrolments (business_id, automation_id, status);
create index enrolments_version_idx on automation.enrolments (business_id, version_id);

-- "Wait for a reply", goals and stop conditions: an incoming event finds the enrolments
-- waiting for it with one index lookup.
create table automation.event_waits (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  enrolment_id uuid not null,
  kind text not null constraint event_waits_kind_valid check (kind in ('reply', 'event', 'goal', 'stop')),
  event_type text not null constraint event_waits_event_type_format
    check (event_type ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  record_id uuid,
  conditions jsonb not null default '{}' constraint event_waits_conditions_object
    check (jsonb_typeof(conditions) = 'object'),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, enrolment_id) references automation.enrolments (business_id, id) on delete cascade
);
create index event_waits_match_idx on automation.event_waits (business_id, event_type, record_id);
create index event_waits_enrolment_idx on automation.event_waits (business_id, enrolment_id);

-- What each step did and why: inputs, the branch taken, the explanation shown in the
-- run history. Partitioned by month for retention.
create table automation.step_runs (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  enrolment_id uuid not null,
  step_key text not null,
  attempt smallint not null default 1 constraint step_runs_attempt_positive check (attempt > 0),
  status text not null constraint step_runs_status_valid
    check (status in ('running', 'succeeded', 'failed', 'skipped', 'waiting')),
  input jsonb not null default '{}' constraint step_runs_input_object check (jsonb_typeof(input) = 'object'),
  output jsonb not null default '{}' constraint step_runs_output_object check (jsonb_typeof(output) = 'object'),
  branch text,
  explanation text not null default '',
  error jsonb constraint step_runs_error_object check (jsonb_typeof(error) = 'object'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (id, started_at),
  foreign key (business_id, enrolment_id) references automation.enrolments (business_id, id) on delete cascade
) partition by range (started_at);
create index step_runs_enrolment_idx on automation.step_runs (business_id, enrolment_id, started_at);

do $$ begin perform util.ensure_monthly_partitions('automation.step_runs', 1, 3); end $$;

-- Dry runs from the builder: the same engine with side effects stubbed and time
-- fast-forwarded, producing a trace.
create table automation.test_runs (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  automation_id uuid not null,
  draft_revision integer not null,
  sample_record_id uuid,
  status text not null constraint test_runs_status_valid check (status in ('running', 'passed', 'failed')),
  trace jsonb not null default '[]' constraint test_runs_trace_array check (jsonb_typeof(trace) = 'array'),
  created_by_kind text not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (business_id, id),
  foreign key (business_id, automation_id) references automation.automations (business_id, id) on delete cascade,
  foreign key (business_id, sample_record_id)
    references crm.records (business_id, id) on delete set null (sample_record_id)
);
create index test_runs_automation_idx on automation.test_runs (business_id, automation_id, created_at desc);
create index test_runs_sample_record_idx on automation.test_runs (business_id, sample_record_id);

call util.add_updated_at_trigger('automation.automations');
call util.add_updated_at_trigger('automation.enrolments');

call util.enable_tenant_rls('automation.automations');
call util.enable_tenant_rls('automation.versions');
call util.enable_tenant_rls('automation.trigger_subscriptions');
call util.enable_tenant_rls('automation.enrolments');
call util.enable_tenant_rls('automation.event_waits');
call util.enable_tenant_rls('automation.step_runs');
call util.enable_tenant_rls('automation.test_runs');
