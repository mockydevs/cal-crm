-- Call recordings' audio, kept as the business's own files (Phone System stage PS5). The
-- worker downloads a completed recording from the provider and keeps it as a private file:
-- reachable only through the recording's own link, never the general link of a file or the
-- media library.
alter table files.files
  drop constraint files_purpose_valid,
  add constraint files_purpose_valid
    check (purpose in ('contact_export', 'record_file', 'call_recording')) not valid;

alter table messaging.call_recordings
  add column file_id uuid,
  -- Why the audio could not be kept, when it couldn't: the provider no longer has it, or it
  -- was larger than a file may be. Plain words for people, never the provider's raw answer.
  add column fetch_failure text
    constraint call_recordings_fetch_failure_valid check (fetch_failure in ('not_found', 'too_large')),
  add constraint call_recordings_file foreign key (file_id) references files.files (id) on delete set null,
  add constraint call_recordings_file_or_failure check (file_id is null or fetch_failure is null);
create index call_recordings_file_idx on messaging.call_recordings (file_id) where file_id is not null;
