-- Media Storage (ADR-089): a business's library is a view over files.files, not a second
-- store. Three columns say what a library needs (in it or not, which folder, a public
-- address), and updated_at is the "Modified" a library sorts by.

-- Folders, shaped like messaging.template_folders (0069): nested, sibling names unique
-- without regard to case, the root included.
create table files.folders (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  parent_id uuid,
  name text not null constraint folders_name_length
    check (length(btrim(name)) between 1 and 120),
  name_normalized text generated always as (lower(btrim(name))) stored,
  created_by_kind text not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint folders_parent_business foreign key (business_id, parent_id)
    references files.folders (business_id, id),
  constraint folders_not_self check (parent_id is null or parent_id <> id)
);
alter table files.folders add constraint folders_name_unique
  unique nulls not distinct (business_id, parent_id, name_normalized) deferrable initially immediate;
call util.enable_tenant_rls('files.folders');
call util.add_updated_at_trigger('files.folders');
grant select, insert, update, delete on files.folders to crm_app;

alter table files.files
  add column library boolean not null default false,
  add column folder_id uuid,
  add column public_key text,
  add column updated_at timestamptz;
-- A file that was never changed was last modified when it was stored.
update files.files set updated_at = created_at;
alter table files.files
  alter column updated_at set not null,
  alter column updated_at set default now(),
  -- A library is one business's: the agency's own files have none.
  add constraint files_library_has_business check (not library or business_id is not null),
  add constraint files_folder_needs_library check (folder_id is null or library),
  -- 128 random bits in base64url. Only a live library file has a public address.
  add constraint files_public_key_shape check (public_key ~ '^[A-Za-z0-9_-]{22}$'),
  add constraint files_public_needs_live_library
    check (public_key is null or (library and deleted_at is null)),
  add constraint files_folder_business foreign key (business_id, folder_id)
    references files.folders (business_id, id);
call util.add_updated_at_trigger('files.files');
create unique index files_public_key_unique on files.files (public_key) where public_key is not null;
-- What a folder's page reads, newest first; it starts with the folder key's columns.
create index files_folder_list_idx on files.files (business_id, folder_id, updated_at desc, id desc);

-- Where a file is used, by name, for the library's "used in" and its refusal to delete a
-- file something still shows. It runs as the caller, under row-level security, so it
-- answers for the caller's business only. Every foreign key to files.files is here; the
-- integrity tests fail when a new one is added and this is not.
create function files.file_usage(p_file_id uuid)
returns table (place text)
language sql stable set search_path = ''
as $$
  select 'business_logo' where exists (
    select 1 from tenancy.businesses where logo_file_id = p_file_id)
  union all
  select 'agency_logo' where exists (
    select 1 from tenancy.agencies where logo_file_id = p_file_id)
  union all
  select 'user_picture' where exists (
    select 1 from tenancy.user_profiles where avatar_file_id = p_file_id)
  union all
  select 'calendar' where exists (
    select 1 from calendar.calendars where logo_file_id = p_file_id or cover_file_id = p_file_id)
  union all
  select 'message_attachment' where exists (
    select 1 from messaging.message_attachments where file_id = p_file_id)
  union all
  select 'import' where exists (
    select 1 from imports.jobs where file_id = p_file_id or error_file_id = p_file_id)
  union all
  select 'site_template' where exists (
    select 1 from sites.templates where preview_file_id = p_file_id)
$$;
revoke execute on function files.file_usage(uuid) from public;
grant execute on function files.file_usage(uuid) to crm_app;

-- Which business a public media address (/m/<key>/<name>) is for: the pattern of
-- private.resolve_form (0049). It answers only for a key of the right shape, a live
-- library file and an active business, and says nothing the file holds. The files module
-- then reads the file again under row-level security, in that business.
create function private.resolve_public_media(p_public_key text)
returns table (agency_id uuid, business_id uuid, file_id uuid)
language sql stable security definer set search_path = ''
as $$
  select f.agency_id, f.business_id, f.id
  from files.files f
  join tenancy.businesses b on b.id = f.business_id
  where f.public_key = p_public_key
    and p_public_key ~ '^[A-Za-z0-9_-]{22}$'
    and f.library
    and f.deleted_at is null
    and b.status = 'active'
$$;
revoke execute on function private.resolve_public_media(text) from public;
grant execute on function private.resolve_public_media(text) to crm_app;
