-- Invoice reminders (Invoices → Settings → Reminder Settings, as GoHighLevel has it): emails that
-- remind a customer about an invoice they haven't paid, before or after its due date or the date
-- it was sent. Each reminder applies only to invoices sent after it was turned on.
create table commerce.invoice_reminders (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  name text not null constraint invoice_reminders_name_length check (char_length(name) between 1 and 100),
  enabled boolean not null default true,
  -- When it was last turned on: invoices sent before this are never reminded by it.
  enabled_since timestamptz not null default now(),
  every_amount integer not null constraint invoice_reminders_amount_range check (every_amount between 1 and 365),
  every_unit text not null constraint invoice_reminders_unit_valid check (every_unit in ('hours', 'days', 'months')),
  direction text not null constraint invoice_reminders_direction_valid check (direction in ('before', 'after')),
  anchor text not null constraint invoice_reminders_anchor_valid check (anchor in ('due_date', 'sent_date')),
  max_sends integer not null default 3 constraint invoice_reminders_max_range check (max_sends between 1 and 20),
  subject text not null constraint invoice_reminders_subject_length check (char_length(subject) between 1 and 200),
  body text not null constraint invoice_reminders_body_length check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  -- Nothing sends before the date the invoice was sent.
  constraint invoice_reminders_before_due_only check (direction = 'after' or anchor = 'due_date')
);
call util.add_updated_at_trigger('commerce.invoice_reminders');
call util.enable_tenant_rls('commerce.invoice_reminders');
grant select, insert, update, delete on commerce.invoice_reminders to crm_app;

-- Each reminder email sent for an invoice, once per step: what stops a second.
create table commerce.invoice_reminder_sends (
  business_id uuid not null,
  reminder_id uuid not null,
  document_id uuid not null,
  step integer not null constraint invoice_reminder_sends_step_range check (step between 1 and 20),
  message_id uuid,
  sent_at timestamptz not null default now(),
  primary key (business_id, reminder_id, document_id, step),
  constraint invoice_reminder_sends_reminder foreign key (business_id, reminder_id)
    references commerce.invoice_reminders (business_id, id) on delete cascade,
  constraint invoice_reminder_sends_document foreign key (business_id, document_id)
    references commerce.documents (business_id, id) on delete cascade
);
create index invoice_reminder_sends_document_idx on commerce.invoice_reminder_sends (business_id, document_id);
call util.enable_tenant_rls('commerce.invoice_reminder_sends');
grant select, insert on commerce.invoice_reminder_sends to crm_app;

comment on table commerce.invoice_reminders is
  'Reminder emails for unpaid invoices: when, how often and what they say. Not retroactive.';
comment on table commerce.invoice_reminder_sends is
  'Each reminder email sent for an invoice, one row per step, so none is sent twice.';

-- Which businesses have a reminder turned on, for the worker's sweep, which has no tenant
-- context of its own until it picks a business (as private.businesses_with_expired_trash).
create function private.businesses_with_invoice_reminders(p_limit integer)
returns table (agency_id uuid, business_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, b.id
  from tenancy.businesses b
  where exists (select 1 from commerce.invoice_reminders r where r.business_id = b.id and r.enabled)
  order by b.id
  limit p_limit
$$;
revoke execute on function private.businesses_with_invoice_reminders(integer) from public;
grant execute on function private.businesses_with_invoice_reminders(integer) to crm_app;
