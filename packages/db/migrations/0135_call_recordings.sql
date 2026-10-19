-- Call recordings (Phone System stage PS5): one row for every recording the provider reports
-- on a call, a recorded conversation or a voicemail. The audio stays with the provider until
-- the worker fetches it into the business's files; only the provider's recording id is kept
-- here, never its address. A repeated report finds the same row.
create table messaging.call_recordings (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  call_id uuid not null,
  provider_connection_id uuid not null,
  provider_recording_sid text not null
    constraint call_recordings_sid_format check (provider_recording_sid ~ '^RE[0-9a-fA-F]{32}$'),
  kind text not null constraint call_recordings_kind_valid check (kind in ('call', 'voicemail')),
  status text not null
    constraint call_recordings_status_valid check (status in ('in-progress', 'completed', 'absent')),
  duration_seconds integer constraint call_recordings_duration_range check (duration_seconds >= 0),
  channels smallint constraint call_recordings_channels_valid check (channels in (1, 2)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint call_recordings_call foreign key (business_id, call_id)
    references messaging.calls (business_id, id) on delete cascade,
  constraint call_recordings_connection foreign key (business_id, provider_connection_id)
    references messaging.provider_connections (business_id, id),
  constraint call_recordings_sid_unique unique (provider_connection_id, provider_recording_sid),
  constraint call_recordings_duration_completed check (duration_seconds is null or status = 'completed')
);
create index call_recordings_call_idx on messaging.call_recordings (business_id, call_id);
create index call_recordings_connection_idx on messaging.call_recordings (business_id, provider_connection_id);
call util.add_updated_at_trigger('messaging.call_recordings');
call util.enable_tenant_rls('messaging.call_recordings');
grant select, insert, update on messaging.call_recordings to crm_app;

comment on table messaging.call_recordings is
  'Recordings the provider reported on a call: recorded conversations and voicemails. The audio is fetched by the worker; its address is never stored.';
