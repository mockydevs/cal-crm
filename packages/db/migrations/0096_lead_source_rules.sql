-- The business's own lead source rules (tasks/lead-source-plan.md 3.1 lines 3 to 7 and 10,
-- stage 3; ADR-091, addendum of 2026-10-14): Settings → Lead Sources.
--
-- A rule is conditions that must all hold and what to do when they do: name the lead's
-- Source, add tags, fill text custom fields of the contact. The CRM module tries a
-- business's rules before the built-in ones, in `position` order, inside the transaction
-- that stores a lead: one read of at most 50 small rows by the index below, and no network.
--
-- One new table. No existing row is rewritten: touches recorded before a rule existed keep
-- the name they were given.

create table crm.lead_source_rules (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  -- The order rules are tried in, from 1 with no gaps. 50 is the most rules a business has,
  -- so the bound on the position is the bound on the count.
  position integer not null constraint lead_source_rules_position_valid
    check (position between 1 and 50),
  name text not null constraint lead_source_rules_name_valid
    check (length(btrim(name)) between 1 and 80 and name !~ '[[:cntrl:]]'),
  -- A rule switched off is kept and never tried.
  enabled boolean not null default true,
  -- [{ "fact": "utm_campaign", "op": "contains", "value": "spring" }, …]: the vocabulary and
  -- the operators are the contract's (packages/contracts/src/lead-source-rules.ts), checked
  -- by the application when a rule is saved. The database holds the shape and the count.
  conditions jsonb not null constraint lead_source_rules_conditions_valid
    check (jsonb_typeof(conditions) = 'array' and jsonb_array_length(conditions) between 1 and 5),
  -- The Source the rule gives a lead; null when it only adds tags or fills fields.
  source_label text constraint lead_source_rules_source_label_valid
    check (length(btrim(source_label)) between 1 and 200 and source_label !~ '[[:cntrl:]]'),
  -- crm.tags.id of the tags the rule adds. No foreign key can hold an array: a tag deleted
  -- since is skipped when the rule is applied, and said when the rule is read.
  tag_ids uuid[] not null default '{}' constraint lead_source_rules_tag_ids_valid
    check (cardinality(tag_ids) <= 5),
  -- [{ "fieldId": "<crm.field_definitions.id>", "value": "…" }, …]: text custom fields of
  -- the contact to fill.
  field_writes jsonb not null default '[]' constraint lead_source_rules_field_writes_valid
    check (jsonb_typeof(field_writes) = 'array' and jsonb_array_length(field_writes) <= 3),
  -- Raised by every save: a save names the revision it read, and a stale one is refused.
  revision integer not null default 1 constraint lead_source_rules_revision_valid
    check (revision >= 1),
  created_by_kind text not null constraint lead_source_rules_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  -- A rule that does nothing is not a rule.
  constraint lead_source_rules_acts check (
    source_label is not null or cardinality(tag_ids) > 0 or jsonb_array_length(field_writes) > 0
  ),
  -- One rule a place. Checked when a statement ends, not row by row, so one statement can
  -- move every rule of a business to its new place. Its index is also the one read a lead's
  -- intake makes: a business's rules in their order.
  constraint lead_source_rules_position_unique unique (business_id, position)
    deferrable initially immediate
);

comment on table crm.lead_source_rules is
  'The business''s own lead source rules: conditions over the facts of a visit, and the Source, tags and field values a matching lead gets. Tried before the built-in rules, in position order.';
comment on column crm.lead_source_rules.position is
  'The order the rule is tried in, from 1 with no gaps; at most 50 rules a business.';
comment on column crm.lead_source_rules.conditions is
  'One to five conditions that must all hold: { fact, op, value | values, name }.';
comment on column crm.lead_source_rules.source_label is
  'The Source this rule gives a lead. The first matching rule that has one decides; null when the rule names none.';
comment on column crm.lead_source_rules.tag_ids is
  'crm.tags.id of the tags a matching lead gets, at most five. A tag deleted since is skipped.';
comment on column crm.lead_source_rules.field_writes is
  'Text custom fields of the contact a matching lead has filled: { fieldId, value }, at most three.';

-- A rule keeps its business.
create function private.guard_lead_source_rule() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.business_id is distinct from old.business_id then
    raise exception 'A lead source rule keeps its business.'
      using errcode = 'check_violation', constraint = 'lead_source_rules_business_fixed';
  end if;
  return new;
end
$$;
revoke execute on function private.guard_lead_source_rule() from public;
create trigger lead_source_rules_guard before update on crm.lead_source_rules
  for each row execute function private.guard_lead_source_rule();

call util.add_updated_at_trigger('crm.lead_source_rules');
call util.enable_tenant_rls('crm.lead_source_rules');

grant select, insert, update, delete on crm.lead_source_rules to crm_app;

-- What decided a touch's lead source may now be a rule of the business, by its public id.
comment on column crm.contact_attributions.source_rule is
  'What decided source_label: the key of a built-in rule, such as google_ads, or the public id of the business''s own rule (lsr_…).';
comment on column forms.submissions.lead_source_rule is
  'What decided lead_source: the key of a built-in rule, or the public id of the business''s own rule (lsr_…).';
