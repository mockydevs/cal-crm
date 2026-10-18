-- P1.53: reusable messages that automations send by id or name (AUTOMATIONS.md sections 2
-- and 3). Plain text only, never HTML. Text may hold merge fields such as
-- {{contact.firstName}}, filled in when sent.
create table messaging.templates (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  channel text not null default 'email' constraint templates_channel_valid check (channel in ('email')),
  name text not null constraint templates_name_length check (length(btrim(name)) between 1 and 120),
  name_normalized text generated always as (lower(btrim(name))) stored,
  -- One line: a line break in a subject would let text become another header.
  subject text not null constraint templates_subject_valid
    check (length(subject) between 1 and 255 and subject !~ '[\r\n]'),
  body text not null constraint templates_body_length check (length(body) between 1 and 100000),
  created_by_kind text not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  primary key (business_id, id)
);
-- Names are how documents and people refer to templates, so live ones are unique.
create unique index templates_name_unique
  on messaging.templates (business_id, channel, name_normalized) where archived_at is null;
call util.enable_tenant_rls('messaging.templates');
call util.add_updated_at_trigger('messaging.templates');
grant select, insert, update on messaging.templates to crm_app;
