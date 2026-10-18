-- Commerce, stage 1 (ADR-083): the catalogue of products and services, quotes and invoices
-- with their lines, payments (each one a receipt), the numbering of all three, and the
-- business's settings for them. Nothing here renders a PDF, sends a message or talks to a
-- payment provider: those stages read these tables.
--
-- Money is numeric(19, 4) with a three-letter currency code, as everywhere (DATABASE.md
-- section 2). The application works every amount out (packages/contracts/src/
-- commerce-money.ts) and stores the results, so a list or a report never recomputes; the
-- checks below hold what must be true of the stored numbers whoever wrote them.

create schema commerce;
grant usage on schema commerce to crm_app;

-- Settings ----------------------------------------------------------------------------------
-- One row a business, made the first time something is saved; without one the defaults in
-- the columns apply. The business's name, address and logo are tenancy's (the business
-- profile) and are not repeated here.
create table commerce.settings (
  business_id uuid primary key references tenancy.businesses (id) on delete cascade,
  -- Days from an invoice's issue date to its due date, when the invoice names none.
  payment_terms_days integer not null default 14
    constraint settings_payment_terms_range check (payment_terms_days between 0 and 365),
  -- Days from a quote's issue date to the last day it can be accepted, when it names none.
  quote_validity_days integer not null default 30
    constraint settings_quote_validity_range check (quote_validity_days between 1 and 365),
  default_notes text not null default ''
    constraint settings_default_notes_length check (length(default_notes) <= 5000),
  default_terms text not null default ''
    constraint settings_default_terms_length check (length(default_terms) <= 10000),
  -- How to pay: bank or M-Pesa details, printed on every invoice.
  payment_instructions text not null default ''
    constraint settings_payment_instructions_length check (length(payment_instructions) <= 5000),
  tax_number text constraint settings_tax_number_length check (length(tax_number) between 1 and 64),
  -- Percent, for a new line that names no rate of its own.
  default_tax_rate numeric(7, 4)
    constraint settings_default_tax_rate_range check (default_tax_rate between 0 and 100),
  revision integer not null default 1 constraint settings_revision_positive check (revision > 0),
  updated_at timestamptz not null default now()
);
call util.enable_tenant_rls('commerce.settings');
call util.add_updated_at_trigger('commerce.settings');
grant select, insert, update on commerce.settings to crm_app;

-- Numbering -----------------------------------------------------------------------------------
-- One counter for each kind of number a business gives out. Issuing takes the row FOR
-- UPDATE, uses next_number and moves it on, all in the transaction that writes the number
-- on the document: two issues at once wait for each other, and one that rolls back gives
-- its number back, so the numbers of a kind have no gaps unless someone moved next_number
-- forward. last_number is the highest number ever given out; next_number can never be set
-- at or below it.
create table commerce.sequences (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  kind text not null constraint sequences_kind_valid check (kind in ('quote', 'invoice', 'receipt')),
  prefix text not null constraint sequences_prefix_valid
    check (length(prefix) <= 12 and prefix ~ '^[A-Za-z0-9/_-]*$'),
  next_number bigint not null default 1
    constraint sequences_next_number_range check (next_number between 1 and 999999999999),
  last_number bigint not null default 0
    constraint sequences_last_number_range check (last_number between 0 and 999999999999),
  updated_at timestamptz not null default now(),
  primary key (business_id, kind),
  constraint sequences_next_after_last check (next_number > last_number)
);
call util.enable_tenant_rls('commerce.sequences');
call util.add_updated_at_trigger('commerce.sequences');
grant select, insert, update on commerce.sequences to crm_app;

