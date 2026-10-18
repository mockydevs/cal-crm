-- B1.01 to B1.04: folders for field definitions, placeholder text, and custom values
-- (account-wide text that templates and automations fill in as {{custom_values.<key>}}).
-- Existing rows keep their meaning: every field that exists lands in its object's system
-- folder, and nothing about a field's key, type or values changes.

-- Field folders ---------------------------------------------------------------------------
-- A folder groups the fields of one object type; the record page shows a folder as a
-- section. Each object type has exactly one system folder, made with it below, which is
-- where a field goes when nobody chose a folder and where a deleted folder's fields move.

create table crm.field_folders (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  object_type_id uuid not null,
  name text not null constraint field_folders_name_length check (length(btrim(name)) between 1 and 80),
  position integer not null default 0,
  is_system boolean not null default false,
  created_by_kind text not null constraint field_folders_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, object_type_id) references crm.object_types (business_id, id) on delete cascade,
  -- Lets a field definition pin its folder to its own object type.
  constraint field_folders_id_object_unique unique (business_id, id, object_type_id)
);
create unique index field_folders_name_unique_idx
  on crm.field_folders (business_id, object_type_id, lower(btrim(name)));
create unique index field_folders_one_system_idx
  on crm.field_folders (business_id, object_type_id) where is_system;

-- A folder keeps its object and its kind, and a system folder keeps its name. The
-- application says so in words first; this is what holds when it doesn't.
create function private.guard_field_folder() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.business_id is distinct from old.business_id
     or new.object_type_id is distinct from old.object_type_id
     or new.is_system is distinct from old.is_system then
    raise exception 'A field folder keeps its object and whether it is a system folder.'
      using errcode = 'check_violation', constraint = 'field_folders_object_and_kind_fixed';
  end if;
  if old.is_system and new.name is distinct from old.name then
    raise exception 'A system field folder cannot be renamed.'
      using errcode = 'check_violation', constraint = 'field_folders_system_name_fixed';
  end if;
  return new;
end
$$;
revoke execute on function private.guard_field_folder() from public;
create trigger field_folders_guard before update on crm.field_folders
  for each row execute function private.guard_field_folder();

-- Every object type gets its system folder in the transaction that makes it, whoever
-- makes it: business.create, an import, a fixture.
create function private.create_system_field_folder() returns trigger
language plpgsql set search_path = ''
as $$
begin
  insert into crm.field_folders (business_id, object_type_id, name, is_system, created_by_kind)
  values (new.business_id, new.id, 'Additional Info', true, 'system');
  return null;
end
$$;
revoke execute on function private.create_system_field_folder() from public;
create trigger object_types_system_field_folder after insert on crm.object_types
  for each row execute function private.create_system_field_folder();

insert into crm.field_folders (business_id, object_type_id, name, is_system, created_by_kind)
select business_id, id, 'Additional Info', true, 'system' from crm.object_types;

-- Fields in folders ---------------------------------------------------------------------------
-- placeholder is the hint an empty input shows. It is display text only: it is never
-- stored as a value. Who made a field is now read as its source, so created_by_kind has to
-- be a kind of actor the product knows; every writer already stores one.

alter table crm.field_definitions
  add column folder_id uuid,
  add column placeholder text not null default ''
    constraint field_definitions_placeholder_length check (length(placeholder) <= 200),
  add constraint field_definitions_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import'));

-- Putting existing fields in their system folder is not an edit of the field.
alter table crm.field_definitions disable trigger touch_updated_at;
update crm.field_definitions f
set folder_id = d.id
from crm.field_folders d
where d.business_id = f.business_id and d.object_type_id = f.object_type_id and d.is_system;
alter table crm.field_definitions enable trigger touch_updated_at;

-- The folder must be one of the field's own object type. The check waits for the end of
-- the transaction, so that deleting an object type (which removes its folders and its
-- fields in an order nobody chooses) and moving a folder's fields before deleting it both
-- work; a folder that still has fields cannot be deleted, at commit at the latest.
alter table crm.field_definitions
  alter column folder_id set not null,
  add constraint field_definitions_folder_fkey
    foreign key (business_id, folder_id, object_type_id)
    references crm.field_folders (business_id, id, object_type_id)
    deferrable initially deferred;
create index field_definitions_folder_idx
  on crm.field_definitions (business_id, folder_id, object_type_id);
-- The Custom Fields list: newest first within a business.
create index field_definitions_created_idx on crm.field_definitions (business_id, created_at desc, id desc);

-- A field made without a folder goes to its object's system folder.
create function private.assign_field_folder() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.folder_id is null then
    select d.id into new.folder_id
    from crm.field_folders d
    where d.business_id = new.business_id
      and d.object_type_id = new.object_type_id
      and d.is_system;
  end if;
  return new;
end
$$;
revoke execute on function private.assign_field_folder() from public;
create trigger field_definitions_default_folder before insert on crm.field_definitions
  for each row execute function private.assign_field_folder();

-- Custom values --------------------------------------------------------------------------------
-- Text a business writes once and uses in many messages: {{custom_values.<key>}}. The key
-- is made when the value is created and never changes, so renaming a value breaks nothing
-- that uses it. A value belongs to at most one folder, and folders are not nested.

create table crm.custom_value_folders (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  name text not null constraint custom_value_folders_name_length check (length(btrim(name)) between 1 and 80),
  created_by_kind text not null constraint custom_value_folders_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id)
);
create unique index custom_value_folders_name_unique_idx
  on crm.custom_value_folders (business_id, lower(btrim(name)));

create table crm.custom_values (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  key text not null constraint custom_values_key_format check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  name text not null constraint custom_values_name_length check (length(btrim(name)) between 1 and 120),
  -- Plain text. Empty means the value has nothing to say yet: a send that uses it stops,
  -- as it does for any merge field without a value.
  value text not null default '' constraint custom_values_value_length check (length(value) <= 5000),
  folder_id uuid,
  created_by_kind text not null constraint custom_values_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint custom_values_key_unique unique (business_id, key),
  -- Deleting a folder leaves its values, in no folder.
  foreign key (business_id, folder_id) references crm.custom_value_folders (business_id, id)
    on delete set null (folder_id)
);
create unique index custom_values_name_unique_idx
  on crm.custom_values (business_id, lower(btrim(name)));
create index custom_values_folder_idx on crm.custom_values (business_id, folder_id);

create function private.guard_custom_value() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.business_id is distinct from old.business_id or new.key is distinct from old.key then
    raise exception 'A custom value keeps its key.'
      using errcode = 'check_violation', constraint = 'custom_values_key_fixed';
  end if;
  return new;
end
$$;
revoke execute on function private.guard_custom_value() from public;
create trigger custom_values_guard before update on crm.custom_values
  for each row execute function private.guard_custom_value();

-- Triggers, row-level security and grants ------------------------------------------------------

call util.add_updated_at_trigger('crm.field_folders');
call util.add_updated_at_trigger('crm.custom_value_folders');
call util.add_updated_at_trigger('crm.custom_values');

call util.enable_tenant_rls('crm.field_folders');
call util.enable_tenant_rls('crm.custom_value_folders');
call util.enable_tenant_rls('crm.custom_values');

-- The application may never delete a system folder, whatever it asks for.
create policy field_folders_delete_own_only on crm.field_folders
  as restrictive for delete
  using (not is_system);

grant select, insert, update, delete on crm.field_folders, crm.custom_value_folders,
  crm.custom_values to crm_app;
