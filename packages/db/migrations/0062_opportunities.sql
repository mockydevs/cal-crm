-- What the Opportunities and Pipelines screens read and change that the database did not
-- hold yet (tasks B3.10 to B3.13, B6.01 to B6.03 and B2.07; ADR-071). An opportunity is a
-- deal (crm.deals). Its owner is
-- crm.deals.owner_user_id and its contacts are crm.record_links of the deal_contact type,
-- both from 0005: this migration adds who follows it, the order and search of the list, the
-- settings of a pipeline and its stages, the three opportunity settings of a business, and
-- the record of each bulk action.

-- B3.10 Followers ----------------------------------------------------------------------------
-- The same model as crm.contact_followers (0059): the team members who want to hear about
-- the deal beside its owner, each at most once. A follower is a person, not a membership:
-- whether they are still on the team is asked of the tenancy module when it matters.
create table crm.deal_followers (
  business_id uuid not null,
  deal_id uuid not null,
  -- Users are never deleted (DATABASE.md section 2).
  user_id uuid not null references auth.users (id),
  added_by_kind text not null constraint deal_followers_added_by_kind_valid
    check (added_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  added_by_id uuid,
  created_at timestamptz not null default now(),
  primary key (business_id, deal_id, user_id),
  foreign key (business_id, deal_id) references crm.deals (business_id, id) on delete cascade
);
comment on table crm.deal_followers is
  'The team members who follow a deal. The deal''s owner is crm.deals.owner_user_id.';
-- "The deals I follow", and the key to auth.users.
create index deal_followers_user_idx on crm.deal_followers (user_id, business_id);

call util.enable_tenant_rls('crm.deal_followers');
grant select, insert, delete on crm.deal_followers to crm_app;

-- B3.11 The list's orders --------------------------------------------------------------------
-- The name as the list sorts it. Plain text comparisons are leakproof, so the by-name keyset
-- reads this index in order under row-level security, as crm.contacts.sort_name does (0023).
alter table crm.deals
  add column sort_name text generated always as (lower(name)) stored;
create index deals_name_idx on crm.deals (business_id, sort_name, id) where deleted_at is null;
-- By value, and by when a deal was last changed. Deals without a value sort after the others
-- whichever way the list runs: the application reads them as a second range of this index.
create index deals_amount_idx on crm.deals (business_id, amount, id) where deleted_at is null;
create index deals_updated_idx on crm.deals (business_id, updated_at, id) where deleted_at is null;

-- B6.01 Pipeline and stage settings ----------------------------------------------------------
-- A pipeline either takes each deal's chance of being won from the stage the deal is in, or
-- lets each deal carry its own. How stage colours are drawn is one of three styles.
alter table crm.pipelines
  add column deal_probability boolean not null default false,
  add column color_style text not null default 'none'
    constraint pipelines_color_style_valid check (color_style in ('none', 'dot', 'tint')),
  -- Whether the dashboard's funnel chart and pie chart show the pipeline at all.
  add column show_in_funnel boolean not null default true,
  add column show_in_pie boolean not null default true;
comment on column crm.pipelines.deal_probability is
  'True: each deal of the pipeline carries its own win probability (crm.deals.win_probability). False: it is the stage''s.';

-- A stage's colour, and whether the funnel chart and the pie chart of the dashboard show
-- it. win_probability is from 0005.
alter table crm.pipeline_stages
  add column color text
    constraint pipeline_stages_color_format check (color ~ '^#[0-9a-f]{6}$'),
  add column show_in_funnel boolean not null default true,
  add column show_in_pie boolean not null default true;

-- A deal's own chance of being won, read where its pipeline says deals carry their own.
alter table crm.deals
  add column win_probability numeric(5, 4)
    constraint deals_win_probability_range check (win_probability between 0 and 1);

-- B6.03 Opportunity settings -----------------------------------------------------------------
-- Whether a deal's owner may differ from its primary contact's, and whether each of the two
-- owners is made a follower of the other record. As they are here nothing is linked, which
-- is how deals and contacts behaved before these settings existed.
alter table crm.settings
  add column deal_owner_differs boolean not null default true,
  add column deal_owner_follows_contact boolean not null default false,
  add column contact_owner_follows_deal boolean not null default false;

-- B3.12 Bulk actions -------------------------------------------------------------------------
-- One row for each bulk action that changed something: what was asked, by whom, and what
-- became of the records it named. The records themselves are in the audit log and on each
-- record's timeline; this is the list the Bulk Actions screen shows.
create table crm.bulk_actions (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  object_kind text not null constraint bulk_actions_object_kind_valid check (object_kind in ('deal')),
  action text not null constraint bulk_actions_action_format check (action ~ '^[a-z][a-z_]{0,39}$'),
  requested_count integer not null,
  done_count integer not null,
  unchanged_count integer not null,
  skipped_count integer not null,
  actor_kind text not null constraint bulk_actions_actor_kind_valid
    check (actor_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  actor_id uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint bulk_actions_counts_nonnegative
    check (done_count >= 0 and unchanged_count >= 0 and skipped_count >= 0),
  -- Every record named has exactly one outcome.
  constraint bulk_actions_counts_add_up
    check (requested_count = done_count + unchanged_count + skipped_count),
  constraint bulk_actions_bounded check (requested_count between 1 and 100),
  constraint bulk_actions_completed_after_created check (completed_at >= created_at)
);
comment on table crm.bulk_actions is
  'The bulk actions run on records, newest first by id: the list of the Bulk Actions screen.';

call util.enable_tenant_rls('crm.bulk_actions');
grant select, insert on crm.bulk_actions to crm_app;
