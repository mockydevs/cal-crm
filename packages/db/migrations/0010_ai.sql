-- AI: provider keys, per-business settings, a model for each job, the request log and
-- spend, proposals (drafts and approvals), autonomy rules and contact memory.
-- See docs/ARCHITECTURE.md section 8.6.

create schema ai;

-- Keys can be the agency's (shared by its businesses and rebilled) or one business's own.
create table ai.provider_keys (
  id uuid primary key default uuidv7(),
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  business_id uuid,
  provider text not null constraint provider_keys_provider_valid
    check (provider in ('anthropic', 'openai', 'gemini', 'openai_compatible')),
  label text not null default '',
  base_url text,       -- required for OpenAI-compatible servers such as Ollama
  default_model text,  -- for OpenAI-compatible servers: the model name the server lists
  secret_id uuid,      -- NULL only for a local server that needs no key
  key_last4 text constraint provider_keys_last4_format check (key_last4 ~ '^[A-Za-z0-9_-]{4}$'),
  status text not null default 'untested' constraint provider_keys_status_valid
    check (status in ('untested', 'working', 'failing')),
  last_tested_at timestamptz,
  last_test_latency_ms integer constraint provider_keys_latency_nonnegative check (last_test_latency_ms >= 0),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id) on delete cascade,
  foreign key (agency_id, secret_id) references vault.secrets (agency_id, id),
  constraint provider_keys_label_unique unique nulls not distinct (agency_id, business_id, provider, label),
  constraint provider_keys_compatible_needs_url check (provider <> 'openai_compatible' or base_url is not null),
  constraint provider_keys_hosted_needs_secret check (provider = 'openai_compatible' or secret_id is not null)
);
create index provider_keys_secret_idx on ai.provider_keys (agency_id, secret_id);

create table ai.settings (
  business_id uuid primary key references tenancy.businesses (id) on delete cascade,
  enabled boolean not null default true,
  key_source text not null default 'agency' constraint settings_key_source_valid check (key_source in ('agency', 'own')),
  monthly_limit numeric(19, 4) constraint settings_monthly_limit_nonnegative check (monthly_limit >= 0),
  at_limit text not null default 'pause' constraint settings_at_limit_valid check (at_limit in ('pause', 'continue')),
  mask_contact_details boolean not null default false,
  request_log_days integer not null default 30 constraint settings_log_days_range check (request_log_days between 0 and 365),
  backup_provider text,
  backup_model text,
  updated_at timestamptz not null default now(),
  constraint settings_backup_complete check ((backup_provider is null) = (backup_model is null))
);

create table ai.job_models (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  job text not null constraint job_models_job_valid
    check (job in ('automation_builder', 'replies', 'briefings', 'sorting', 'search')),
  provider text not null constraint job_models_provider_valid
    check (provider in ('anthropic', 'openai', 'gemini', 'openai_compatible', 'builtin')),
  model text not null constraint job_models_model_length check (length(model) between 1 and 200),
  updated_by_id uuid,
  updated_at timestamptz not null default now(),
  primary key (business_id, job)
);

-- One row per model call: the source for spend, limits and rebilling. log holds the
-- redacted request and response for request_log_days, then a cleanup job clears it.
create table ai.requests (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  job text not null,
  provider text not null,
  model text not null,
  key_source text not null constraint requests_key_source_valid check (key_source in ('agency', 'own')),
  status text not null constraint requests_status_valid check (status in ('ok', 'error', 'refused', 'fell_back')),
  input_tokens integer not null default 0 constraint requests_input_tokens_nonnegative check (input_tokens >= 0),
  output_tokens integer not null default 0 constraint requests_output_tokens_nonnegative check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 constraint requests_cache_read_nonnegative check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 constraint requests_cache_write_nonnegative check (cache_write_tokens >= 0),
  cost_estimate numeric(19, 6) not null default 0 constraint requests_cost_nonnegative check (cost_estimate >= 0),
  latency_ms integer constraint requests_latency_nonnegative check (latency_ms >= 0),
  actor_kind text not null,
  actor_id uuid,
  correlation_id uuid,
  error_code text,
  log jsonb constraint requests_log_object check (jsonb_typeof(log) = 'object'),
  log_expires_at timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (business_id, id),
  constraint requests_log_has_expiry check (log is null or log_expires_at is not null)
);
create index requests_spend_idx on ai.requests (business_id, started_at) include (cost_estimate);
create index requests_log_expiry_idx on ai.requests (log_expires_at) where log is not null;