-- Products and services ---------------------------------------------------------------------
create table commerce.products (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  kind text not null constraint products_kind_valid check (kind in ('product', 'service')),
  name text not null constraint products_name_length check (length(btrim(name)) between 1 and 200),
  -- Kept by the database: the list's order and search read it (ADR-028).
  name_normalized text generated always as (lower(btrim(name))) stored,
  description text not null default ''
    constraint products_description_length check (length(description) <= 5000),
  -- The business's own code for it. Optional; one product a code, whatever its capitals.
  sku text constraint products_sku_length check (length(btrim(sku)) between 1 and 64),
  sku_normalized text generated always as (lower(btrim(sku))) stored,
  -- What one of it is: hour, item, day. Free text.
  unit text not null default '' constraint products_unit_length check (length(unit) <= 32),
  unit_price numeric(19, 4) not null
    constraint products_unit_price_nonnegative check (unit_price >= 0),
  currency text not null constraint products_currency_format check (currency ~ '^[A-Z]{3}$'),
  -- Percent. Null means the business's default rate when the product is put on a document.
  tax_rate numeric(7, 4) constraint products_tax_rate_range check (tax_rate between 0 and 100),
  archived_at timestamptz,
  revision integer not null default 1 constraint products_revision_positive check (revision > 0),
  created_by_kind text not null constraint products_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id)
);
create unique index products_sku_unique on commerce.products (business_id, sku_normalized)
  where sku is not null;
-- The list: by name, all kinds or one.
create index products_name_idx on commerce.products (business_id, name_normalized, id);
create index products_kind_idx on commerce.products (business_id, kind, name_normalized, id);
call util.enable_tenant_rls('commerce.products');
call util.add_updated_at_trigger('commerce.products');
grant select, insert, update, delete on commerce.products to crm_app;

