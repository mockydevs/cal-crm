-- Email checks are address-scoped. Delivery refusals remain in suppressions.
alter table messaging.settings
  add column email_verification_enabled boolean not null default true,
  add column email_reverify_after_90_days boolean not null default true,
  add column email_verification_daily_limit integer not null default 1000,
  add constraint settings_email_verification_limit_valid
    check (email_verification_daily_limit between 0 and 100000) not valid;

alter table messaging.provider_connections drop constraint provider_connections_provider_valid;
alter table messaging.provider_connections add constraint provider_connections_provider_valid
  check (provider in ('twilio', 'telnyx', 'emailable')) not valid;
alter table messaging.provider_connections validate constraint provider_connections_provider_valid;
create unique index provider_connections_email_verification_unique
  on messaging.provider_connections (business_id) where provider = 'emailable' and business_id is not null;
alter table messaging.provider_connections
  add column available_credits integer check (available_credits >= 0),
  add column test_mode boolean;

create table messaging.email_verifications (
  business_id uuid not null references tenancy.businesses(id) on delete cascade,
  id uuid not null default uuidv7(),
  address_normalized text not null check (length(address_normalized) between 3 and 320
    and address_normalized = lower(address_normalized)),
  status text check (status in ('valid','risky','invalid','unknown')),
  depth text check (depth in ('domain','mailbox')),
  reasons text[] not null default '{}' check (
    cardinality(reasons) <= 18 and coalesce(array_ndims(reasons),1) = 1
    and array_position(reasons,null) is null and reasons <@ array[
      'bad_syntax','unsupported_syntax','domain_not_found','no_mail_server','no_mail_accepted',
      'dns_unavailable','disposable','role','free_provider','catch_all','mailbox_full',
      'mailbox_not_found','smtp_rejected','low_quality','low_deliverability',
      'mail_server_unavailable','provider_error','hard_bounce']::text[]),
  provider text check (provider = 'emailable'),
  provider_result jsonb check (jsonb_typeof(provider_result) = 'object'
    and octet_length(provider_result::text) <= 1000
    and provider_result - 'state' - 'reason' = '{}'::jsonb),
  checked_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 1000000),
  next_attempt_at timestamptz,
  excluded boolean not null default false,
  excluded_by_kind text check (excluded_by_kind in ('user','system','api_key','ai_agent','automation')),
  excluded_by_id uuid,
  excluded_at timestamptz,
  current_check_id uuid,
  claimed_check_id uuid,
  claimed_at timestamptz,
  -- Daily spending admission counts outstanding calls too, before any network I/O.
  provider_reserved_at timestamptz,
  -- The check that has had its one early retry after a provider asked to wait.
  early_retry_check_id uuid,
  primary key (business_id, address_normalized),
  unique (business_id,id),
  check ((status is null and depth is null and checked_at is null)
    or (status is not null and depth is not null and checked_at is not null)),
  check ((claimed_check_id is null) = (claimed_at is null))
);
call util.enable_tenant_rls('messaging.email_verifications');
grant select, insert, update on messaging.email_verifications to crm_app;

-- One immutable receipt per attempt. An in-flight fence is persisted separately above,
-- so replaying a job after an ambiguous crash never calls the paid provider again.
create table messaging.email_verification_checks (
  business_id uuid not null references tenancy.businesses(id) on delete cascade,
  id uuid not null,
  address_normalized text not null,
  provider text check (provider = 'emailable'),
  charged boolean not null,
  outcome text not null check (outcome in ('valid','risky','invalid','unknown','abandoned')),
  actor_kind text not null check (actor_kind in ('user','system','api_key','ai_agent','automation')),
  actor_id uuid,
  created_at timestamptz not null default now(),
  primary key (business_id,id),
  foreign key (business_id,address_normalized)
    references messaging.email_verifications(business_id,address_normalized)
);
create index email_verification_checks_daily_idx on messaging.email_verification_checks(business_id,created_at);
create index email_verification_checks_address_idx on messaging.email_verification_checks(business_id,address_normalized);
call util.enable_tenant_rls('messaging.email_verification_checks');
grant select, insert on messaging.email_verification_checks to crm_app;

create function private.enqueue_email_verification(p_id uuid,p_check_id uuid,p_run_at timestamptz default now())
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_job_id bigint;
begin
  perform 1 from messaging.email_verifications v
    join tenancy.businesses b on b.id=v.business_id
    where v.id=p_id and v.business_id=app.business_id() and b.agency_id=app.agency_id();
  if not found then raise exception 'verification is not available in this context'; end if;
  if to_regprocedure('graphile_worker.remove_job(text)') is null then return null; end if;
  select j.id into v_job_id from graphile_worker.add_job('messaging.verify_address',
    payload := jsonb_build_object('agencyId',app.agency_id(),'businessId',app.business_id(),
      'correlationId',app.correlation_id(),'causationId',null,
      'data',jsonb_build_object('verificationId',p_id,'checkId',p_check_id))::json,
    run_at := p_run_at, job_key := 'email-verification:' || p_id::text,
    job_key_mode := 'replace') as j;
  return v_job_id;
end $$;
revoke execute on function private.enqueue_email_verification(uuid,uuid,timestamptz) from public;
grant execute on function private.enqueue_email_verification(uuid,uuid,timestamptz) to crm_app;

-- Ordinary enqueueing preserves a queued retry's time. A finished verification must wake
-- that retry now. Reuse enqueue's tenant/message checks before advancing its own job only.
create function private.wake_verified_outbound(p_message_id uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_job_id bigint;
begin
  v_job_id := private.enqueue_outbound(p_message_id);
  perform graphile_worker.reschedule_jobs(array[v_job_id], run_at := now());
  return v_job_id;
end $$;
revoke execute on function private.wake_verified_outbound(uuid) from public;
grant execute on function private.wake_verified_outbound(uuid) to crm_app;

-- A send leaves out a Cc or Bcc that is suppressed and goes to the rest. What it left out
-- is noted here, each with the suppression's reason; the message's own copy lists then
-- name only those it went to.
alter table messaging.outbound_dispatch
  add column left_out_copies jsonb not null default '[]';
alter table messaging.outbound_dispatch
  add constraint outbound_dispatch_left_out_copies_valid check (
    case when jsonb_typeof(left_out_copies) <> 'array' then false
    else jsonb_array_length(left_out_copies) <= 20
      and not jsonb_path_exists(left_out_copies, 'strict $[*] ? (@.type() != "object")')
      and not jsonb_path_exists(left_out_copies,
        'lax $[*].keyvalue() ? (!(@.key == "copy" || @.key == "address" || @.key == "reason"))', '{}', true)
      -- An address is 1 to 320 characters (two bounded runs: a regex repeats at most 255).
      and not jsonb_path_exists(left_out_copies, 'lax $[*] ? (!(@.copy == "cc" || @.copy == "bcc")
        || !(@.reason == "hard_bounce" || @.reason == "complaint" || @.reason == "unsubscribe"
          || @.reason == "invalid" || @.reason == "manual")
        || @.copy.type() != "string" || @.reason.type() != "string"
        || !(@.address.type() == "string")
        || !(@.address like_regex "^.{1,160}.{0,160}$" flag "s"))', '{}', true)
    end) not valid;
alter table messaging.outbound_dispatch validate constraint outbound_dispatch_left_out_copies_valid;
