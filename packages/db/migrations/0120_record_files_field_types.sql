-- Two more custom field types, as GoHighLevel has them, and files kept on a record.
--
-- A text box list ('text_list') is one text box for each option the field defines, each
-- filled in on its own: its value is an object of each box's text by option key. A file
-- upload field ('file') holds files uploaded to the record, at most its limit, of the
-- formats it allows: its value is the files' ids, oldest first, and each of those files is
-- one of the record's files. Existing fields and values keep their meaning.

-- Field definitions ------------------------------------------------------------------------------

alter table crm.field_definitions
  drop constraint field_definitions_value_type_valid,
  add constraint field_definitions_value_type_valid check (value_type in (
    'text', 'long_text', 'number', 'money', 'date', 'datetime', 'boolean',
    'single_choice', 'multi_choice', 'email', 'phone', 'url', 'text_list', 'file')),
  -- A text box list's boxes are its options, as a choice field's choices are.
  drop constraint field_definitions_choices_have_options,
  add constraint field_definitions_choices_have_options check (
    (value_type in ('single_choice', 'multi_choice', 'text_list')) = (jsonb_array_length(options) > 0)),
  -- What a file upload field takes: the formats, by extension, and how many files one
  -- record may hold in it. Both for a file upload field, neither for any other.
  add column file_formats text[]
    constraint field_definitions_file_formats_valid check (
      cardinality(file_formats) between 1 and 9
      and file_formats <@ array['pdf', 'doc', 'docx', 'jpg', 'png', 'gif', 'csv', 'xls', 'xlsx']::text[]),
  add column file_limit smallint
    constraint field_definitions_file_limit_range check (file_limit between 1 and 10),
  add constraint field_definitions_file_options_for_files check (
    (value_type = 'file') = (file_formats is not null and file_limit is not null));

-- Field values -----------------------------------------------------------------------------------
-- The two checks are replaced by looser ones that every existing row already meets, so they
-- are added NOT VALID: no scan of the table while it is locked. They hold for every row
-- written from now on.

alter table crm.field_values
  add column value_json jsonb,
  drop constraint field_values_one_value,
  add constraint field_values_one_value check (
    num_nonnulls(value_text, value_number, value_date, value_datetime, value_bool, value_options,
                 value_json) = 1) not valid,
  drop constraint field_values_value_matches_type,
  add constraint field_values_value_matches_type check (coalesce(case value_type
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
    -- Some text in at least one box, and nothing but text: strict, so a list in a box is
    -- refused rather than unwrapped. At most 100 boxes of 1,000 characters, in bytes.
    when 'text_list' then value_json is not null
      and jsonb_typeof(value_json) = 'object'
      and value_json <> '{}'::jsonb
      and not jsonb_path_exists(value_json, 'strict $.* ? (@.type() != "string")')
      and octet_length(value_json::text) <= 512000
    when 'file' then value_options is not null and cardinality(value_options) between 1 and 10
  end, false)) not valid;

-- A record's file is kept for the record alone: the general link of any file, an import,
-- an attachment or the media library never reaches it; only the record's own link does.
alter table files.files
  drop constraint files_purpose_valid,
  add constraint files_purpose_valid check (purpose in ('contact_export', 'record_file')) not valid;

-- A record's files ---------------------------------------------------------------------------------
-- A file uploaded to a record, to the record itself (a document) or to one of its file
-- upload fields. A file belongs to one record. Deleting a file field leaves its files with
-- the record, as its documents; a record that goes takes its links with it.

create table crm.record_files (
  business_id uuid not null,
  file_id uuid not null,
  record_id uuid not null,
  field_id uuid,
  created_by_kind text not null constraint record_files_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  primary key (business_id, file_id),
  foreign key (business_id, file_id) references files.files (business_id, id) on delete cascade,
  foreign key (business_id, record_id) references crm.records (business_id, id) on delete cascade,
  foreign key (business_id, field_id)
    references crm.field_definitions (business_id, id) on delete set null (field_id)
);
-- A record's files, newest first, as its Documents panel lists them.
create index record_files_record_idx on crm.record_files (business_id, record_id, created_at desc, file_id);
create index record_files_field_idx on crm.record_files (business_id, field_id, record_id)
  where field_id is not null;
call util.enable_tenant_rls('crm.record_files');
grant select, insert, delete on crm.record_files to crm_app;

-- A file taken off its record, by itself or with its record when the record is purged, is
-- deleted with it, in the same transaction: nothing else can reach it.
create function private.delete_record_file() returns trigger
language plpgsql set search_path = ''
as $$
begin
  update files.files set deleted_at = now(), public_key = null, folder_id = null
  where business_id = old.business_id and id = old.file_id and deleted_at is null;
  return null;
end
$$;
revoke execute on function private.delete_record_file() from public;
create trigger record_files_delete_file after delete on crm.record_files
  for each row execute function private.delete_record_file();

-- A deleted file's bytes are removed from storage by the worker once the deletion commits,
-- never before: a transaction that fails later leaves the bytes with their row. The job is
-- keyed by the file, so a file is queued once, and it runs in the file's own business.
create function private.queue_file_removal() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform graphile_worker.add_job(
    'files.remove_bytes',
    payload := jsonb_build_object(
      'agencyId', new.agency_id, 'businessId', new.business_id,
      'correlationId', coalesce(app.correlation_id(), uuidv7()), 'causationId', null,
      'data', jsonb_build_object('fileId', new.id)
    )::json,
    job_key := 'files.remove_bytes:' || new.id::text,
    job_key_mode := 'preserve_run_at'
  );
  return null;
end
$$;
revoke execute on function private.queue_file_removal() from public;
create trigger files_queue_removal after update of deleted_at on files.files
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.queue_file_removal();

-- Where a file is used: a record's files too, so the media library never deletes one.
create or replace function files.file_usage(p_file_id uuid)
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
  union all
  select 'contact_export' where exists (
    select 1 from crm.contact_bulk_actions where file_id = p_file_id)
  union all
  select 'record_file' where exists (
    select 1 from crm.record_files where file_id = p_file_id)
$$;
