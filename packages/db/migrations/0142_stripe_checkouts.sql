-- A customer paying an invoice by card, through the business's own Stripe account. The invoice's
-- public page asks for one (preparing); the worker, which alone can open the key, creates the
-- Checkout Session and keeps its id and address (open); Stripe's notice that it was paid records
-- the payment (paid). The page's own address is needed for Stripe to send the customer back, and
-- only its digest is kept anywhere, so the token is sealed in the vault until the worker used it.
create table commerce.stripe_checkouts (
  id uuid not null default uuidv7(),
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  document_id uuid not null,
  status text not null default 'preparing'
    constraint stripe_checkouts_status_valid
      check (status in ('preparing', 'open', 'paid', 'unmatched', 'expired', 'failed')),
  -- The invoice's balance when the session was made, in the invoice's currency.
  amount numeric(19, 4) constraint stripe_checkouts_amount_positive check (amount > 0),
  currency text constraint stripe_checkouts_currency_format check (currency ~ '^[A-Z]{3}$'),
  return_secret_id uuid,
  session_id text
    constraint stripe_checkouts_session_format check (session_id ~ '^cs_[A-Za-z0-9_]{8,250}$'),
  session_url text
    constraint stripe_checkouts_url_format check (
      session_url like 'https://checkout.stripe.com/%' and length(session_url) <= 4096),
  expires_at timestamptz,
  livemode boolean,
  -- The receipt the paid session became.
  payment_id uuid,
  failure text
    constraint stripe_checkouts_failure_valid
      check (failure in ('not_connected', 'not_payable', 'unsupported_currency', 'below_minimum',
                         'key_rejected', 'missing_permission', 'provider_error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint stripe_checkouts_document_fk foreign key (business_id, document_id)
    references commerce.documents (business_id, id) on delete cascade,
  constraint stripe_checkouts_payment_fk foreign key (business_id, payment_id)
    references commerce.payments (business_id, id),
  constraint stripe_checkouts_open_complete check (
    status in ('preparing', 'failed') or (
      session_id is not null and session_url is not null and expires_at is not null
      and amount is not null and currency is not null and livemode is not null)),
  constraint stripe_checkouts_paid_has_payment check ((status = 'paid') = (payment_id is not null)),
  constraint stripe_checkouts_failed_has_reason check ((status = 'failed') = (failure is not null))
);
create unique index stripe_checkouts_session_unique on commerce.stripe_checkouts (session_id);
create index stripe_checkouts_document on commerce.stripe_checkouts (business_id, document_id, created_at desc);
create index stripe_checkouts_payment on commerce.stripe_checkouts (business_id, payment_id)
  where payment_id is not null;
call util.add_updated_at_trigger('commerce.stripe_checkouts');
call util.enable_tenant_rls('commerce.stripe_checkouts');
grant select, insert, update on commerce.stripe_checkouts to crm_app;

comment on table commerce.stripe_checkouts is
  'A customer''s card payment of an invoice through the business''s own Stripe account.';
