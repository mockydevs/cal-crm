-- What the contacts list and the contact page still lacked on the server (tasks B3.06 to
-- B3.09, B3.14, B3.15, B2.05, B2.06 and B2.08 to B2.10; record tasks/b9-contacts-backend.md).

-- B2.10 Date of birth, contact source and contact type ---------------------------------------
-- Three attributes of the person, null until someone gives them. Whether a date of birth is
-- in the future depends on the day it is asked, so the command checks that; the database
-- holds what never changes: a day no person alive was born before. The source is where the
-- contact says they came from, in the business's own words (created_source, 0059, is how
-- the row came to be, set once by the command that made it). The type is one of the names
-- the application offers (the contract's contactTypes); the database holds the form of a
-- name, so offering another needs no migration.
alter table crm.contacts
  add column date_of_birth date
    constraint contacts_date_of_birth_sane check (date_of_birth >= date '1850-01-01'),
  add column source text
    constraint contacts_source_text
      check (source = btrim(source) and length(source) between 1 and 200),
  add column contact_type text
    constraint contacts_contact_type_format check (contact_type ~ '^[a-z][a-z_]{0,29}$');

-- B3.07 The list by its last change -----------------------------------------------------------
-- The same shape as contacts_newest_idx (0021), so a page by last change is read in index
-- order under row-level security, whatever the size of the business.
create index contacts_updated_idx
  on crm.contacts (business_id, updated_at desc, id desc) where deleted_at is null;

-- B3.08 Custom fields as columns of a smart list ----------------------------------------------
-- table_columns (0057) keeps the built-in columns of a list's table, which the screens built
-- on it read as a list of fixed names. column_layout is the whole table as the person
-- arranged it: built-in columns by key and custom fields by id, in order. Null: the list
-- has no such layout, as every list before this.
alter table crm.saved_views
  add column column_layout jsonb
    constraint saved_views_column_layout_array
      check (column_layout is null or jsonb_typeof(column_layout) = 'array');

-- B3.09 Bulk actions on contacts --------------------------------------------------------------
-- One row for each bulk action started on contacts: what was asked, by whom, how far it has
-- got and what became of the contacts it named. crm.bulk_actions (0062) is a finished row
-- for at most 100 deals changed inside one request; an action on contacts can cover a whole
-- filtered list, so it is a job: it waits, runs a batch at a time, can be stopped, and keeps
-- an outcome for every contact (the items below). The Bulk Actions tab of Contacts lists
-- these rows.
create table crm.contact_bulk_actions (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  -- The name the person gave it, shown in the list. Null: none was given.
  name text constraint contact_bulk_actions_name_text
    check (name = btrim(name) and length(name) between 1 and 200),
  action text not null constraint contact_bulk_actions_action_valid
    check (action in ('add_tags', 'remove_tags', 'trash', 'assign_owner')),
  -- What the action applies, as ids the application resolved when it started: no text a
  -- person typed, and nothing about any contact.
  parameters jsonb not null default '{}'
    constraint contact_bulk_actions_parameters_object check (jsonb_typeof(parameters) = 'object'),
  status text not null default 'queued' constraint contact_bulk_actions_status_valid
    check (status in ('queued', 'running', 'completed', 'cancelled')),
  requested_count integer not null,
  done_count integer not null default 0,
  unchanged_count integer not null default 0,
  skipped_count integer not null default 0,
  cancel_requested_at timestamptz,
  -- The caller's own key for the request, so the same request sent twice is one action.
  request_key uuid,
  actor_kind text not null constraint contact_bulk_actions_actor_kind_valid
    check (actor_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  actor_id uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  primary key (business_id, id),
  constraint contact_bulk_actions_requested_bounded check (requested_count between 1 and 100000),
  constraint contact_bulk_actions_counts_nonnegative
    check (done_count >= 0 and unchanged_count >= 0 and skipped_count >= 0),
  -- Never more outcomes than contacts, and a completed action has one for each.
  constraint contact_bulk_actions_counts_within
    check (done_count + unchanged_count + skipped_count <= requested_count),
  constraint contact_bulk_actions_completed_whole
    check (status <> 'completed' or done_count + unchanged_count + skipped_count = requested_count),
  constraint contact_bulk_actions_finished_when_ended
    check ((finished_at is not null) = (status in ('completed', 'cancelled')))
);
comment on table crm.contact_bulk_actions is
  'The bulk actions started on contacts, newest first by id: the list of the Bulk Actions tab.';
create unique index contact_bulk_actions_request_idx
  on crm.contact_bulk_actions (business_id, request_key) where request_key is not null;

call util.enable_tenant_rls('crm.contact_bulk_actions');
grant select, insert, update on crm.contact_bulk_actions to crm_app;

-- The contacts an action named, fixed when it started, in the order they will be applied,
-- each with what became of it. A contact appears once in an action, so nothing is applied
-- to it twice; an outcome is written in the transaction that applied it, so a batch that
-- dies leaves its contacts without one and they are applied by the next run. contact_id has
-- no foreign key: a contact purged from the trash later keeps its line in the result.
create table crm.contact_bulk_action_items (
  business_id uuid not null,
  bulk_action_id uuid not null,
  position integer not null constraint contact_bulk_action_items_position_positive check (position >= 1),
  contact_id uuid not null,
  outcome text constraint contact_bulk_action_items_outcome_valid
    check (outcome in ('done', 'unchanged', 'skipped')),
  -- Why it was skipped, as a code the application has words for. Never free text.
  reason text constraint contact_bulk_action_items_reason_format
    check (reason ~ '^[a-z][a-z_]{0,39}$'),
  primary key (business_id, bulk_action_id, position),
  constraint contact_bulk_action_items_contact_once unique (business_id, bulk_action_id, contact_id),
  constraint contact_bulk_action_items_reason_for_skipped
    check ((reason is not null) = (outcome is not distinct from 'skipped')),
  foreign key (business_id, bulk_action_id)
    references crm.contact_bulk_actions (business_id, id) on delete cascade
);
comment on table crm.contact_bulk_action_items is
  'What became of each contact a bulk action named. An outcome is null until its batch commits.';
-- The next batch: the contacts with no outcome yet, in order.
create index contact_bulk_action_items_pending_idx
  on crm.contact_bulk_action_items (business_id, bulk_action_id, position) where outcome is null;

call util.enable_tenant_rls('crm.contact_bulk_action_items');
grant select, insert, update on crm.contact_bulk_action_items to crm_app;
