-- Browser calling needs a Standard API key on the business's Twilio account: Twilio does
-- not take access tokens signed by a Restricted key, and the key given for texts may be one.
-- One row per connection says how far setting it up got. The key's secret is shown once, so
-- the worker marks a row creating and commits before it asks Twilio; a run that finds a row
-- still creating, or gets no answer, records unknown and never asks again by itself.
create table messaging.voice_setups (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  connection_id uuid not null,
  status text not null default 'requested' constraint voice_setups_status_valid
    check (status in ('requested', 'creating', 'ready', 'failed', 'unknown')),
  -- The API key's SID, once Twilio created it; its secret is in the vault.
  key_sid text constraint voice_setups_key_sid_format check (key_sid ~ '^SK[0-9a-fA-F]{32}$'),
  secret_id uuid,
  failure_code text constraint voice_setups_failure_valid
    check (failure_code in ('credentials_unreadable', 'connection_unavailable', 'provider_rejected')),
  -- Twilio's own error code, when it refused and gave one.
  provider_error_code integer,
  requested_by uuid references auth.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (business_id, connection_id),
  constraint voice_setups_connection foreign key (business_id, connection_id)
    references messaging.provider_connections (business_id, id) on delete cascade,
  foreign key (business_id, secret_id) references vault.secrets (business_id, id),
  constraint voice_setups_state_consistent check (
    (status in ('requested', 'creating') and key_sid is null and secret_id is null
      and failure_code is null and provider_error_code is null and finished_at is null)
    or (status = 'ready' and key_sid is not null and secret_id is not null
      and failure_code is null and provider_error_code is null and finished_at is not null)
    or (status = 'failed' and key_sid is null and secret_id is null
      and failure_code is not null and finished_at is not null)
    or (status = 'unknown' and key_sid is null and secret_id is null
      and failure_code is null and provider_error_code is null and finished_at is not null)
  ),
  constraint voice_setups_error_code_needs_refusal
    check (provider_error_code is null or failure_code = 'provider_rejected')
);
create index voice_setups_secret_idx on messaging.voice_setups (business_id, secret_id)
  where secret_id is not null;
create index voice_setups_requested_by_idx on messaging.voice_setups (requested_by)
  where requested_by is not null;
call util.add_updated_at_trigger('messaging.voice_setups');
call util.enable_tenant_rls('messaging.voice_setups');
grant select, insert, update on messaging.voice_setups to crm_app;