-- Everything the assistant wants to do but a person decides: reply drafts, field
-- updates, merges, automation changes. command is exactly what runs on Apply.
create table ai.proposals (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  agent text not null constraint proposals_agent_valid
    check (agent in ('inbox', 'copilot', 'automation_author', 'analyst', 'cleanup')),
  kind text not null constraint proposals_kind_format check (kind ~ '^[a-z][a-z_]*$'),
  record_id uuid,
  conversation_id uuid,
  automation_id uuid,
  summary text not null constraint proposals_summary_length check (length(btrim(summary)) between 1 and 500),
  command jsonb not null constraint proposals_command_object check (jsonb_typeof(command) = 'object'),
  before jsonb,
  after jsonb,
  status text not null default 'pending' constraint proposals_status_valid
    check (status in ('pending', 'applied', 'dismissed', 'expired', 'undone')),
  autonomy text not null constraint proposals_autonomy_valid check (autonomy in ('suggest', 'ask', 'act')),
  request_id uuid,
  decided_by_kind text,
  decided_by_id uuid,
  decided_at timestamptz,
  applied_event_id uuid,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, record_id) references crm.records (business_id, id) on delete cascade,
  foreign key (business_id, conversation_id) references messaging.conversations (business_id, id) on delete cascade,
  foreign key (business_id, automation_id) references automation.automations (business_id, id) on delete cascade,
  foreign key (business_id, request_id) references ai.requests (business_id, id) on delete set null (request_id),
  constraint proposals_one_subject check (num_nonnulls(record_id, conversation_id, automation_id) <= 1),
  constraint proposals_decision_complete check ((status = 'pending') = (decided_at is null))
);
create index proposals_queue_idx on ai.proposals (business_id, status, created_at desc);
create index proposals_record_idx on ai.proposals (business_id, record_id);
create index proposals_conversation_idx on ai.proposals (business_id, conversation_id);
create index proposals_automation_idx on ai.proposals (business_id, automation_id);
create index proposals_request_idx on ai.proposals (business_id, request_id);

alter table messaging.messages
  add foreign key (business_id, proposal_id) references ai.proposals (business_id, id) on delete set null (proposal_id);
create index messages_proposal_idx on messaging.messages (business_id, proposal_id);

-- Suggest, ask first or act: per agent and action, for the business or one contact.
create table ai.autonomy_rules (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  agent text not null constraint autonomy_rules_agent_valid
    check (agent in ('inbox', 'copilot', 'automation_author', 'analyst', 'cleanup')),
  action text not null constraint autonomy_rules_action_format check (action ~ '^[a-z][a-z_]*$'),
  contact_id uuid,  -- NULL: the business default
  level text not null constraint autonomy_rules_level_valid check (level in ('suggest', 'ask', 'act')),
  updated_by_id uuid,
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade,
  constraint autonomy_rules_unique unique nulls not distinct (business_id, agent, action, contact_id)
);
create index autonomy_rules_contact_idx on ai.autonomy_rules (business_id, contact_id);

-- What the assistant knows about a contact. Each fact keeps the events it came from and
-- can be confirmed, rejected or replaced by a newer fact.
create table ai.contact_facts (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  contact_id uuid not null,
  statement text not null constraint contact_facts_statement_length check (length(btrim(statement)) between 1 and 1000),
  field_id uuid,  -- set when the fact fills a field
  status text not null default 'proposed' constraint contact_facts_status_valid
    check (status in ('proposed', 'confirmed', 'rejected', 'superseded')),
  confidence real constraint contact_facts_confidence_range check (confidence between 0 and 1),
  source_event_ids uuid[] not null default '{}',
  superseded_by_id uuid,
  confirmed_by_id uuid,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade,
  foreign key (business_id, field_id) references crm.field_definitions (business_id, id) on delete set null (field_id),
  foreign key (business_id, superseded_by_id) references ai.contact_facts (business_id, id) on delete set null (superseded_by_id),
  constraint contact_facts_superseded_status check (superseded_by_id is null or status = 'superseded'),
  constraint contact_facts_confirmation_complete check ((confirmed_at is null) = (confirmed_by_id is null))
);
create index contact_facts_contact_idx on ai.contact_facts (business_id, contact_id, status);
create index contact_facts_field_idx on ai.contact_facts (business_id, field_id);
create index contact_facts_superseded_by_idx on ai.contact_facts (business_id, superseded_by_id);

create table ai.contact_summaries (
  business_id uuid not null,
  contact_id uuid not null,
  summary text not null,
  model text not null,
  through_event_id uuid,  -- the latest event the summary covers
  updated_at timestamptz not null default now(),
  primary key (business_id, contact_id),
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade
);

call util.add_updated_at_trigger('ai.provider_keys');
call util.add_updated_at_trigger('ai.settings');
call util.add_updated_at_trigger('ai.job_models');
call util.add_updated_at_trigger('ai.autonomy_rules');
call util.add_updated_at_trigger('ai.contact_facts');
call util.add_updated_at_trigger('ai.contact_summaries');

call util.enable_scoped_rls('ai.provider_keys');
call util.enable_tenant_rls('ai.settings');
call util.enable_tenant_rls('ai.job_models');
call util.enable_tenant_rls('ai.requests');
call util.enable_tenant_rls('ai.proposals');
call util.enable_tenant_rls('ai.autonomy_rules');
call util.enable_tenant_rls('ai.contact_facts');
call util.enable_tenant_rls('ai.contact_summaries');
