-- Messaging: channel accounts (mailboxes, phone numbers, web chat), mailbox setup
-- checks, conversations, messages, consent and suppressions. See docs/EMAIL.md.

create schema messaging;

-- Provider accounts (Twilio, Telnyx) can be shared by the agency or owned by one business.
create table messaging.provider_connections (
  id uuid primary key default uuidv7(),
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  business_id uuid,
  provider text not null constraint provider_connections_provider_valid check (provider in ('twilio', 'telnyx')),
  label text not null constraint provider_connections_label_length check (length(btrim(label)) between 1 and 80),
  account_ref text not null,  -- the provider's account id (for example a Twilio Account SID); not secret
  secret_id uuid not null,
  status text not null default 'connected' constraint provider_connections_status_valid
    check (status in ('connected', 'failing', 'disconnected')),
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id) on delete cascade,
  foreign key (agency_id, secret_id) references vault.secrets (agency_id, id),
  constraint provider_connections_account_unique unique nulls not distinct (agency_id, business_id, provider, account_ref)
);
create index provider_connections_secret_idx on messaging.provider_connections (agency_id, secret_id);

-- Every sending identity is a channel account; messages reference it whatever the channel.
create table messaging.channel_accounts (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  channel text not null constraint channel_accounts_channel_valid check (channel in ('email', 'sms', 'webchat')),
  name text not null constraint channel_accounts_name_length check (length(btrim(name)) between 1 and 120),
  status text not null default 'active' constraint channel_accounts_status_valid
    check (status in ('active', 'paused', 'failing', 'disconnected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint channel_accounts_id_channel_unique unique (business_id, id, channel)
);

-- Any mailbox: the business's own server, a web host, a sending service, Google or
-- Microsoft. Passwords and OAuth refresh tokens live in vault.secrets.
create table messaging.mailboxes (
  business_id uuid not null,
  id uuid not null,
  channel text not null default 'email' constraint mailboxes_channel_fixed check (channel = 'email'),
  email_address text not null constraint mailboxes_email_format check (email_address ~ '^[^@\s]+@[^@\s]+$'),
  email_normalized text generated always as (lower(btrim(email_address))) stored,
  display_name text not null default '',
  auth_method text not null constraint mailboxes_auth_method_valid
    check (auth_method in ('password', 'google_oauth', 'microsoft_oauth')),
  smtp_host text,
  smtp_port integer constraint mailboxes_smtp_port_range check (smtp_port between 1 and 65535),
  smtp_security text constraint mailboxes_smtp_security_valid check (smtp_security in ('starttls', 'tls', 'none')),
  smtp_username text,
  imap_host text,
  imap_port integer constraint mailboxes_imap_port_range check (imap_port between 1 and 65535),
  imap_security text constraint mailboxes_imap_security_valid check (imap_security in ('starttls', 'tls', 'none')),
  imap_username text,
  secret_id uuid not null,
  use_for_conversations boolean not null default true,
  use_for_campaigns boolean not null default false,
  daily_limit integer not null default 300 constraint mailboxes_daily_limit_positive check (daily_limit > 0),
  warmup_enabled boolean not null default true,
  warmup_started_at timestamptz,
  -- IMAP sync position: UIDVALIDITY and the last UID read.
  imap_uid_validity bigint,
  imap_last_uid bigint,
  last_synced_at timestamptz,
  setup_score smallint constraint mailboxes_setup_score_range check (setup_score between 0 and 100),
  setup_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, id, channel) references messaging.channel_accounts (business_id, id, channel) on delete cascade,
  foreign key (business_id, secret_id) references vault.secrets (business_id, id),
  constraint mailboxes_email_unique unique (business_id, email_normalized),
  constraint mailboxes_password_needs_smtp check (
    auth_method <> 'password'
    or (smtp_host is not null and smtp_port is not null and smtp_security is not null and smtp_username is not null)),
  constraint mailboxes_imap_all_or_nothing check (
    (imap_host is null) = (imap_port is null) and (imap_host is null) = (imap_security is null))
);
create index mailboxes_secret_idx on messaging.mailboxes (business_id, secret_id);

create table messaging.mailbox_check_runs (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  mailbox_id uuid not null,
  trigger text not null constraint mailbox_check_runs_trigger_valid
    check (trigger in ('connect', 'manual', 'scheduled', 'bounce_spike')),
  -- How the test message was checked: the agency's check mailbox, the mailbox itself,
  -- or DNS only (docs/EMAIL.md section 5).
  method text not null constraint mailbox_check_runs_method_valid check (method in ('check_mailbox', 'self', 'dns_only')),
  score smallint constraint mailbox_check_runs_score_range check (score between 0 and 100),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (business_id, id),
  foreign key (business_id, mailbox_id) references messaging.mailboxes (business_id, id) on delete cascade,
  constraint mailbox_check_runs_score_when_finished check ((score is null) = (finished_at is null))
);
create index mailbox_check_runs_mailbox_idx on messaging.mailbox_check_runs (business_id, mailbox_id, started_at desc);

create table messaging.mailbox_check_results (
  business_id uuid not null,
  run_id uuid not null,
  check_key text not null constraint mailbox_check_results_key_valid check (check_key in (
    'connection', 'encryption', 'spf', 'dkim', 'dmarc', 'dmarc_enforcement',
    'reverse_dns', 'mx', 'blocklists', 'unsubscribe')),
  status text not null constraint mailbox_check_results_status_valid
    check (status in ('pass', 'fail', 'not_applicable', 'could_not_check')),
  points_awarded smallint not null constraint mailbox_check_results_awarded_nonnegative check (points_awarded >= 0),
  points_possible smallint not null constraint mailbox_check_results_possible_nonnegative check (points_possible >= 0),
  -- What was found, and the exact fix: record name, type and value, or who to ask.
  details jsonb not null default '{}' constraint mailbox_check_results_details_object check (jsonb_typeof(details) = 'object'),
  primary key (business_id, run_id, check_key),
  foreign key (business_id, run_id) references messaging.mailbox_check_runs (business_id, id) on delete cascade,
  constraint mailbox_check_results_points_bounded check (points_awarded <= points_possible)
);

create table messaging.phone_numbers (
  business_id uuid not null,
  id uuid not null,
  channel text not null default 'sms' constraint phone_numbers_channel_fixed check (channel = 'sms'),
  e164 text not null constraint phone_numbers_e164_format check (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  provider_connection_id uuid not null references messaging.provider_connections (id),
  provider_number_ref text not null,
  capabilities text[] not null default '{sms}' constraint phone_numbers_capabilities_valid
    check (cardinality(capabilities) > 0 and capabilities <@ array['sms', 'mms', 'voice']::text[]),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, id, channel) references messaging.channel_accounts (business_id, id, channel) on delete cascade,
  -- A number receives inbound messages for exactly one business in the install.
  constraint phone_numbers_e164_unique unique (e164)
);
create index phone_numbers_connection_idx on messaging.phone_numbers (provider_connection_id);

create table messaging.webchat_widgets (
  business_id uuid not null,
  id uuid not null,
  channel text not null default 'webchat' constraint webchat_widgets_channel_fixed check (channel = 'webchat'),
  public_key text not null constraint webchat_widgets_public_key_format check (public_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  allowed_origins text[] not null default '{}',
  settings jsonb not null default '{}' constraint webchat_widgets_settings_object check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, id, channel) references messaging.channel_accounts (business_id, id, channel) on delete cascade,
  constraint webchat_widgets_public_key_unique unique (public_key)
);

-- Conversations and messages ----------------------------------------------------------
-- One conversation per contact; its messages can arrive on any channel.

create table messaging.conversations (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  contact_id uuid not null,
  status text not null default 'open' constraint conversations_status_valid check (status in ('open', 'snoozed', 'closed')),
  assignee_user_id uuid references auth.users (id),
  snoozed_until timestamptz,
  needs_reply boolean not null default false,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  unread_count integer not null default 0 constraint conversations_unread_nonnegative check (unread_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade,
  constraint conversations_one_per_contact unique (business_id, contact_id),
  constraint conversations_snooze_complete check ((status = 'snoozed') = (snoozed_until is not null))
);
create index conversations_inbox_idx on messaging.conversations (business_id, status, last_message_at desc);
create index conversations_assignee_idx on messaging.conversations (assignee_user_id, business_id, status);

create table messaging.messages (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  conversation_id uuid not null,
  channel text not null constraint messages_channel_valid check (channel in ('email', 'sms', 'webchat', 'note')),
  channel_account_id uuid,  -- NULL only for internal notes
  direction text not null constraint messages_direction_valid check (direction in ('inbound', 'outbound', 'internal')),
  status text not null constraint messages_status_valid check (status in (
    'received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'bounced')),
  subject text,
  body_text text not null default '',
  body_html text,
  from_address text,
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  bcc_addresses text[] not null default '{}',
  email_message_id text,  -- the Message-ID header
  in_reply_to text,
  email_references text[] not null default '{}',
  provider_message_id text,
  -- Every outbound message carries one, so a retried job can never send twice.
  idempotency_key text,
  -- 0: replies and transactional, 1: automations, 2: campaigns. Lower goes first.
  priority smallint not null default 0 constraint messages_priority_range check (priority between 0 and 2),
  scheduled_for timestamptz,  -- held for quiet hours or a chosen send time
  author_kind text not null constraint messages_author_kind_valid
    check (author_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  author_id uuid,
  proposal_id uuid,  -- the assistant's draft it came from; FK added with the ai schema
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  search tsvector generated always as (
    to_tsvector('simple', coalesce(subject, '') || ' ' || left(body_text, 100000))) stored,
  primary key (business_id, id),
  foreign key (business_id, conversation_id) references messaging.conversations (business_id, id) on delete cascade,
  -- The account must be of the message's channel.
  foreign key (business_id, channel_account_id, channel)
    references messaging.channel_accounts (business_id, id, channel),
  constraint messages_note_is_internal check ((channel = 'note') = (direction = 'internal')),
  constraint messages_account_unless_note check (channel = 'note' or channel_account_id is not null),
  constraint messages_inbound_status check ((direction = 'inbound') = (status = 'received')),
  constraint messages_outbound_has_idempotency_key check (direction <> 'outbound' or idempotency_key is not null)
);
create index messages_conversation_idx on messaging.messages (business_id, conversation_id, created_at desc);
create index messages_channel_account_idx on messaging.messages (business_id, channel_account_id, channel);
create unique index messages_idempotency_idx on messaging.messages (business_id, idempotency_key)
  where idempotency_key is not null;
-- An IMAP re-sync or a repeated provider webhook can't insert the same message twice.
create unique index messages_inbound_email_dedupe_idx
  on messaging.messages (business_id, channel_account_id, email_message_id)
  where direction = 'inbound' and email_message_id is not null;
create unique index messages_provider_message_idx
  on messaging.messages (business_id, channel_account_id, provider_message_id)
  where provider_message_id is not null;
create index messages_email_thread_idx on messaging.messages (business_id, email_message_id)
  where email_message_id is not null;
create index messages_search_idx on messaging.messages using gin (search);

create table messaging.message_attachments (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  message_id uuid not null,
  file_id uuid not null,
  content_id text,  -- set for inline images
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, message_id) references messaging.messages (business_id, id) on delete cascade,
  foreign key (business_id, file_id) references files.files (business_id, id)
);
create index message_attachments_message_idx on messaging.message_attachments (business_id, message_id);
create index message_attachments_file_idx on messaging.message_attachments (business_id, file_id);

-- Consent and suppression ---------------------------------------------------------------
-- Consent is an append-only ledger per contact, channel and purpose; the latest row is
-- the current state, and its proof (form, keyword, IP, link) is kept with it.
-- Suppressions are per address: hard bounces, complaints and invalid numbers, which
-- stop sending whoever the address belongs to.

create table messaging.consents (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  contact_id uuid not null,
  channel text not null constraint consents_channel_valid check (channel in ('email', 'sms', 'whatsapp', 'call')),
  purpose text not null constraint consents_purpose_valid check (purpose in ('marketing', 'transactional')),
  status text not null constraint consents_status_valid check (status in ('granted', 'withdrawn')),
  source text not null constraint consents_source_valid
    check (source in ('form', 'keyword', 'unsubscribe_link', 'booking', 'import', 'api', 'user')),
  proof jsonb not null default '{}' constraint consents_proof_object check (jsonb_typeof(proof) = 'object'),
  recorded_at timestamptz not null default now(),
  recorded_by_kind text not null,
  recorded_by_id uuid,
  primary key (business_id, id),
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade
);
create index consents_current_idx on messaging.consents (business_id, contact_id, channel, purpose, recorded_at desc);

create table messaging.suppressions (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  channel text not null constraint suppressions_channel_valid check (channel in ('email', 'sms')),
  address_normalized text not null,
  reason text not null constraint suppressions_reason_valid
    check (reason in ('hard_bounce', 'complaint', 'unsubscribe', 'invalid', 'manual')),
  source_message_id uuid,
  detail text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  primary key (business_id, id),
  foreign key (business_id, source_message_id)
    references messaging.messages (business_id, id) on delete set null (source_message_id),
  constraint suppressions_address_unique unique (business_id, channel, address_normalized)
);
create index suppressions_source_message_idx on messaging.suppressions (business_id, source_message_id);

create table messaging.settings (
  business_id uuid primary key references tenancy.businesses (id) on delete cascade,
  quiet_hours_enabled boolean not null default true,
  quiet_hours_start time not null default '21:00',
  quiet_hours_end time not null default '08:00',
  updated_at timestamptz not null default now()
);

call util.add_updated_at_trigger('messaging.provider_connections');
call util.add_updated_at_trigger('messaging.channel_accounts');
call util.add_updated_at_trigger('messaging.mailboxes');
call util.add_updated_at_trigger('messaging.phone_numbers');
call util.add_updated_at_trigger('messaging.webchat_widgets');
call util.add_updated_at_trigger('messaging.conversations');
call util.add_updated_at_trigger('messaging.settings');

call util.enable_scoped_rls('messaging.provider_connections');
call util.enable_tenant_rls('messaging.channel_accounts');
call util.enable_tenant_rls('messaging.mailboxes');
call util.enable_tenant_rls('messaging.mailbox_check_runs');
call util.enable_tenant_rls('messaging.mailbox_check_results');
call util.enable_tenant_rls('messaging.phone_numbers');
call util.enable_tenant_rls('messaging.webchat_widgets');
call util.enable_tenant_rls('messaging.conversations');
call util.enable_tenant_rls('messaging.messages');
call util.enable_tenant_rls('messaging.message_attachments');
call util.enable_tenant_rls('messaging.consents');
call util.enable_tenant_rls('messaging.suppressions');
call util.enable_tenant_rls('messaging.settings');
