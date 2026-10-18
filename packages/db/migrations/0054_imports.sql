-- B1.05 and B1.06: importing records from a CSV file, and the history of imports (ADR-062).
--
-- 0011 made imports.jobs and imports.id_map for the GoHighLevel import (P1.72), and no
-- release has written either. An import from a file is the same thing from another source,
-- so imports.jobs becomes the one record of every import, whatever it reads from, and gains
-- what running one in the background and showing it afterwards need:
--   * what it imports: the kinds of object, the file, and how the file's columns are mapped;
--   * how far it got: the rows found, the rows dealt with and the count of each outcome.
--     These are columns, not keys of stats, because the history list shows and filters them;
--   * who started it, whether someone asked for it to stop, and which run of the job is
--     working it, with the time that run last made progress.
-- imports.job_rows is new: what became of each row of the file.

alter table imports.jobs
  add column objects text[] not null default '{contact}'
    constraint jobs_objects_valid
      check (cardinality(objects) >= 1 and objects <@ array['contact', 'company', 'deal']),
  add column created_by_kind text not null default 'system'
    constraint jobs_created_by_kind_valid
      check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  add column file_id uuid,
  add column file_name text
    constraint jobs_file_name_length check (length(file_name) between 1 and 255),
  add column error_file_id uuid,
  add column mapping jsonb not null default '[]'
    constraint jobs_mapping_array check (jsonb_typeof(mapping) = 'array'),
  add column row_count integer not null default 0,
  add column processed_count integer not null default 0,
  add column created_count integer not null default 0,
  add column updated_count integer not null default 0,
  add column skipped_count integer not null default 0,
  add column failed_count integer not null default 0,
  add column error_code text
    constraint jobs_error_code_format check (error_code ~ '^[a-z][a-z0-9_]*$'),
  add column cancel_requested_at timestamptz,
  add column runner uuid,
  add column heartbeat_at timestamptz;

-- No release ever wrote an import: nothing in the product inserted one. A row that is here
-- was written by hand. It is kept, and brought within the rules below: one still waiting
-- or running is closed as cancelled, since no job will ever run it; each gets the times
-- its status calls for; a failure is named unknown; a CSV import is given a file name.
update imports.jobs set
  status = case when status in ('pending', 'running') then 'cancelled' else status end,
  started_at = case when status = 'completed' then coalesce(started_at, created_at) else started_at end,
  finished_at = coalesce(finished_at, started_at, created_at),
  error_code = case when status = 'failed' then 'unknown' end,
  file_name = case when source = 'csv' then 'import.csv' end,
  error = left(error, 2000);

alter table imports.jobs
  add constraint jobs_counts_nonnegative check (
    row_count >= 0 and processed_count >= 0 and created_count >= 0 and updated_count >= 0
    and skipped_count >= 0 and failed_count >= 0),
  -- Every row dealt with has exactly one outcome, and no row is dealt with twice.
  add constraint jobs_counts_add_up
    check (processed_count = created_count + updated_count + skipped_count + failed_count),
  add constraint jobs_processed_within_rows check (processed_count <= row_count),
  -- A mapping lists a file's columns and the options are a handful of choices; no writer
  -- may store an unbounded document in either.
  add constraint jobs_mapping_bounded check (octet_length(mapping::text) <= 131072),
  add constraint jobs_settings_bounded check (octet_length(settings::text) <= 16384),
  add constraint jobs_error_length check (length(error) <= 2000),
  add constraint jobs_csv_names_its_file check (source <> 'csv' or file_name is not null),
  add constraint jobs_finished_when_done
    check ((status in ('completed', 'failed', 'cancelled')) = (finished_at is not null)),
  add constraint jobs_started_when_run
    check (status not in ('running', 'completed') or started_at is not null),
  add constraint jobs_failure_is_named check ((status = 'failed') = (error_code is not null)),
  -- A waiting or running import always says when it last made progress: that is how one
  -- whose worker died is found again (private.stalled_imports).
  add constraint jobs_active_has_heartbeat
    check (status not in ('pending', 'running') or heartbeat_at is not null),
  -- The file belongs to the import's own business. Deleting a file leaves the record of
  -- the import, with the name the file had.
  add constraint jobs_file_fkey foreign key (business_id, file_id)
    references files.files (business_id, id) on delete set null (file_id),
  add constraint jobs_error_file_fkey foreign key (business_id, error_file_id)
    references files.files (business_id, id) on delete set null (error_file_id);

create index jobs_file_idx on imports.jobs (business_id, file_id);
create index jobs_error_file_idx on imports.jobs (business_id, error_file_id);

comment on column imports.jobs.objects is
  'The kinds of object the import writes. A CSV import writes one kind; an import from another product writes several.';
comment on column imports.jobs.mapping is
  'How the source''s columns were mapped, as the import was started with: an array, one entry for each column, in the file''s order.';
comment on column imports.jobs.settings is
  'The choices the import was started with: what to do with a row whose contact exists, the tags to add, and the like.';
comment on column imports.jobs.row_count is
  'The rows found to import. processed_count is how many have been dealt with, each with exactly one outcome.';
comment on column imports.jobs.runner is
  'The run of the job that is working the import. A run that finds another run''s mark stops, so two never apply rows side by side.';
comment on column imports.jobs.heartbeat_at is
  'When the import last made progress: queued, or a batch of rows committed.';

-- One import waits or runs in a business at a time. Two would write the same contacts
-- side by side, and each would report the other's rows as already there.
create unique index jobs_one_active_idx on imports.jobs (business_id)
  where status in ('pending', 'running');
