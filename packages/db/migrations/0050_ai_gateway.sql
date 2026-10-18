-- The AI gateway (plan P1.60, ADR-055): what 0010's tables need before a
-- model is ever called.
--
-- 0010 made ai.requests a ledger of finished calls. The gateway writes the row before it
-- calls the provider, so that a call is on record even when the worker dies mid-call, and
-- so that the spending limit can count calls still in flight. That needs:
--   * a 'started' status, with the money held for the call (reserved_estimate) and the
--     time the hold lapses by itself (reserved_until), so a dead worker cannot hold a
--     business's budget for ever;
--   * a cost that can be unknown. NULL means no price was known for the model: an unknown
--     cost is never recorded as zero;
--   * usage_reported, because a model server of the install's own may answer without a
--     usage object. Its token columns are then zero and mean "not reported";
--   * call_id and attempt, which tie the retries and the backup model's call to the one
--     piece of work they were all made for;
--   * prompt_version, the version of the prompt the job sent.
--
-- No install has called a model before this migration: the only rows are hand-written
-- ones, which are given the end time the new rule asks of a finished call.
update ai.requests set finished_at = started_at where finished_at is null;

alter table ai.requests
  drop constraint requests_status_valid,
  add constraint requests_status_valid
    check (status in ('started', 'ok', 'error', 'refused', 'fell_back')),
  alter column cost_estimate drop not null,
  alter column cost_estimate drop default,
  add column call_id uuid not null default uuidv7(),
  add column attempt integer not null default 1
    constraint requests_attempt_positive check (attempt >= 1),
  add column prompt_version text
    constraint requests_prompt_version_length check (length(prompt_version) between 1 and 100),
  add column usage_reported boolean not null default true,
  add column reserved_estimate numeric(19, 6) not null default 0
    constraint requests_reserved_nonnegative check (reserved_estimate >= 0),
  add column reserved_until timestamptz,
  add constraint requests_started_is_unfinished check ((status = 'started') = (finished_at is null)),
  add constraint requests_started_has_hold_end check (status <> 'started' or reserved_until is not null),
  add constraint requests_hold_only_in_flight
    check (status = 'started' or (reserved_until is null and reserved_estimate = 0)),
  add constraint requests_unreported_usage_is_zero check (
    usage_reported
    or (input_tokens = 0 and output_tokens = 0 and cache_read_tokens = 0 and cache_write_tokens = 0)
  );

comment on column ai.requests.cost_estimate is
  'US dollars. NULL: no price was known for the model, so the cost is unknown, not zero.';
comment on column ai.requests.reserved_estimate is
  'US dollars held against the monthly limit while the call is in flight.';

-- The calls of one business still in flight: what admission adds to the month's spend.
create index requests_in_flight_idx on ai.requests (business_id) where status = 'started';
create index requests_call_idx on ai.requests (business_id, call_id);

-- When the limit was last reached, so the owner is told once in a month and the spending
-- card can say so.
alter table ai.settings add column limit_reached_at timestamptz;

comment on column ai.settings.monthly_limit is 'US dollars in a calendar month (UTC).';

-- Only a model server of the install's own has an address. A key for a hosted provider
-- goes to that provider's fixed address and nowhere else, whatever a row says. No release
-- ever read a hosted provider's address from its row, so one that was written is dropped.
update ai.provider_keys set base_url = null
where provider <> 'openai_compatible' and base_url is not null;

alter table ai.provider_keys
  add constraint provider_keys_only_compatible_has_url
    check (provider = 'openai_compatible' or base_url is null);

-- Prices the install has entered or corrected, per model: US dollars for a million tokens.
-- They override the prices shipped with the adapters. Every price says where it came from
-- and when it was checked, because a cost shown in the product is only as good as that.
create table ai.model_prices (
  id uuid primary key default uuidv7(),
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  provider text not null constraint model_prices_provider_valid
    check (provider in ('anthropic', 'openai', 'gemini', 'openai_compatible')),
  model text not null constraint model_prices_model_length check (length(model) between 1 and 200),
  input_per_mtok numeric(19, 6) not null constraint model_prices_input_nonnegative check (input_per_mtok >= 0),
  output_per_mtok numeric(19, 6) not null constraint model_prices_output_nonnegative check (output_per_mtok >= 0),
  cache_read_per_mtok numeric(19, 6) not null constraint model_prices_cache_read_nonnegative check (cache_read_per_mtok >= 0),
  cache_write_per_mtok numeric(19, 6) not null constraint model_prices_cache_write_nonnegative check (cache_write_per_mtok >= 0),
  source text not null constraint model_prices_source_length check (length(btrim(source)) between 1 and 500),
  checked_on date not null,
  updated_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint model_prices_model_unique unique (agency_id, provider, model)
);

call util.add_updated_at_trigger('ai.model_prices');
call util.enable_agency_rls('ai.model_prices');

grant select, insert, update, delete on ai.model_prices to crm_app;
