-- The event log. Every command writes its change, one or more events and the jobs for
-- each consumer in a single transaction (docs/ARCHITECTURE.md section 5.3).
-- Automations, webhooks, reports, AI memory and the "Why?" panel all read from here.
--
-- Append-only: the application can insert and read, never update or delete. Nothing
-- holds a foreign key to an event, so whole months can be archived or dropped.

create schema events;

create table events.events (
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  business_id uuid,  -- NULL for agency-level events
  id uuid not null default uuidv7(),
  -- recorded_at is when we stored it (partition key, always "now"); occurred_at is
  -- when it happened in the business, which an import can set to the past.
  recorded_at timestamptz not null default now(),
  occurred_at timestamptz not null default now(),
  type text not null constraint events_type_format check (type ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  version smallint not null default 1 constraint events_version_positive check (version > 0),
  actor_kind text not null constraint events_actor_kind_valid
    check (actor_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  actor_id uuid,
  causation_id uuid,           -- the event that caused this one
  correlation_id uuid not null, -- shared by every event from one originating request
  subject_kind text not null constraint events_subject_kind_format check (subject_kind ~ '^[a-z][a-z_]*$'),
  subject_id uuid not null,
  payload jsonb not null default '{}' constraint events_payload_object check (jsonb_typeof(payload) = 'object'),
  primary key (id, recorded_at),
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id) on delete cascade
) partition by range (recorded_at);

create index events_scope_recorded_idx on events.events (agency_id, business_id, recorded_at desc);
create index events_subject_idx on events.events (subject_id, recorded_at desc);
create index events_correlation_idx on events.events (correlation_id);

call util.enable_scoped_rls('events.events');

do $$ begin perform util.ensure_monthly_partitions('events.events', 1, 3); end $$;
