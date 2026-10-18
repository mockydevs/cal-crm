-- Platform tables: the command audit log, raw inbound webhooks, imports and report rollups.

create schema audit;
create schema intake;
create schema imports;
create schema reporting;

-- Every command attempt, including denied and invalid ones (events only record what
-- succeeded). Append-only; partitioned by month.
create table audit.commands (
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  business_id uuid,
  id uuid not null default uuidv7(),
  recorded_at timestamptz not null default now(),
  command text not null constraint commands_command_format check (command ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  actor_kind text not null constraint commands_actor_kind_valid
    check (actor_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  actor_id uuid,
  ip inet,
  user_agent text,
  outcome text not null constraint commands_outcome_valid check (outcome in ('ok', 'denied', 'invalid', 'failed')),
  error_code text,
  input jsonb not null default '{}' constraint commands_input_object check (jsonb_typeof(input) = 'object'),  -- redacted
  event_ids uuid[] not null default '{}',
  correlation_id uuid not null,
  primary key (id, recorded_at),
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id) on delete cascade
) partition by range (recorded_at);
create index commands_scope_recorded_idx on audit.commands (agency_id, business_id, recorded_at desc);
create index commands_actor_idx on audit.commands (actor_id, recorded_at desc);

do $$ begin perform util.ensure_monthly_partitions('audit.commands', 1, 3); end $$;

-- Raw provider webhooks, stored before anything else happens so they can be replayed
-- after a bug fix. Written before the business is known, so this table has no
-- row-level security; only the intake module reads it, and rows expire after 30 days.
create table intake.webhooks (
  id uuid primary key default uuidv7(),
  provider text not null constraint webhooks_provider_format check (provider ~ '^[a-z][a-z0-9_]*$'),
  endpoint text not null,
  received_at timestamptz not null default now(),
  headers jsonb not null constraint webhooks_headers_object check (jsonb_typeof(headers) = 'object'),
  body bytea not null,
  signature_valid boolean not null,
  business_id uuid references tenancy.businesses (id) on delete cascade,  -- set once resolved
  processed_at timestamptz,
  error text
);
create index webhooks_received_idx on intake.webhooks (received_at);
create index webhooks_business_idx on intake.webhooks (business_id);

create table imports.jobs (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  source text not null constraint jobs_source_valid check (source in ('ghl', 'csv')),
  status text not null default 'pending' constraint jobs_status_valid
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  settings jsonb not null default '{}' constraint jobs_settings_object check (jsonb_typeof(settings) = 'object'),
  stats jsonb not null default '{}' constraint jobs_stats_object check (jsonb_typeof(stats) = 'object'),
  error text,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  primary key (business_id, id)
);

-- Source ids mapped to ours, so re-running an import updates instead of duplicating.
create table imports.id_map (
  business_id uuid not null,
  source text not null,
  source_type text not null constraint id_map_source_type_format check (source_type ~ '^[a-z][a-z_]*$'),
  source_id text not null,
  target_kind text not null constraint id_map_target_kind_format check (target_kind ~ '^[a-z][a-z_]*$'),
  target_id uuid not null,
  job_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (business_id, source, source_type, source_id),
  foreign key (business_id, job_id) references imports.jobs (business_id, id) on delete cascade
);
create index id_map_job_idx on imports.id_map (business_id, job_id);

-- Daily rollups that reports read instead of scanning transactional tables.
create table reporting.daily_metrics (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  metric text not null constraint daily_metrics_metric_format check (metric ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
  dimension text not null default '',
  day date not null,
  value numeric not null,
  updated_at timestamptz not null default now(),
  primary key (business_id, metric, dimension, day)
);

call util.add_updated_at_trigger('reporting.daily_metrics');

call util.enable_scoped_rls('audit.commands');
call util.enable_tenant_rls('imports.jobs');
call util.enable_tenant_rls('imports.id_map');
call util.enable_tenant_rls('reporting.daily_metrics');
