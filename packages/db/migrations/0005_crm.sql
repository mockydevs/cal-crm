-- CRM core: object types, the record registry, contacts, companies, deals, custom
-- records, custom fields, tags, links between records, notes, tasks, saved views and
-- the timeline.
--
-- Tenant tables use the primary key (business_id, id), and every reference to another
-- tenant table includes business_id. A row can therefore never point at a row in
-- another business, whatever the application does.

create schema crm;

-- Object types ------------------------------------------------------------------------
-- Built-in kinds (contact, company, deal) get one row per business; custom objects
-- ("Event", "Venue") add more. Field definitions and links point at these rows, so
-- built-in and custom objects are handled the same way.

create table crm.object_types (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  kind text not null constraint object_types_kind_valid check (kind in ('contact', 'company', 'deal', 'custom')),
  key text not null constraint object_types_key_format check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  singular_label text not null constraint object_types_singular_length check (length(btrim(singular_label)) between 1 and 60),
  plural_label text not null constraint object_types_plural_length check (length(btrim(plural_label)) between 1 and 60),
  description text not null default '' constraint object_types_description_length check (length(description) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  primary key (business_id, id),
  constraint object_types_key_unique unique (business_id, key),
  constraint object_types_id_kind_unique unique (business_id, id, kind)
);
create unique index object_types_one_builtin_per_kind_idx
  on crm.object_types (business_id, kind) where kind <> 'custom';

-- The record registry -----------------------------------------------------------------
-- Every contact, company, deal and custom record has exactly one row here. Fields, tags,
-- links, notes, tasks, the timeline and automations reference records(business_id, id),
-- which gives them real foreign keys to "any record". Deleting a record means deleting
-- its registry row: the cascade removes the typed row and everything attached to it.

create table crm.records (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  kind text not null constraint records_kind_valid check (kind in ('contact', 'company', 'deal', 'custom')),
  object_type_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint records_id_kind_unique unique (business_id, id, kind),
  foreign key (business_id, object_type_id, kind) references crm.object_types (business_id, id, kind)
);
create index records_object_type_idx on crm.records (business_id, object_type_id, kind);

-- Contacts ------------------------------------------------------------------------------

create table crm.contacts (
  business_id uuid not null,
  id uuid not null,
  kind text not null default 'contact' constraint contacts_kind_fixed check (kind = 'contact'),
  first_name text constraint contacts_first_name_length check (length(first_name) <= 200),
  last_name text constraint contacts_last_name_length check (length(last_name) <= 200),
  display_name text generated always as (
    nullif(btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')) stored,
  owner_user_id uuid references auth.users (id),
  timezone text,
  locale text,
  last_activity_at timestamptz,  -- maintained by the timeline projection
  created_by_kind text not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,        -- in the trash; purged after crm.settings.trash_retention_days
  search tsvector generated always as (
    to_tsvector('simple', coalesce(first_name, '') || ' ' || coalesce(last_name, ''))) stored,
  primary key (business_id, id),
  foreign key (business_id, id, kind) references crm.records (business_id, id, kind) on delete cascade
);
create index contacts_owner_idx on crm.contacts (owner_user_id, business_id);
create index contacts_search_idx on crm.contacts using gin (search);
create index contacts_display_name_trgm_idx on crm.contacts using gin (display_name gin_trgm_ops);
create index contacts_recent_idx on crm.contacts (business_id, last_activity_at desc nulls last)
  where deleted_at is null;

-- Email addresses, phone numbers and handles. Each one belongs to one contact in a
-- business: inbound messages are matched on these, and duplicates are blocked here.
create table crm.contact_identities (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  contact_id uuid not null,
  kind text not null constraint contact_identities_kind_valid
    check (kind in ('email', 'phone', 'whatsapp', 'facebook', 'instagram', 'webchat')),
  value text not null constraint contact_identities_value_length check (length(value) between 1 and 320),
  -- Lowercased email or E.164 phone, produced by the application.
  value_normalized text not null,
  is_primary boolean not null default false,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade,
  constraint contact_identities_value_unique unique (business_id, kind, value_normalized),
  constraint contact_identities_email_format check (
    kind <> 'email' or (value_normalized ~ '^[^@\s]+@[^@\s]+$' and value_normalized = lower(value_normalized))),
  constraint contact_identities_phone_format check (
    kind not in ('phone', 'whatsapp') or value_normalized ~ '^\+[1-9][0-9]{6,14}$')
);
create index contact_identities_contact_idx on crm.contact_identities (business_id, contact_id);
create unique index contact_identities_one_primary_idx
  on crm.contact_identities (business_id, contact_id, kind) where is_primary;
create index contact_identities_value_trgm_idx
  on crm.contact_identities using gin (value_normalized gin_trgm_ops);

-- Companies -----------------------------------------------------------------------------

create table crm.companies (
  business_id uuid not null,
  id uuid not null,
  kind text not null default 'company' constraint companies_kind_fixed check (kind = 'company'),
  name text not null constraint companies_name_length check (length(btrim(name)) between 1 and 200),
  domain text constraint companies_domain_format check (domain = lower(domain) and domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  phone_e164 text constraint companies_phone_format check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  owner_user_id uuid references auth.users (id),
  last_activity_at timestamptz,
  created_by_kind text not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  search tsvector generated always as (to_tsvector('simple', name || ' ' || coalesce(domain, ''))) stored,
  primary key (business_id, id),
  foreign key (business_id, id, kind) references crm.records (business_id, id, kind) on delete cascade
);
create unique index companies_domain_unique_idx
  on crm.companies (business_id, domain) where domain is not null and deleted_at is null;
create index companies_owner_idx on crm.companies (owner_user_id, business_id);
create index companies_search_idx on crm.companies using gin (search);
create index companies_name_trgm_idx on crm.companies using gin (name gin_trgm_ops);

-- Pipelines and deals -------------------------------------------------------------------

create table crm.pipelines (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  name text not null constraint pipelines_name_length check (length(btrim(name)) between 1 and 80),
  description text not null default '',
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  primary key (business_id, id)
);
create unique index pipelines_name_unique_idx
  on crm.pipelines (business_id, lower(btrim(name))) where archived_at is null;

-- Stages are archived, never deleted, once a deal has passed through them: deals and
-- stage history keep pointing at them.
create table crm.pipeline_stages (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  pipeline_id uuid not null,
  name text not null constraint pipeline_stages_name_length check (length(btrim(name)) between 1 and 80),
  -- The assistant reads this to decide when a deal belongs in the stage.
  description text not null default '',
  position integer not null,
  win_probability numeric(5, 4) constraint pipeline_stages_probability_range check (win_probability between 0 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  primary key (business_id, id),
  constraint pipeline_stages_pipeline_id_unique unique (business_id, pipeline_id, id),
  foreign key (business_id, pipeline_id) references crm.pipelines (business_id, id) on delete cascade
);
create unique index pipeline_stages_name_unique_idx
  on crm.pipeline_stages (business_id, pipeline_id, lower(btrim(name))) where archived_at is null;

create table crm.lost_reasons (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  label text not null constraint lost_reasons_label_length check (length(btrim(label)) between 1 and 80),
  description text not null default '',
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  primary key (business_id, id)
);
create unique index lost_reasons_label_unique_idx
  on crm.lost_reasons (business_id, lower(btrim(label))) where archived_at is null;

-- Stage is where the deal is (or was when it closed); status is the outcome. The
-- constraints keep them from contradicting each other, so no automation has to.
create table crm.deals (
  business_id uuid not null,
  id uuid not null,
  kind text not null default 'deal' constraint deals_kind_fixed check (kind = 'deal'),
  name text not null constraint deals_name_length check (length(btrim(name)) between 1 and 200),
  pipeline_id uuid not null,
  stage_id uuid not null,
  status text not null default 'open' constraint deals_status_valid check (status in ('open', 'won', 'lost')),
  amount numeric(19, 4) constraint deals_amount_nonnegative check (amount >= 0),
  currency text not null constraint deals_currency_format check (currency ~ '^[A-Z]{3}$'),
  expected_close_date date,
  closed_at timestamptz,
  lost_reason_id uuid,
  lost_note text,
  owner_user_id uuid references auth.users (id),
  stage_entered_at timestamptz not null default now(),
  -- Fractional index for manual ordering inside a board column; compared byte-wise.
  board_position text collate "C",
  last_activity_at timestamptz,
  created_by_kind text not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (business_id, id),
  foreign key (business_id, id, kind) references crm.records (business_id, id, kind) on delete cascade,
  -- The stage must belong to the deal's pipeline.
  foreign key (business_id, pipeline_id, stage_id) references crm.pipeline_stages (business_id, pipeline_id, id),
  foreign key (business_id, lost_reason_id) references crm.lost_reasons (business_id, id),
  constraint deals_closed_at_matches_status check ((status = 'open') = (closed_at is null)),
  constraint deals_lost_details_only_when_lost check (status = 'lost' or (lost_reason_id is null and lost_note is null))
);
create index deals_board_idx on crm.deals (business_id, pipeline_id, stage_id, status, board_position);
create index deals_lost_reason_idx on crm.deals (business_id, lost_reason_id);
create index deals_owner_idx on crm.deals (owner_user_id, business_id);

-- Written in the same transaction as each stage change, so reports on time-in-stage
-- and conversion are exact.
create table crm.deal_stage_history (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  deal_id uuid not null,
  pipeline_id uuid not null,
  stage_id uuid not null,
  entered_at timestamptz not null,
  exited_at timestamptz,
  entered_by_kind text not null,
  entered_by_id uuid,
  primary key (business_id, id),
  foreign key (business_id, deal_id) references crm.deals (business_id, id) on delete cascade,
  foreign key (business_id, pipeline_id, stage_id) references crm.pipeline_stages (business_id, pipeline_id, id),
  constraint deal_stage_history_exit_after_entry check (exited_at is null or exited_at >= entered_at)
);
create index deal_stage_history_deal_idx on crm.deal_stage_history (business_id, deal_id, entered_at);
create unique index deal_stage_history_one_open_idx
  on crm.deal_stage_history (business_id, deal_id) where exited_at is null;
create index deal_stage_history_stage_idx on crm.deal_stage_history (business_id, pipeline_id, stage_id, entered_at);

-- Custom records ------------------------------------------------------------------------
-- Records of custom object types; their data lives in field_values.

create table crm.custom_records (
  business_id uuid not null,
  id uuid not null,
  kind text not null default 'custom' constraint custom_records_kind_fixed check (kind = 'custom'),
  title text not null constraint custom_records_title_length check (length(btrim(title)) between 1 and 200),
  owner_user_id uuid references auth.users (id),
  last_activity_at timestamptz,
  created_by_kind text not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  search tsvector generated always as (to_tsvector('simple', title)) stored,
  primary key (business_id, id),
  foreign key (business_id, id, kind) references crm.records (business_id, id, kind) on delete cascade
);
create index custom_records_owner_idx on crm.custom_records (owner_user_id, business_id);
create index custom_records_search_idx on crm.custom_records using gin (search);

-- Every registry row must have its typed row by the end of the transaction.
create function crm.assert_record_has_subtype() returns trigger
language plpgsql
as $$
declare
  v_found boolean;
begin
  if not exists (select 1 from crm.records r where r.business_id = new.business_id and r.id = new.id) then
    return null;  -- deleted again later in the same transaction
  end if;
  v_found := case new.kind
    when 'contact' then exists (select 1 from crm.contacts s where s.business_id = new.business_id and s.id = new.id)
    when 'company' then exists (select 1 from crm.companies s where s.business_id = new.business_id and s.id = new.id)
    when 'deal' then exists (select 1 from crm.deals s where s.business_id = new.business_id and s.id = new.id)
    when 'custom' then exists (select 1 from crm.custom_records s where s.business_id = new.business_id and s.id = new.id)
  end;
  if not coalesce(v_found, false) then
    raise exception 'record % has kind % but no matching % row', new.id, new.kind, new.kind
      using errcode = 'foreign_key_violation';
  end if;
  return null;
end
$$;

create constraint trigger records_have_subtype
  after insert on crm.records
  deferrable initially deferred
  for each row execute function crm.assert_record_has_subtype();

-- Custom fields ---------------------------------------------------------------------------
-- A field is a typed fact with a description the assistant reads. key is immutable and
-- is what automations and merge fields use ({{contact.custom.event_date}}).

create table crm.field_definitions (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  object_type_id uuid not null,
  key text not null constraint field_definitions_key_format check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  label text not null constraint field_definitions_label_length check (length(btrim(label)) between 1 and 80),
  description text not null default '' constraint field_definitions_description_length check (length(description) <= 2000),
  value_type text not null constraint field_definitions_value_type_valid check (value_type in (
    'text', 'long_text', 'number', 'money', 'date', 'datetime', 'boolean',
    'single_choice', 'multi_choice', 'email', 'phone', 'url')),
  -- Choices: [{"key": "opt_7h2k", "label": "Lighting", "description": "...", "archived": false}].
  -- Option keys are stable; labels can change.
  options jsonb not null default '[]' constraint field_definitions_options_array check (jsonb_typeof(options) = 'array'),
  currency text constraint field_definitions_currency_format check (currency ~ '^[A-Z]{3}$'),
  -- Where the assistant may fill this field from, and whether it may overwrite a value a
  -- person entered.
  ai_fill_sources text[] not null default '{}' constraint field_definitions_ai_sources_valid
    check (ai_fill_sources <@ array['conversations', 'forms', 'call_notes']::text[]),
  ai_overwrite text not null default 'ask' constraint field_definitions_ai_overwrite_valid
    check (ai_overwrite in ('ask', 'allow', 'never')),
  position integer not null default 0,
  merged_into_field_id uuid,
  archived_at timestamptz,
  created_by_kind text not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, object_type_id) references crm.object_types (business_id, id) on delete cascade,
  foreign key (business_id, merged_into_field_id) references crm.field_definitions (business_id, id),
  constraint field_definitions_key_unique unique (business_id, object_type_id, key),
  -- Lets field_values pin the type it was written with.
  constraint field_definitions_id_value_type_unique unique (business_id, id, value_type),
  constraint field_definitions_money_has_currency check ((value_type = 'money') = (currency is not null)),
  constraint field_definitions_choices_have_options
    check ((value_type in ('single_choice', 'multi_choice')) = (jsonb_array_length(options) > 0)),
  constraint field_definitions_merge_means_archived check (merged_into_field_id is null or archived_at is not null)
);
create unique index field_definitions_label_unique_idx
  on crm.field_definitions (business_id, object_type_id, lower(btrim(label))) where archived_at is null;
create index field_definitions_merged_into_idx on crm.field_definitions (business_id, merged_into_field_id);

-- After a merge, the old key keeps resolving to the surviving field, so published
-- automation versions that use it keep working.
create table crm.field_key_aliases (
  business_id uuid not null,
  object_type_id uuid not null,
  alias_key text not null constraint field_key_aliases_key_format check (alias_key ~ '^[a-z][a-z0-9_]{0,62}$'),
  field_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (business_id, object_type_id, alias_key),
  foreign key (business_id, object_type_id) references crm.object_types (business_id, id) on delete cascade,
  foreign key (business_id, field_id) references crm.field_definitions (business_id, id) on delete cascade
);
create index field_key_aliases_field_idx on crm.field_key_aliases (business_id, field_id);

-- One row per filled field. An empty field has no row. Each value records who or what
-- set it and the event it came from, which powers the "Field source" pattern and lets
-- the assistant respect values a person typed.
create table crm.field_values (
  business_id uuid not null,
  record_id uuid not null,
  field_id uuid not null,
  value_type text not null,
  value_text text,
  value_number numeric,
  value_date date,
  value_datetime timestamptz,
  value_bool boolean,
  value_options text[],
  source_kind text not null constraint field_values_source_kind_valid
    check (source_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  source_id uuid,
  source_event_id uuid,
  confidence real constraint field_values_confidence_range check (confidence between 0 and 1),
  confirmed_by_id uuid,
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (business_id, record_id, field_id),
  foreign key (business_id, record_id) references crm.records (business_id, id) on delete cascade,
  -- Changing a field's type is blocked until its values are migrated.
  foreign key (business_id, field_id, value_type)
    references crm.field_definitions (business_id, id, value_type) on delete cascade,
  constraint field_values_one_value check (
    num_nonnulls(value_text, value_number, value_date, value_datetime, value_bool, value_options) = 1),
  constraint field_values_value_matches_type check (coalesce(case value_type
    when 'text' then value_text is not null and length(value_text) <= 1000
    when 'email' then value_text is not null and length(value_text) <= 320
    when 'phone' then value_text is not null and value_text ~ '^\+[1-9][0-9]{6,14}$'
    when 'url' then value_text is not null and length(value_text) <= 2000
    when 'long_text' then value_text is not null and length(value_text) <= 100000
    when 'number' then value_number is not null
    when 'money' then value_number is not null
    when 'date' then value_date is not null
    when 'datetime' then value_datetime is not null
    when 'boolean' then value_bool is not null
    when 'single_choice' then value_options is not null and cardinality(value_options) = 1
    when 'multi_choice' then value_options is not null and cardinality(value_options) >= 1
  end, false)),
  constraint field_values_confirmation_complete check ((confirmed_at is null) = (confirmed_by_id is null))
);
create index field_values_field_idx on crm.field_values (business_id, field_id, value_type, record_id);
create index field_values_number_idx on crm.field_values (business_id, field_id, value_number)
  where value_number is not null;
create index field_values_date_idx on crm.field_values (business_id, field_id, value_date)
  where value_date is not null;
create index field_values_datetime_idx on crm.field_values (business_id, field_id, value_datetime)
  where value_datetime is not null;
create index field_values_text_idx on crm.field_values (business_id, field_id, lower(value_text))
  where value_type in ('text', 'email', 'phone', 'url');
create index field_values_options_idx on crm.field_values using gin (value_options)
  where value_options is not null;

-- Tags ----------------------------------------------------------------------------------
-- Tags are labels for grouping and filtering, never state: stages, statuses and
-- "reached step X" belong in deal stages, fields and events.

create table crm.tag_groups (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  name text not null constraint tag_groups_name_length check (length(btrim(name)) between 1 and 60),
  description text not null default '',
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id)
);
create unique index tag_groups_name_unique_idx on crm.tag_groups (business_id, lower(btrim(name)));

create table crm.tags (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  name text not null constraint tags_name_length check (length(btrim(name)) between 1 and 60),
  -- "Hot Lead", "hot-lead", "hot_lead" and " hot  lead " share one key, so only one of
  -- them can exist in a business.
  name_key text generated always as (lower(regexp_replace(btrim(name), '[\s_-]+', ' ', 'g'))) stored,
  group_id uuid,
  description text not null default '' constraint tags_description_length check (length(description) <= 500),
  created_by_kind text not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint tags_name_key_unique unique (business_id, name_key),
  foreign key (business_id, group_id) references crm.tag_groups (business_id, id) on delete set null (group_id)
);
create index tags_group_idx on crm.tags (business_id, group_id);

create table crm.record_tags (
  business_id uuid not null,
  record_id uuid not null,
  tag_id uuid not null,
  source_kind text not null constraint record_tags_source_kind_valid
    check (source_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  source_id uuid,
  source_event_id uuid,
  created_at timestamptz not null default now(),
  primary key (business_id, record_id, tag_id),
  foreign key (business_id, record_id) references crm.records (business_id, id) on delete cascade,
  foreign key (business_id, tag_id) references crm.tags (business_id, id) on delete cascade
);
create index record_tags_tag_idx on crm.record_tags (business_id, tag_id, record_id);

-- Links between records -------------------------------------------------------------------
-- Link types say which object types they join and what the link means; the defaults are
-- deal↔contact, contact↔company and deal↔company. Custom objects add their own.

create table crm.link_types (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  key text not null constraint link_types_key_format check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  from_object_type_id uuid not null,
  to_object_type_id uuid not null,
  label text not null constraint link_types_label_length check (length(btrim(label)) between 1 and 60),
  reverse_label text not null constraint link_types_reverse_label_length check (length(btrim(reverse_label)) between 1 and 60),
  description text not null default '',
  allows_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  primary key (business_id, id),
  constraint link_types_key_unique unique (business_id, key),
  foreign key (business_id, from_object_type_id) references crm.object_types (business_id, id) on delete cascade,
  foreign key (business_id, to_object_type_id) references crm.object_types (business_id, id) on delete cascade
);
create index link_types_from_idx on crm.link_types (business_id, from_object_type_id);
create index link_types_to_idx on crm.link_types (business_id, to_object_type_id);

create table crm.record_links (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  link_type_id uuid not null,
  from_record_id uuid not null,
  to_record_id uuid not null,
  is_primary boolean not null default false,
  source_kind text not null,
  source_id uuid,
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, link_type_id) references crm.link_types (business_id, id),
  foreign key (business_id, from_record_id) references crm.records (business_id, id) on delete cascade,
  foreign key (business_id, to_record_id) references crm.records (business_id, id) on delete cascade,
  constraint record_links_unique unique (business_id, from_record_id, link_type_id, to_record_id),
  constraint record_links_not_self check (from_record_id <> to_record_id)
);
create index record_links_link_type_idx on crm.record_links (business_id, link_type_id);
create index record_links_to_idx on crm.record_links (business_id, to_record_id, link_type_id);
-- At most one primary link of each type per record (for example the deal's main contact).
create unique index record_links_one_primary_idx
  on crm.record_links (business_id, from_record_id, link_type_id) where is_primary;

-- Notes, tasks and saved views ----------------------------------------------------------------

create table crm.notes (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  record_id uuid not null,
  body jsonb not null constraint notes_body_object check (jsonb_typeof(body) = 'object'),  -- editor document
  body_text text not null,  -- plain text, for search and the assistant
  author_kind text not null,
  author_id uuid,
  pinned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('simple', left(body_text, 100000))) stored,
  primary key (business_id, id),
  foreign key (business_id, record_id) references crm.records (business_id, id) on delete cascade
);
create index notes_record_idx on crm.notes (business_id, record_id, created_at desc);
create index notes_search_idx on crm.notes using gin (search);

create table crm.tasks (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  record_id uuid,
  title text not null constraint tasks_title_length check (length(btrim(title)) between 1 and 300),
  body_text text not null default '',
  due_at timestamptz,
  assignee_user_id uuid references auth.users (id),
  completed_at timestamptz,
  completed_by_kind text,
  completed_by_id uuid,
  created_by_kind text not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, record_id) references crm.records (business_id, id) on delete cascade,
  constraint tasks_completion_complete check ((completed_at is null) = (completed_by_kind is null))
);
create index tasks_record_idx on crm.tasks (business_id, record_id);
create index tasks_assignee_idx on crm.tasks (assignee_user_id, business_id, due_at) where completed_at is null;

create table crm.saved_views (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  object_type_id uuid not null,
  name text not null constraint saved_views_name_length check (length(btrim(name)) between 1 and 80),
  filters jsonb not null default '{}' constraint saved_views_filters_object check (jsonb_typeof(filters) = 'object'),
  sort jsonb not null default '[]' constraint saved_views_sort_array check (jsonb_typeof(sort) = 'array'),
  columns jsonb not null default '[]' constraint saved_views_columns_array check (jsonb_typeof(columns) = 'array'),
  visibility text not null default 'private' constraint saved_views_visibility_valid check (visibility in ('private', 'shared')),
  owner_user_id uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, object_type_id) references crm.object_types (business_id, id) on delete cascade
);
create index saved_views_object_type_idx on crm.saved_views (business_id, object_type_id);
create index saved_views_owner_idx on crm.saved_views (owner_user_id, business_id);

create table crm.settings (
  business_id uuid primary key references tenancy.businesses (id) on delete cascade,
  tag_creation text not null default 'admins' constraint settings_tag_creation_valid check (tag_creation in ('admins', 'everyone')),
  suggest_similar_tags boolean not null default true,
  trash_retention_days integer not null default 30 constraint settings_trash_days_range check (trash_retention_days between 1 and 365),
  updated_at timestamptz not null default now()
);

-- Timeline ------------------------------------------------------------------------------
-- One row per (event, record it concerns), written in the event's transaction. A
-- contact's timeline is one index range scan, newest first. Partitioned like the
-- events so both can be archived month by month.

create table crm.timeline_entries (
  business_id uuid not null,
  record_id uuid not null,
  occurred_at timestamptz not null,
  event_id uuid not null,
  event_recorded_at timestamptz not null,
  event_type text not null,
  primary key (business_id, record_id, occurred_at, event_id, event_recorded_at),
  foreign key (business_id, record_id) references crm.records (business_id, id) on delete cascade
) partition by range (event_recorded_at);

do $$ begin perform util.ensure_monthly_partitions('crm.timeline_entries', 1, 3); end $$;

-- Triggers and row-level security ------------------------------------------------------------

call util.add_updated_at_trigger('crm.object_types');
call util.add_updated_at_trigger('crm.contacts');
call util.add_updated_at_trigger('crm.companies');
call util.add_updated_at_trigger('crm.pipelines');
call util.add_updated_at_trigger('crm.pipeline_stages');
call util.add_updated_at_trigger('crm.lost_reasons');
call util.add_updated_at_trigger('crm.deals');
call util.add_updated_at_trigger('crm.custom_records');
call util.add_updated_at_trigger('crm.field_definitions');
call util.add_updated_at_trigger('crm.field_values');
call util.add_updated_at_trigger('crm.tag_groups');
call util.add_updated_at_trigger('crm.tags');
call util.add_updated_at_trigger('crm.link_types');
call util.add_updated_at_trigger('crm.notes');
call util.add_updated_at_trigger('crm.tasks');
call util.add_updated_at_trigger('crm.saved_views');
call util.add_updated_at_trigger('crm.settings');

call util.enable_tenant_rls('crm.object_types');
call util.enable_tenant_rls('crm.records');
call util.enable_tenant_rls('crm.contacts');
call util.enable_tenant_rls('crm.contact_identities');
call util.enable_tenant_rls('crm.companies');
call util.enable_tenant_rls('crm.pipelines');
call util.enable_tenant_rls('crm.pipeline_stages');
call util.enable_tenant_rls('crm.lost_reasons');
call util.enable_tenant_rls('crm.deals');
call util.enable_tenant_rls('crm.deal_stage_history');
call util.enable_tenant_rls('crm.custom_records');
call util.enable_tenant_rls('crm.field_definitions');
call util.enable_tenant_rls('crm.field_key_aliases');
call util.enable_tenant_rls('crm.field_values');
call util.enable_tenant_rls('crm.tag_groups');
call util.enable_tenant_rls('crm.tags');
call util.enable_tenant_rls('crm.record_tags');
call util.enable_tenant_rls('crm.link_types');
call util.enable_tenant_rls('crm.record_links');
call util.enable_tenant_rls('crm.notes');
call util.enable_tenant_rls('crm.tasks');
call util.enable_tenant_rls('crm.saved_views');
call util.enable_tenant_rls('crm.settings');
call util.enable_tenant_rls('crm.timeline_entries');
