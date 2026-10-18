-- M1.02 / ADR-074: tenant-local placement without changing template identity or content.
create table messaging.template_folders (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  parent_id uuid,
  name text not null constraint template_folders_name_length
    check (length(btrim(name)) between 1 and 120),
  name_normalized text generated always as (lower(btrim(name))) stored,
  revision integer not null default 1 constraint template_folders_revision_positive check (revision > 0),
  created_by_kind text not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint template_folders_parent_business foreign key (business_id, parent_id)
    references messaging.template_folders (business_id, id),
  constraint template_folders_not_self check (parent_id is null or parent_id <> id)
);

alter table messaging.template_folders add constraint template_folders_name_unique
  unique nulls not distinct (business_id, parent_id, name_normalized) deferrable initially immediate;
call util.enable_tenant_rls('messaging.template_folders');
call util.add_updated_at_trigger('messaging.template_folders');
grant select, insert, update, delete on messaging.template_folders to crm_app;

alter table messaging.templates add column folder_id uuid;
alter table messaging.templates add constraint templates_folder_business
  foreign key (business_id, folder_id) references messaging.template_folders (business_id, id);
create index templates_folder_list on messaging.templates (business_id, folder_id, name_normalized, id);