-- Quotes and invoices -----------------------------------------------------------------------
-- One table for both: the same lines, the same totals, the same numbering and snapshots.
-- A draft has no number. Issuing gives it one, for good, and writes down who it is from and
-- who it is for as they were that day (seller, customer_*), so a later change to the
-- business profile or to the contact rewrites nothing that was sent.
--
-- Expired (a quote past due_date) and overdue (an invoice past due_date with a balance) are
-- read from due_date and never stored: storing them would need a job at every midnight in
-- every business's time zone, and a late job would show the wrong word.
create table commerce.documents (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  kind text not null constraint documents_kind_valid check (kind in ('quote', 'invoice')),
  status text not null default 'draft',
  number text constraint documents_number_length check (length(number) between 1 and 40),
  sequence_number bigint constraint documents_sequence_number_positive check (sequence_number > 0),
  -- Null only once the contact was purged: the customer_* columns still say who it was for.
  contact_id uuid,
  deal_id uuid,
  -- The quote an invoice was made from.
  source_document_id uuid,
  currency text not null constraint documents_currency_format check (currency ~ '^[A-Z]{3}$'),
  issue_date date,
  -- An invoice's due date; a quote's last day to be accepted.
  due_date date,
  discount_kind text constraint documents_discount_kind_valid check (discount_kind in ('percent', 'amount')),
  discount_value numeric(19, 4) constraint documents_discount_value_nonnegative check (discount_value >= 0),
  -- For the customer, printed on the document.
  notes text not null default '' constraint documents_notes_length check (length(notes) <= 5000),
  terms text not null default '' constraint documents_terms_length check (length(terms) <= 10000),
  -- For the team only; the one text that can change after the document is issued.
  internal_note text not null default ''
    constraint documents_internal_note_length check (length(internal_note) <= 5000),
  -- Who it is for: as the contact was at the last save of the draft, then as it was when
  -- the document was issued.
  customer_name text not null default ''
    constraint documents_customer_name_length check (length(customer_name) <= 300),
  customer_email text constraint documents_customer_email_length check (length(customer_email) between 1 and 320),
  customer_phone text constraint documents_customer_phone_length check (length(customer_phone) between 1 and 40),
  -- The customer's billing address and tax number, as typed on the document.
  bill_to text not null default '' constraint documents_bill_to_length check (length(bill_to) <= 1000),
  customer_tax_number text
    constraint documents_customer_tax_number_length check (length(customer_tax_number) between 1 and 64),
  -- Who it is from, as the business was when the document was issued: name, address, tax
  -- number, logo file and payment instructions. A document, read whole.
  seller jsonb constraint documents_seller_object
    check (jsonb_typeof(seller) = 'object' and octet_length(seller::text) <= 16384),
  subtotal numeric(19, 4) not null default 0 constraint documents_subtotal_nonnegative check (subtotal >= 0),
  discount_total numeric(19, 4) not null default 0
    constraint documents_discount_total_nonnegative check (discount_total >= 0),
  tax_total numeric(19, 4) not null default 0 constraint documents_tax_total_nonnegative check (tax_total >= 0),
  total numeric(19, 4) not null default 0 constraint documents_total_nonnegative check (total >= 0),
  amount_paid numeric(19, 4) not null default 0
    constraint documents_amount_paid_nonnegative check (amount_paid >= 0),
  balance_due numeric(19, 4) not null default 0
    constraint documents_balance_due_nonnegative check (balance_due >= 0),
  issued_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  voided_at timestamptz,
  void_reason text constraint documents_void_reason_length check (length(btrim(void_reason)) between 1 and 500),
  revision integer not null default 1 constraint documents_revision_positive check (revision > 0),
  created_by_kind text not null constraint documents_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  -- A payment names its invoice with its kind, so nothing is ever paid against a quote.
  constraint documents_id_kind_unique unique (business_id, id, kind),
  constraint documents_status_valid check (
    (kind = 'quote' and status in ('draft', 'sent', 'accepted', 'declined'))
    or (kind = 'invoice' and status in ('draft', 'sent', 'partly_paid', 'paid', 'void'))),
  constraint documents_number_paired check ((number is null) = (sequence_number is null)),
  -- Only a draft is without a number, and a number is never taken away (the trigger below).
  constraint documents_issued_has_number check (status = 'draft' or number is not null),
  constraint documents_issued_has_snapshot
    check (status = 'draft' or (seller is not null and issued_at is not null and issue_date is not null)),
  constraint documents_due_after_issue check (due_date is null or issue_date is null or due_date >= issue_date),
  constraint documents_discount_paired check ((discount_kind is null) = (discount_value is null)),
  constraint documents_discount_percent_range check (discount_kind <> 'percent' or discount_value <= 100),
  constraint documents_totals_add_up check (total = subtotal - discount_total + tax_total),
  constraint documents_balance_adds_up check (balance_due = total - amount_paid),
  constraint documents_only_invoices_are_paid check (kind = 'invoice' or amount_paid = 0),
  constraint documents_paid_has_no_balance check (status <> 'paid' or balance_due = 0),
  constraint documents_partly_paid_between
    check (status <> 'partly_paid' or (amount_paid > 0 and balance_due > 0)),
  constraint documents_sent_is_unpaid check (kind <> 'invoice' or status <> 'sent' or amount_paid = 0),
  constraint documents_void_is_unpaid check (status <> 'void' or amount_paid = 0),
  constraint documents_void_has_time_and_reason
    check ((status = 'void') = (voided_at is not null) and (status = 'void') = (void_reason is not null)),
  constraint documents_accepted_has_time check ((status = 'accepted') = (accepted_at is not null)),
  constraint documents_declined_has_time check ((status = 'declined') = (declined_at is not null)),
  constraint documents_source_on_invoice_only check (source_document_id is null or kind = 'invoice'),
  -- A purged contact leaves the document, which keeps who it was for.
  constraint documents_contact foreign key (business_id, contact_id)
    references crm.contacts (business_id, id) on delete set null (contact_id),
  constraint documents_deal foreign key (business_id, deal_id)
    references crm.deals (business_id, id) on delete set null (deal_id),
  constraint documents_source foreign key (business_id, source_document_id)
    references commerce.documents (business_id, id)
);
-- A number is given out once in a kind.
create unique index documents_number_unique on commerce.documents (business_id, kind, number)
  where number is not null;
create unique index documents_sequence_unique on commerce.documents (business_id, kind, sequence_number)
  where sequence_number is not null;
-- A quote becomes an invoice once.
create unique index documents_source_unique on commerce.documents (business_id, source_document_id)
  where source_document_id is not null;
-- The lists, newest first (a UUIDv7 sorts by when it was made): a kind, a kind and a
-- status, what is due by a date (overdue and expired), a contact's and a deal's.
create index documents_kind_idx on commerce.documents (business_id, kind, id);
create index documents_status_idx on commerce.documents (business_id, kind, status, id);
create index documents_due_idx on commerce.documents (business_id, kind, status, due_date);
create index documents_issued_idx on commerce.documents (business_id, kind, issue_date, id);
create index documents_contact_idx on commerce.documents (business_id, contact_id, id);
create index documents_deal_idx on commerce.documents (business_id, deal_id, id);

