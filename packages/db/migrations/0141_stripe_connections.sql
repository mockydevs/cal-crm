-- A business's own Stripe account, for card payments on its invoices. The business pastes a
-- restricted key; the worker creates the webhook endpoint on that account. Three secrets are in
-- the vault: the key, the capability token in this install's webhook address for it, and the
-- endpoint's signing secret. Only the token's digest is kept here, to route what Stripe sends.
create table commerce.stripe_connections (
  business_id uuid not null primary key references tenancy.businesses (id) on delete cascade,
  status text not null default 'connecting'
    constraint stripe_connections_status_valid
      check (status in ('connecting', 'connected', 'failed')),
  -- Test or live, from the key's own prefix.
  livemode boolean not null,
  key_secret_id uuid not null,
  webhook_token_secret_id uuid not null,
  -- The SHA-256, in hex, of the capability token in this install's webhook address.
  webhook_digest text not null
    constraint stripe_connections_digest_format check (webhook_digest ~ '^[0-9a-f]{64}$'),
  webhook_endpoint_id text
    constraint stripe_connections_endpoint_format check (webhook_endpoint_id ~ '^we_[A-Za-z0-9]{8,64}$'),
  webhook_secret_id uuid,
  failure text
    constraint stripe_connections_failure_valid
      check (failure in ('key_rejected', 'missing_permission', 'no_public_address', 'provider_error')),
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stripe_connections_connected_complete check (
    status <> 'connected' or (webhook_endpoint_id is not null and webhook_secret_id is not null)),
  constraint stripe_connections_failed_has_reason check ((status = 'failed') = (failure is not null))
);
create unique index stripe_connections_digest_unique on commerce.stripe_connections (webhook_digest);
call util.add_updated_at_trigger('commerce.stripe_connections');
call util.enable_tenant_rls('commerce.stripe_connections');
grant select, insert, update, delete on commerce.stripe_connections to crm_app;

-- Endpoints of a connection that was replaced or removed, still to be deleted at Stripe with the
-- key they were made with. The worker deletes the endpoint, then the key and this row.
create table commerce.stripe_endpoint_removals (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  webhook_endpoint_id text not null
    constraint stripe_endpoint_removals_endpoint_format check (webhook_endpoint_id ~ '^we_[A-Za-z0-9]{8,64}$'),
  key_secret_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (business_id, id)
);
call util.enable_tenant_rls('commerce.stripe_endpoint_removals');
grant select, insert, delete on commerce.stripe_endpoint_removals to crm_app;

comment on table commerce.stripe_connections is
  'Each business''s own Stripe account for invoice card payments; its secrets live in the vault.';
comment on table commerce.stripe_endpoint_removals is
  'Stripe webhook endpoints of replaced or removed connections, waiting to be deleted at Stripe.';
