-- What Stripe sends to a business's webhook address, kept as it came until the worker, which alone
-- can open the signing secret, checks the signature and applies the event. The address's token
-- finds its connection through one narrow function; nothing in the request decides the business.
-- Stripe sends an event again until it is answered with a 2xx, for up to three days in live mode
-- (https://docs.stripe.com/webhooks.md, "Automatic retries"), so a full queue answers "try later".
create table commerce.stripe_webhooks (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  -- The Stripe-Signature header as it came.
  signature text not null
    constraint stripe_webhooks_signature_length check (length(signature) between 1 and 2048),
  body bytea not null
    constraint stripe_webhooks_body_size check (octet_length(body) <= 262144),
  received_at timestamptz not null,
  -- The event's own id, once its signature was checked.
  event_id text
    constraint stripe_webhooks_event_format check (event_id ~ '^evt_[A-Za-z0-9_]{1,250}$'),
  outcome text
    constraint stripe_webhooks_outcome_valid
      check (outcome in ('applied', 'ignored', 'refused')),
  processed_at timestamptz,
  primary key (business_id, id),
  constraint stripe_webhooks_processed_complete check ((processed_at is null) = (outcome is null))
);
create index stripe_webhooks_waiting on commerce.stripe_webhooks (business_id, received_at)
  where processed_at is null;
create index stripe_webhooks_received on commerce.stripe_webhooks (received_at);
call util.enable_tenant_rls('commerce.stripe_webhooks');
-- Rows come in only through private.accept_stripe_webhook; the worker reads, marks and deletes them.
grant select, update, delete on commerce.stripe_webhooks to crm_app;

comment on table commerce.stripe_webhooks is
  'Stripe''s events for a business, kept until the worker checked and applied them.';

-- The one way in for a request to /webhooks/stripe/<token>: the token's digest names a connected
-- account of an active business, and the request is kept for the worker, within limits.
create function private.accept_stripe_webhook(p_digest text, p_signature text, p_body bytea)
returns table (outcome text, webhook_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare
  v_agency uuid;
  v_business uuid;
  v_id uuid;
  v_received timestamptz;
  v_usage record;
begin
  if p_digest is null or p_digest !~ '^[0-9a-f]{64}$' then
    return query select 'unknown'::text, null::uuid;
    return;
  end if;
  select b.agency_id, c.business_id into v_agency, v_business
  from commerce.stripe_connections c
  join tenancy.businesses b on b.id = c.business_id
  where c.webhook_digest = p_digest and c.status = 'connected' and b.status = 'active';
  if not found then
    return query select 'unknown'::text, null::uuid;
    return;
  end if;
  if p_signature is null or length(p_signature) not between 1 and 2048
    or p_body is null or octet_length(p_body) > 262144 then
    return query select 'refused'::text, null::uuid;
    return;
  end if;
  -- One business's events at a time, so its count below holds until this one is in.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('stripe-webhook:' || v_business::text, 0));
  v_received := clock_timestamp();
  select count(*) filter (where w.processed_at is null) as waiting,
    count(*) filter (where w.received_at > v_received - interval '1 minute') as minute,
    count(*) as retained
    into v_usage
  from (
    select processed_at, received_at from commerce.stripe_webhooks
    where business_id = v_business limit 10000
  ) w;
  if v_usage.waiting >= 500 or v_usage.minute >= 300 or v_usage.retained >= 10000 then
    return query select 'over_capacity'::text, null::uuid;
    return;
  end if;
  insert into commerce.stripe_webhooks (business_id, signature, body, received_at)
  values (v_business, p_signature, p_body, v_received)
  returning id into v_id;
  -- Shaped as private.enqueue_job's payload (0020); the scope comes from the connection.
  perform graphile_worker.add_job(
    'commerce.apply_stripe_webhook',
    payload := jsonb_build_object(
      'agencyId', v_agency, 'businessId', v_business,
      'correlationId', uuidv7(), 'causationId', null,
      'data', jsonb_build_object('webhookId', v_id)
    )::json,
    queue_name := 'stripe-webhooks:' || v_business::text,
    job_key := 'stripe-webhook:' || v_id::text
  );
  return query select 'accepted'::text, v_id;
end
$$;
revoke execute on function private.accept_stripe_webhook(text, text, bytea) from public;
grant execute on function private.accept_stripe_webhook(text, text, bytea) to crm_app;
