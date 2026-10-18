-- Settings → AI models (plan P1.63, ADR-058): what "Test" needs.
--
-- A test is asked for in the app and made by the worker, which alone can open a key
-- (ADR-019). So a test is a row: pending until the worker has made its one request, then
-- finished with what happened. In a business a test asks the model for one short answer,
-- and that call is in ai.requests like any other. At the agency, where no call can be put
-- on a business's account, a test only asks the provider whether it accepts the key.

-- Every way a test can end is in both checks below. The first ten are what the provider
-- said (ai/src/provider.ts); the rest are reasons the gateway did not ask it.

-- No release ever tested a key, so a row that says otherwise was written by hand.
update ai.provider_keys
set status = 'untested', last_tested_at = null, last_test_latency_ms = null
where status <> 'untested' or last_tested_at is not null;

-- What the last test that reached the provider found, beside the status and the time the
-- row already keeps.
alter table ai.provider_keys
  add column last_test_outcome text
    constraint provider_keys_last_test_outcome_valid check (last_test_outcome in (
      'ok', 'authentication', 'billing', 'rate_limited', 'unavailable', 'timeout',
      'invalid_request', 'invalid_response', 'blocked_address', 'not_found',
      'limit_reached', 'price_unknown', 'ai_off', 'key_unreadable', 'not_supported',
      'no_model', 'expired'
    )),
  add constraint provider_keys_tested_together
    check ((last_tested_at is null) = (last_test_outcome is null)),
  add constraint provider_keys_untested_has_no_result
    check ((status = 'untested') = (last_tested_at is null)),
  add constraint provider_keys_model_length
    check (default_model is null or length(default_model) between 1 and 200),
  add constraint provider_keys_base_url_length
    check (base_url is null or length(base_url) between 1 and 2000);

create table ai.connection_tests (
  id uuid primary key default uuidv7(),
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  business_id uuid,  -- NULL: asked at the agency, where no model is called
  connection_id uuid not null references ai.provider_keys (id) on delete cascade,
  status text not null default 'pending' constraint connection_tests_status_valid
    check (status in ('pending', 'finished')),
  outcome text constraint connection_tests_outcome_valid
    check (outcome in (
      'ok', 'authentication', 'billing', 'rate_limited', 'unavailable', 'timeout',
      'invalid_request', 'invalid_response', 'blocked_address', 'not_found',
      'limit_reached', 'price_unknown', 'ai_off', 'key_unreadable', 'not_supported',
      'no_model', 'expired'
    )),
  latency_ms integer constraint connection_tests_latency_nonnegative check (latency_ms >= 0),
  request_id uuid,  -- the call in ai.requests, when a model was called
  requested_by_id uuid,
  created_at timestamptz not null default now(),
  -- A test nobody ran by then is shown as expired: the worker is not running.
  expires_at timestamptz not null default now() + interval '2 minutes',
  finished_at timestamptz,
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id) on delete cascade,
  foreign key (business_id, request_id) references ai.requests (business_id, id) on delete set null (request_id),
  constraint connection_tests_finished_together
    check ((status = 'pending') = (finished_at is null) and (status = 'pending') = (outcome is null)),
  constraint connection_tests_call_needs_business check (request_id is null or business_id is not null)
);
create index connection_tests_connection_idx on ai.connection_tests (connection_id, created_at desc);
create index connection_tests_business_idx on ai.connection_tests (agency_id, business_id);
create index connection_tests_request_idx on ai.connection_tests (business_id, request_id);

call util.enable_scoped_rls('ai.connection_tests');

grant select, insert, update, delete on ai.connection_tests to crm_app;

-- The month's spend by job is read for Settings: one index-only pass over the month.
create index requests_month_job_idx on ai.requests (business_id, started_at, job) include (cost_estimate, status);
