-- Phone System settings (ADR-108, docs/phone-system-study.md milestones 1 and 2). How the
-- business wants calls handled, and each registered number's name, owner, routing,
-- recording and advanced options. Nothing here places, answers or records a call: the
-- voice transport reads these settings when it is built. Numbers stay the ones a business
-- registers from its own Twilio account (0044); nothing here buys or reconfigures one at
-- the provider.

-- 1. The business's calling defaults: one row, written on the first save. Before that the
--    column defaults below apply, and the API answers them.
create table messaging.phone_system_settings (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  -- The number calls go out from when nothing else chooses one. Forgetting the number
  -- forgets the choice.
  default_phone_number_id uuid,
  -- Inbound: ring the person the called number is assigned to before anyone else.
  inbound_prefer_assigned_user boolean not null default true,
  -- Inbound: let callers who hide their number through.
  inbound_allow_anonymous boolean not null default true,
  -- Inbound: where a number set to fall back forwards a call nobody took.
  inbound_fallback_e164 text
    constraint phone_system_settings_fallback_format check (inbound_fallback_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- Outbound: which number a call shows when the person calling doesn't pick one.
  outbound_caller_id text not null default 'account_default'
    constraint phone_system_settings_caller_id_valid
    check (outbound_caller_id in ('account_default', 'user_assigned', 'local_presence')),
  -- Outbound: connect the person calling before or after the recording announcement plays.
  outbound_connect_agent text not null default 'after_announcement'
    constraint phone_system_settings_connect_agent_valid
    check (outbound_connect_agent in ('before_announcement', 'after_announcement')),
  -- Outbound: warn before calling a contact during their quiet hours.
  outbound_quiet_hours_warning boolean not null default true,
  -- Recordings older than this many days are deleted; null keeps them.
  recording_retention_days integer
    constraint phone_system_settings_retention_range check (recording_retention_days between 1 and 3650),
  transcription_enabled boolean not null default false,
  -- One text to the caller after a missed call, through the outbound pipeline's checks.
  missed_call_text_enabled boolean not null default false,
  missed_call_text text
    constraint phone_system_settings_missed_call_text_length
    check (char_length(missed_call_text) between 1 and 640),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id),
  constraint phone_system_settings_default_number foreign key (business_id, default_phone_number_id)
    references messaging.phone_numbers (business_id, id) on delete set null (default_phone_number_id),
  constraint phone_system_settings_missed_call_text_needed
    check (not missed_call_text_enabled or missed_call_text is not null)
);
create index phone_system_settings_default_number_idx
  on messaging.phone_system_settings (business_id, default_phone_number_id);
call util.add_updated_at_trigger('messaging.phone_system_settings');
call util.enable_tenant_rls('messaging.phone_system_settings');
grant select, insert, update on messaging.phone_system_settings to crm_app;

comment on table messaging.phone_system_settings is
  'A business''s calling defaults (ADR-108). No row means the column defaults.';

-- 2. Each number's own settings: one row, written on the first save; the number's name
--    stays in messaging.channel_accounts. Routing keeps the order a call is offered in
--    apart from who rings at the same time (docs/phone-system-study.md): the primary
--    person, then an outside number, then the business fallback, with up to six more
--    people ringing alongside the primary, and voicemail when nobody answers. People are
--    stored as users; one who leaves the business stays here and the API reports them as
--    no longer on the team, so a routing change is never made without someone saving it.
create table messaging.phone_number_settings (
  business_id uuid not null,
  phone_number_id uuid not null,
  owner_user_id uuid references auth.users (id) on delete set null,
  recording_enabled boolean not null default false,
  recording_announcement_enabled boolean not null default false,
  recording_announcement text
    constraint phone_number_settings_announcement_length
    check (char_length(recording_announcement) between 1 and 500),
  primary_user_id uuid references auth.users (id) on delete set null,
  forward_to_e164 text
    constraint phone_number_settings_forward_format check (forward_to_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  use_business_fallback boolean not null default false,
  ring_also_user_ids uuid[] not null default '{}'
    constraint phone_number_settings_ring_also_size check (cardinality(ring_also_user_ids) <= 6),
  ring_timeout_seconds integer not null default 20
    constraint phone_number_settings_ring_timeout_range check (ring_timeout_seconds between 5 and 120),
  voicemail_backup boolean not null default true,
  call_connect_confirmation boolean not null default false,
  whisper_enabled boolean not null default false,
  whisper_message text
    constraint phone_number_settings_whisper_length check (char_length(whisper_message) between 1 and 500),
  -- What a forwarded call shows the person it is forwarded to.
  forwarded_caller_id text not null default 'caller'
    constraint phone_number_settings_forwarded_caller_id_valid
    check (forwarded_caller_id in ('caller', 'business_number')),
  -- Ring the calling contact's owner before the number's own routing.
  prefer_contact_owner boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, phone_number_id),
  foreign key (business_id, phone_number_id)
    references messaging.phone_numbers (business_id, id) on delete cascade,
  constraint phone_number_settings_announcement_needed
    check (not recording_announcement_enabled or (recording_enabled and recording_announcement is not null)),
  constraint phone_number_settings_whisper_needed
    check (not whisper_enabled or whisper_message is not null)
);
create index phone_number_settings_owner_idx on messaging.phone_number_settings (owner_user_id);
create index phone_number_settings_primary_idx on messaging.phone_number_settings (primary_user_id);
call util.add_updated_at_trigger('messaging.phone_number_settings');
call util.enable_tenant_rls('messaging.phone_number_settings');
grant select, insert, update on messaging.phone_number_settings to crm_app;

comment on table messaging.phone_number_settings is
  'A registered number''s name-independent settings: owner, routing, recording and advanced options (ADR-108).';