-- A document keeps its business, its kind and, once it has one, its number.
create function private.guard_commerce_document() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.business_id is distinct from old.business_id or new.kind is distinct from old.kind then
    raise exception 'A document keeps its kind.'
      using errcode = 'check_violation', constraint = 'documents_kind_fixed';
  end if;
  if old.number is not null
     and (new.number is distinct from old.number
          or new.sequence_number is distinct from old.sequence_number) then
    raise exception 'A document keeps its number.'
      using errcode = 'check_violation', constraint = 'documents_number_fixed';
  end if;
  return new;
end
$$;
revoke execute on function private.guard_commerce_document() from public;
create trigger documents_guard before update on commerce.documents
  for each row execute function private.guard_commerce_document();

call util.enable_tenant_rls('commerce.documents');
call util.add_updated_at_trigger('commerce.documents');
grant select, insert, update, delete on commerce.documents to crm_app;
-- The application deletes only a draft that never had a number. Anything issued is kept:
-- an invoice is voided, never removed.
create policy documents_delete_unissued_only on commerce.documents
  as restrictive for delete
  using (number is null);

-- Lines ---------------------------------------------------------------------------------------
-- What a document charges for. A line may name the product it was taken from, and keeps its
-- own copy of the name, unit, price and tax rate: changing the product later changes no
-- document. The four amounts are the application's results for the line, stored.
create table commerce.document_lines (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  document_id uuid not null,
  position integer not null constraint document_lines_position_range check (position between 0 and 999),
  product_id uuid,
  name text not null constraint document_lines_name_length check (length(btrim(name)) between 1 and 200),
  description text not null default ''
    constraint document_lines_description_length check (length(description) <= 5000),
  quantity numeric(19, 4) not null constraint document_lines_quantity_positive check (quantity > 0),
  unit text not null default '' constraint document_lines_unit_length check (length(unit) <= 32),
  unit_price numeric(19, 4) not null
    constraint document_lines_unit_price_nonnegative check (unit_price >= 0),
  discount_kind text constraint document_lines_discount_kind_valid check (discount_kind in ('percent', 'amount')),
  discount_value numeric(19, 4)
    constraint document_lines_discount_value_nonnegative check (discount_value >= 0),
  -- Percent.
  tax_rate numeric(7, 4) not null default 0
    constraint document_lines_tax_rate_range check (tax_rate between 0 and 100),
  -- Quantity times unit price, rounded to the currency's smallest unit.
  amount numeric(19, 4) not null constraint document_lines_amount_nonnegative check (amount >= 0),
  -- The line's own discount.
  discount_amount numeric(19, 4) not null default 0
    constraint document_lines_discount_amount_nonnegative check (discount_amount >= 0),
  -- What tax is charged on: the amount less the line's discount and less the line's share
  -- of the document's discount.
  taxable_amount numeric(19, 4) not null
    constraint document_lines_taxable_amount_nonnegative check (taxable_amount >= 0),
  tax_amount numeric(19, 4) not null default 0
    constraint document_lines_tax_amount_nonnegative check (tax_amount >= 0),
  primary key (business_id, id),
  constraint document_lines_position_unique unique (business_id, document_id, position),
  constraint document_lines_discount_paired check ((discount_kind is null) = (discount_value is null)),
  constraint document_lines_discount_percent_range check (discount_kind <> 'percent' or discount_value <= 100),
  constraint document_lines_discount_within_amount check (discount_amount <= amount),
  constraint document_lines_taxable_within_amount check (taxable_amount <= amount - discount_amount),
  constraint document_lines_document foreign key (business_id, document_id)
    references commerce.documents (business_id, id) on delete cascade,
  -- No action: a product on a line is archived, not deleted.
  constraint document_lines_product foreign key (business_id, product_id)
    references commerce.products (business_id, id)
);
create index document_lines_product_idx on commerce.document_lines (business_id, product_id);

-- The lines of a document change only while it is a draft. A line removed by a cascade
-- (its document deleted, or its whole business) goes with what it belonged to: only a
-- statement of the application's own is checked.
create function private.guard_commerce_document_line() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_business uuid;
  v_document uuid;
  v_status text;
