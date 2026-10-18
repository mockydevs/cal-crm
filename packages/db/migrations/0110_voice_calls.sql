-- Call records (ADR-110, Phone System stage PS2): every call the business makes or takes,
-- each provider call ("leg") inside it, and every progress report a leg received. The
-- ledger is written before any paid provider request, so a request whose answer was lost
-- stays an unknown call, never a second one. Nothing here places a call: the worker's
-- provider port does, after reserving the call here. A request is never a connected call;
-- only a provider report that the other party answered makes it one.

-- A call cannot point at another business's connection, even through a direct app-role
-- write. Existing SMS connection rows stay as they are; only calls require this pair.
alter table messaging.provider_connections
  add constraint provider_connections_business_id_unique unique (business_id, id);

-- 1. Calls: one row each, scoped to the business, bound to its number, the connection the
--    number belongs to, the contact and phone identity called, and the member on our side.
create table messaging.calls (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  direction text not null constraint calls_direction_valid check (direction in ('outbound', 'inbound')),
  -- The business's number. Unregistering it keeps the call, with the number it used.
  phone_number_id uuid,
  provider_connection_id uuid not null,
  local_e164 text not null constraint calls_local_e164_format check (local_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- The other party's number; null for a caller who withheld theirs.
  remote_e164 text constraint calls_remote_e164_format check (remote_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  contact_id uuid,
  contact_identity_id uuid,
  -- The member on our side: who asked for an outbound call, or who took an inbound one.
  user_id uuid references auth.users (id) on delete set null,
  requested_by_kind text not null constraint calls_requested_by_kind_valid
    check (requested_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact')),
  requested_by_id uuid,
  -- requested: accepted by the API, nothing sent. reserved: the worker is asking the
  -- provider. unknown: the provider's answer was lost; never retried automatically.
  -- dialing/ringing: the provider has the call; connected: the other party answered.
  -- ended carries an outcome. refused (our checks), rejected (the provider created
  -- nothing) and canceled (before anything was sent) end a call that never rang.
  state text not null default 'requested' constraint calls_state_valid check (state in (
    'requested', 'reserved', 'unknown', 'dialing', 'ringing', 'connected', 'ended',
    'refused', 'rejected', 'canceled')),
  outcome text constraint calls_outcome_valid
    check (outcome in ('completed', 'busy', 'no_answer', 'failed', 'canceled')),
  failure_code text constraint calls_failure_code_valid check (failure_code in (
    'contact_unavailable', 'do_not_call', 'call_consent_withdrawn', 'number_unavailable',
    'connection_unavailable', 'member_unavailable', 'provider_rejected')),
  provider_error_code integer constraint calls_provider_error_code_positive check (provider_error_code > 0),
  -- A retried request with the same key answers the first call (outbound only).
  idempotency_key text constraint calls_idempotency_key_format check (idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  request_hash text constraint calls_request_hash_format check (request_hash ~ '^[0-9a-f]{64}$'),
  -- A progress report contradicted what was recorded; someone must look at the provider.
  needs_reconciliation boolean not null default false,
  hangup_requested_at timestamptz,
  hangup_requested_by uuid references auth.users (id) on delete set null,
  hangup_result text constraint calls_hangup_result_valid
    check (hangup_result in ('accepted', 'rejected', 'unknown', 'not_needed')),
  reserved_at timestamptz,
  connected_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint calls_business_connection foreign key (business_id, provider_connection_id)
    references messaging.provider_connections (business_id, id),
  constraint calls_phone_number foreign key (business_id, phone_number_id)
    references messaging.phone_numbers (business_id, id) on delete set null (phone_number_id),
  constraint calls_contact foreign key (business_id, contact_id)
    references crm.contacts (business_id, id) on delete set null (contact_id),
  constraint calls_contact_identity foreign key (business_id, contact_identity_id)
    references crm.contact_identities (business_id, id) on delete set null (contact_identity_id),
  constraint calls_idempotency_pair check ((idempotency_key is null) = (request_hash is null)),
  constraint calls_outbound_requested check (
    direction = 'inbound' or (remote_e164 is not null and idempotency_key is not null)),
  -- An outbound call is reserved before the provider is asked; an inbound one never is.
  constraint calls_reserved_consistent check (
    (direction = 'inbound' and reserved_at is null and state not in ('requested', 'reserved'))
    or (state = 'requested' and reserved_at is null)
    or state in ('refused', 'canceled')
    or (direction = 'outbound' and reserved_at is not null
      and state in ('reserved', 'unknown', 'dialing', 'ringing', 'connected', 'ended', 'rejected'))),
  constraint calls_end_consistent check (
    (state in ('ended', 'refused', 'rejected', 'canceled')) = (ended_at is not null)),
  constraint calls_outcome_consistent check ((state = 'ended') = (outcome is not null)),
  constraint calls_failure_consistent check ((state in ('refused', 'rejected')) = (failure_code is not null)),
  constraint calls_connected_consistent check (connected_at is null or state in ('connected', 'ended')),
  constraint calls_hangup_consistent check (hangup_result is null or hangup_requested_at is not null)
);
create unique index calls_idempotency_unique on messaging.calls (business_id, idempotency_key)
  where idempotency_key is not null;
create index calls_contact_idx on messaging.calls (business_id, contact_id, id) where contact_id is not null;
create index calls_contact_identity_idx on messaging.calls (business_id, contact_identity_id)
  where contact_identity_id is not null;
create index calls_phone_number_idx on messaging.calls (business_id, phone_number_id)
  where phone_number_id is not null;
create index calls_connection_idx on messaging.calls (business_id, provider_connection_id);
create index calls_user_idx on messaging.calls (user_id) where user_id is not null;
create index calls_hangup_user_idx on messaging.calls (hangup_requested_by) where hangup_requested_by is not null;
call util.add_updated_at_trigger('messaging.calls');
call util.enable_tenant_rls('messaging.calls');
grant select, insert, update on messaging.calls to crm_app;

comment on table messaging.calls is
  'Calls the business made or took (ADR-110). A request is not a call that connected; only a provider report is.';

-- 2. Legs: each provider call inside a call. The first leg is the one the provider was
--    asked for (or that called in); legs a <Dial> adds name it as their parent. The
--    provider's id is unique within the connection, which belongs to one business, so a
--    retried report finds the same leg and another tenant's never can.
create table messaging.call_legs (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  call_id uuid not null,
  parent_leg_id uuid,
  -- Who the leg reaches: the other party, or a member of the business.
  party text not null constraint call_legs_party_valid check (party in ('remote', 'member')),
  user_id uuid references auth.users (id) on delete set null,
  provider_connection_id uuid not null,
  provider_call_sid text constraint call_legs_call_sid_format check (provider_call_sid ~ '^CA[0-9a-fA-F]{32}$'),
  provider_direction text constraint call_legs_provider_direction_valid
    check (provider_direction in ('inbound', 'outbound-api', 'outbound-dial')),
  from_address text constraint call_legs_from_length check (char_length(from_address) between 1 and 512),
  to_address text constraint call_legs_to_length check (char_length(to_address) between 1 and 512),
  -- reserved and unknown are ours; the rest are the provider's own words.
  status text not null default 'reserved' constraint call_legs_status_valid check (status in (
    'reserved', 'unknown', 'rejected', 'queued', 'initiated', 'ringing', 'in-progress',
    'completed', 'busy', 'failed', 'no-answer', 'canceled')),
  -- The provider's SequenceNumber of the report the status came from.
  sequence integer constraint call_legs_sequence_range check (sequence >= 0),
  duration_seconds integer constraint call_legs_duration_range check (duration_seconds >= 0),
  conflict_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, call_id) references messaging.calls (business_id, id) on delete cascade,
  foreign key (business_id, parent_leg_id) references messaging.call_legs (business_id, id) on delete cascade,
  constraint call_legs_call_sid_unique unique (provider_connection_id, provider_call_sid),
  constraint call_legs_business_connection foreign key (business_id, provider_connection_id)
    references messaging.provider_connections (business_id, id),
  constraint call_legs_end_consistent check (
    (status in ('rejected', 'completed', 'busy', 'failed', 'no-answer', 'canceled')) = (ended_at is not null))
);
create unique index call_legs_one_root on messaging.call_legs (business_id, call_id) where parent_leg_id is null;
create index call_legs_call_idx on messaging.call_legs (business_id, call_id, id);
create index call_legs_parent_idx on messaging.call_legs (business_id, parent_leg_id) where parent_leg_id is not null;
create index call_legs_user_idx on messaging.call_legs (user_id) where user_id is not null;
create index call_legs_business_connection_idx on messaging.call_legs (business_id, provider_connection_id);
call util.add_updated_at_trigger('messaging.call_legs');
call util.enable_tenant_rls('messaging.call_legs');
grant select, insert, update on messaging.call_legs to crm_app;

comment on table messaging.call_legs is
  'Each provider call inside a call (ADR-110), unique by the provider''s id within its connection.';

-- 3. Progress: every report a leg received, once per SequenceNumber. A repeated report is
--    the same row; one that reuses a number with another status is a conflict.
create table messaging.call_progress (
  business_id uuid not null,
  leg_id uuid not null,
  sequence integer not null constraint call_progress_sequence_range check (sequence >= 0),
  status text not null constraint call_progress_status_valid check (status in (
    'queued', 'initiated', 'ringing', 'in-progress', 'completed', 'busy', 'failed', 'no-answer', 'canceled')),
  duration_seconds integer constraint call_progress_duration_range check (duration_seconds >= 0),
  received_at timestamptz not null default now(),
  primary key (business_id, leg_id, sequence),
  foreign key (business_id, leg_id) references messaging.call_legs (business_id, id) on delete cascade
);
call util.enable_tenant_rls('messaging.call_progress');
grant select, insert on messaging.call_progress to crm_app;

comment on table messaging.call_progress is
  'Every progress report of a call leg (ADR-110), one per provider SequenceNumber.';