-- The imports whose worker may have died, for the sweep.
create index jobs_active_heartbeat_idx on imports.jobs (heartbeat_at)
  where status in ('pending', 'running');

-- An import only ever moves forward: waiting to running, and either to an end; its counts
-- only grow; what it was started with never changes; and once it has ended nothing changes
-- but its files being deleted. The command layer holds the same rules; this is the
-- backstop a bug or a hand-written update meets, and what makes "no row applied twice"
-- something the database refuses rather than something the code promises.
create function private.guard_import_job_change() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.business_id is distinct from old.business_id or new.id is distinct from old.id
    or new.source is distinct from old.source or new.objects is distinct from old.objects
    or new.created_at is distinct from old.created_at
    or new.created_by_kind is distinct from old.created_by_kind
    or new.created_by_id is distinct from old.created_by_id
    or new.mapping is distinct from old.mapping or new.settings is distinct from old.settings
    or new.file_name is distinct from old.file_name
    or (new.file_id is not null and new.file_id is distinct from old.file_id)
  then
    raise exception 'what an import was started with never changes'
      using errcode = 'check_violation', constraint = 'jobs_start_fixed';
  end if;
  if old.status in ('completed', 'failed', 'cancelled') then
    if (pg_catalog.to_jsonb(new) - 'file_id' - 'error_file_id')
        is distinct from (pg_catalog.to_jsonb(old) - 'file_id' - 'error_file_id')
      or new.error_file_id is not null and new.error_file_id is distinct from old.error_file_id
    then
      raise exception 'a finished import is not changed'
        using errcode = 'check_violation', constraint = 'jobs_finished_fixed';
    end if;
    return new;
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'pending' and new.status in ('running', 'failed', 'cancelled'))
    or (old.status = 'running' and new.status in ('completed', 'failed', 'cancelled'))
  ) then
    raise exception 'an import cannot go from % to %', old.status, new.status
      using errcode = 'check_violation', constraint = 'jobs_status_forward';
  end if;
  if new.processed_count < old.processed_count or new.created_count < old.created_count
    or new.updated_count < old.updated_count or new.skipped_count < old.skipped_count
    or new.failed_count < old.failed_count
  then
    raise exception 'an import''s counts never go back'
      using errcode = 'check_violation', constraint = 'jobs_counts_forward';
  end if;
  return new;
end
$$;
revoke execute on function private.guard_import_job_change() from public;

create trigger jobs_guard_change
  before update on imports.jobs
  for each row execute function private.guard_import_job_change();

-- What became of each row of the file, written in the transaction that applied the row.
-- - The key is the import and the row's number in the file, so a row can be recorded once:
--   applying it a second time is refused by the database, whatever the code does.
-- - record_id is the record the row made or changed. One record is written by one row of
--   an import; a later row that turns out to be the same record is skipped.
-- - code and detail say why a row was skipped or failed. Neither holds anything the row
--   contained: the error file is made from these and the source file, and nothing of the
--   file's contents is kept here.
create table imports.job_rows (
  business_id uuid not null,
  job_id uuid not null,
  row_number integer not null
    constraint job_rows_row_number_positive check (row_number >= 1),
  outcome text not null
    constraint job_rows_outcome_valid check (outcome in ('created', 'updated', 'skipped', 'failed')),
  record_id uuid,
  code text constraint job_rows_code_format check (code ~ '^[a-z][a-z0-9_]*$'),
  detail text constraint job_rows_detail_length check (length(detail) between 1 and 2000),
  created_at timestamptz not null default now(),
  primary key (business_id, job_id, row_number),
  foreign key (business_id, job_id) references imports.jobs (business_id, id) on delete cascade,
  -- Purging the record leaves the row's outcome, without the record.
  foreign key (business_id, record_id) references crm.records (business_id, id)
    on delete set null (record_id),
  constraint job_rows_reason_when_not_written
    check ((outcome in ('skipped', 'failed')) = (code is not null)),
  constraint job_rows_reason_complete check ((code is null) = (detail is null)),
  constraint job_rows_record_only_when_written
    check (record_id is null or outcome in ('created', 'updated'))
);
-- One row of an import writes a record; it also serves the record's foreign key.
create unique index job_rows_one_write_per_record_idx
  on imports.job_rows (business_id, record_id, job_id) where record_id is not null;
-- The rows the error file lists, in the file's order.
create index job_rows_not_imported_idx
  on imports.job_rows (business_id, job_id, row_number) where outcome in ('skipped', 'failed');

call util.enable_tenant_rls('imports.job_rows');
-- Append-only for the application: an outcome is recorded once and never rewritten.
grant select, insert on imports.job_rows to crm_app;

-- Imports that wait or run and have made no progress for a while, in every business: their
-- worker died, or their job was lost. The worker then queues each again inside its own
-- business. Ids only.
create function private.stalled_imports(p_stale_after interval, p_limit integer)
returns table (agency_id uuid, business_id uuid, job_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, j.business_id, j.id
  from imports.jobs j
  join tenancy.businesses b on b.id = j.business_id
  where j.status in ('pending', 'running')
    and j.source = 'csv'
    and j.heartbeat_at < pg_catalog.now() - p_stale_after
  order by j.heartbeat_at
  limit p_limit
$$;
revoke execute on function private.stalled_imports(interval, integer) from public;
grant execute on function private.stalled_imports(interval, integer) to crm_app;
