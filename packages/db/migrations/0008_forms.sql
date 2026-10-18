-- Forms and their submissions.

create schema forms;

create table forms.forms (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  name text not null constraint forms_name_length check (length(btrim(name)) between 1 and 120),
  -- Fields, how each maps onto contact fields or custom fields, and the consent wording.
  definition jsonb not null constraint forms_definition_object check (jsonb_typeof(definition) = 'object'),
  status text not null default 'draft' constraint forms_status_valid check (status in ('draft', 'published', 'archived')),
  -- Identifies the form to the public embed script.
  public_key text not null constraint forms_public_key_format check (public_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint forms_public_key_unique unique (public_key)
);

-- A submission holds personal data, so erasing the contact erases it too.
create table forms.submissions (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  form_id uuid not null,
  contact_id uuid,
  data jsonb not null constraint submissions_data_object check (jsonb_typeof(data) = 'object'),
  consent jsonb not null default '{}' constraint submissions_consent_object check (jsonb_typeof(consent) = 'object'),
  utm jsonb not null default '{}' constraint submissions_utm_object check (jsonb_typeof(utm) = 'object'),
  ip inet,
  user_agent text,
  submitted_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, form_id) references forms.forms (business_id, id) on delete cascade,
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade
);
create index submissions_form_idx on forms.submissions (business_id, form_id, submitted_at desc);
create index submissions_contact_idx on forms.submissions (business_id, contact_id);

call util.add_updated_at_trigger('forms.forms');

call util.enable_tenant_rls('forms.forms');
call util.enable_tenant_rls('forms.submissions');