begin
  if tg_op = 'DELETE' then
    if pg_catalog.pg_trigger_depth() > 1 then
      return old;
    end if;
    v_business := old.business_id;
    v_document := old.document_id;
  else
    v_business := new.business_id;
    v_document := new.document_id;
  end if;
  select d.status into v_status
  from commerce.documents d
  where d.business_id = v_business and d.id = v_document;
  if found and v_status <> 'draft' then
    raise exception 'The lines of an issued document cannot change.'
      using errcode = 'check_violation', constraint = 'document_lines_draft_only';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;
revoke execute on function private.guard_commerce_document_line() from public;
create trigger document_lines_guard before insert or update or delete on commerce.document_lines
  for each row execute function private.guard_commerce_document_line();

call util.enable_tenant_rls('commerce.document_lines');
grant select, insert, update, delete on commerce.document_lines to crm_app;

-- Payments ------------------------------------------------------------------------------------
-- Money received against an invoice. Each payment is a receipt, with a receipt number of
-- its own. A payment is never deleted: one made by mistake is reversed, and stays with the
-- reason. The invoice's amount_paid is the sum of its payments that are not reversed, kept
-- by the application in the transaction that writes the payment, under the invoice's row
-- lock.
create table commerce.payments (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  document_id uuid not null,
  document_kind text not null default 'invoice'
    constraint payments_document_is_invoice check (document_kind = 'invoice'),
  number text not null constraint payments_number_length check (length(number) between 1 and 40),
  sequence_number bigint not null constraint payments_sequence_number_positive check (sequence_number > 0),
  amount numeric(19, 4) not null constraint payments_amount_positive check (amount > 0),
  currency text not null constraint payments_currency_format check (currency ~ '^[A-Z]{3}$'),
  -- The day the money was received, which need not be the day it was recorded.
  paid_on date not null,
  method text not null constraint payments_method_valid
    check (method in ('cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other')),
  -- The bank's, the M-Pesa or the cheque's own reference.
  reference text constraint payments_reference_length check (length(btrim(reference)) between 1 and 200),
  note text not null default '' constraint payments_note_length check (length(note) <= 2000),
  -- What was still owed on the invoice once this payment was recorded: what its receipt says.
  balance_after numeric(19, 4) not null
    constraint payments_balance_after_nonnegative check (balance_after >= 0),
  status text not null default 'recorded'
    constraint payments_status_valid check (status in ('recorded', 'reversed')),
  reversed_at timestamptz,
  reversal_reason text
    constraint payments_reversal_reason_length check (length(btrim(reversal_reason)) between 1 and 500),
  reversed_by_kind text constraint payments_reversed_by_kind_valid
    check (reversed_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  reversed_by_id uuid,
  recorded_by_kind text not null constraint payments_recorded_by_kind_valid
    check (recorded_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  recorded_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint payments_reversed_together check (
    (status = 'reversed') = (reversed_at is not null)
    and (status = 'reversed') = (reversal_reason is not null)
    and (status = 'reversed') = (reversed_by_kind is not null)),
  constraint payments_invoice foreign key (business_id, document_id, document_kind)
    references commerce.documents (business_id, id, kind)
);
create unique index payments_number_unique on commerce.payments (business_id, number);
create unique index payments_sequence_unique on commerce.payments (business_id, sequence_number);
-- An invoice's payments, oldest first.
create index payments_document_idx on commerce.payments (business_id, document_id, document_kind, id);

-- A payment keeps what it says: only its reversal can be written afterwards, once.
create function private.guard_commerce_payment() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.business_id is distinct from old.business_id
     or new.document_id is distinct from old.document_id
     or new.number is distinct from old.number
     or new.sequence_number is distinct from old.sequence_number
     or new.amount is distinct from old.amount
     or new.currency is distinct from old.currency
     or new.paid_on is distinct from old.paid_on
     or new.method is distinct from old.method
     or new.reference is distinct from old.reference
     or new.balance_after is distinct from old.balance_after
     or old.status = 'reversed' then
    raise exception 'A recorded payment cannot change; reverse it instead.'
      using errcode = 'check_violation', constraint = 'payments_fixed';
  end if;
  return new;
end
$$;
revoke execute on function private.guard_commerce_payment() from public;
create trigger payments_guard before update on commerce.payments
  for each row execute function private.guard_commerce_payment();

call util.enable_tenant_rls('commerce.payments');
call util.add_updated_at_trigger('commerce.payments');
-- No delete: a payment is reversed, never removed.
grant select, insert, update on commerce.payments to crm_app;
