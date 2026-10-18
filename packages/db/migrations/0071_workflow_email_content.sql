-- ADR-078: mutable content pointers alongside immutable published workflow topology.
alter table automation.versions add constraint versions_binding_owner_unique
  unique (business_id, id, automation_id);

create table automation.email_bindings (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  automation_id uuid not null,
  version_id uuid,
  step text not null constraint email_bindings_step_valid check (step ~ '^[a-z][a-z0-9_]{0,62}$'),
  current_revision integer not null default 1 constraint email_bindings_revision_positive check (current_revision > 0),
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint email_bindings_automation_owner foreign key (business_id, automation_id)
    references automation.automations (business_id, id) on delete cascade,
  constraint email_bindings_version_owner foreign key (business_id, version_id, automation_id)
    references automation.versions (business_id, id, automation_id) on delete cascade,
  constraint email_bindings_action_unique unique nulls not distinct (business_id, automation_id, version_id, step)
);

create table automation.email_content_revisions (
  business_id uuid not null,
  binding_id uuid not null,
  revision integer not null constraint email_content_revision_positive check (revision > 0),
  mode text not null constraint email_content_mode_valid check (mode in ('copy', 'sync')),
  source_template_id uuid,
  source_revision text,
  subject text not null constraint email_content_subject_valid
    check (length(subject) between 1 and 998 and subject ~ '[^[:space:]]'
      and strpos(subject, chr(10)) = 0 and strpos(subject, chr(13)) = 0),
  body text not null constraint email_content_body_valid
    check (length(body) between 1 and 1000000 and body ~ '[^[:space:]]'),
  created_by_kind text not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  primary key (business_id, binding_id, revision),
  constraint email_content_binding_owner foreign key (business_id, binding_id)
    references automation.email_bindings (business_id, id) on delete cascade,
  constraint email_content_source_owner foreign key (business_id, source_template_id)
    references messaging.templates (business_id, id),
  constraint email_content_source_pair check ((source_template_id is null) = (source_revision is null)),
  constraint email_content_source_revision_valid check (source_revision is null or source_revision ~ '^[0-9a-f]{64}$'),
  constraint email_content_sync_source_required check (mode <> 'sync' or source_template_id is not null)
);

-- Create a binding and its first revision atomically; the pointer can never commit dangling.
alter table automation.email_bindings add constraint email_bindings_current_content
  foreign key (business_id, id, current_revision)
  references automation.email_content_revisions (business_id, binding_id, revision)
  deferrable initially deferred;

create index email_content_source_inventory on automation.email_content_revisions
  (business_id, source_template_id, binding_id, revision);
call util.enable_tenant_rls('automation.email_bindings');
call util.enable_tenant_rls('automation.email_content_revisions');
grant select, insert on automation.email_bindings to crm_app;
grant update (current_revision) on automation.email_bindings to crm_app;
grant select, insert on automation.email_content_revisions to crm_app;
