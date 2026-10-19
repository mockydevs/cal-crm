-- Tenant isolation, end to end. Seeds two agencies and three businesses through the
-- crm_app role (so every write also passes the policies' WITH CHECK), puts a row in every
-- tenant table, then proves that no context can see or write rows outside its scope.

\set ON_ERROR_STOP on
set client_min_messages = notice;

\set a1 'aaaaaaa1-0000-7000-8000-000000000000'
\set a2 'aaaaaaa2-0000-7000-8000-000000000000'
\set b1 'bbbbbbb1-0000-7000-8000-000000000000'
\set b2 'bbbbbbb2-0000-7000-8000-000000000000'
\set b3 'bbbbbbb3-0000-7000-8000-000000000000'
\set u1 'eeeeeee1-0000-7000-8000-000000000000'
\set u2 'eeeeeee2-0000-7000-8000-000000000000'
\set u3 'eeeeeee3-0000-7000-8000-000000000000'
\set role_agency_a1 'cccccc01-0000-7000-8000-000000000000'
\set role_business_a1 'cccccc02-0000-7000-8000-000000000000'
\set role_agency_a2 'cccccc03-0000-7000-8000-000000000000'

-- The same ids, readable inside DO blocks.
set test.a1 = :'a1';
set test.a2 = :'a2';
set test.b1 = :'b1';
set test.b2 = :'b2';
set test.b3 = :'b3';
set test.u1 = :'u1';
set test.u2 = :'u2';
set test.role_business_a1 = :'role_business_a1';

-- 1. What the installer creates, as crm_owner -------------------------------------------

set role crm_owner;

insert into tenancy.agencies (id, name, slug) values
  (:'a1', 'Bluebird Digital', 'bluebird'),
  (:'a2', 'Another Agency', 'another');
insert into tenancy.businesses (id, agency_id, name, slug, currency) values
  (:'b1', :'a1', 'Harbor Lights Events', 'harbor-lights', 'USD'),
  (:'b2', :'a1', 'Second Business', 'second', 'USD'),
  (:'b3', :'a2', 'Third Business', 'third', 'KES');
insert into auth.users (id, email, name) values
  (:'u1', 'owner@bluebird.example', 'Agency Owner'),
  (:'u2', 'dana@harborlights.example', 'Dana Brooks'),
  (:'u3', 'staff@another.example', 'Another Agency Staff');
insert into tenancy.roles (id, agency_id, scope, key, name, is_builtin) values
  (:'role_agency_a1', :'a1', 'agency', 'owner', 'Owner', true),
  (:'role_business_a1', :'a1', 'business', 'owner', 'Owner', true),
  (:'role_agency_a2', :'a2', 'agency', 'owner', 'Owner', true);
insert into tenancy.memberships (user_id, agency_id, business_id, role_id) values
  (:'u1', :'a1', null, :'role_agency_a1'),
  (:'u2', :'a1', :'b1', :'role_business_a1'),
  (:'u3', :'a2', null, :'role_agency_a2');

reset role;

-- 2. Business 1: one row in every tenant table, written as crm_app --------------------------

set role crm_app;
set app.agency_id = :'a1';
set app.business_id = :'b1';
set app.user_id = :'u2';
set app.actor_kind = 'user';
set app.actor_id = :'u2';

do $$
declare
  a constant uuid := current_setting('test.a1');
  b constant uuid := current_setting('test.b1');
  u constant uuid := current_setting('test.u2');
  business_role constant uuid := current_setting('test.role_business_a1');
  ot_contact uuid;
  ot_company uuid;
  ot_deal uuid;
  ot_event uuid := uuidv7();
  field_event_name uuid := uuidv7();
  contact_1 uuid := uuidv7();
  company_1 uuid := uuidv7();
  deal_1 uuid := uuidv7();
  event_record uuid := uuidv7();
  pipeline_1 uuid;
  stage_new uuid;
  field_event_date uuid;
  field_services uuid;
  field_folder uuid;
  value_folder uuid;
  tag_group uuid;
  tag_wedding uuid;
  link_deal_contact uuid;
  business_secret uuid;
  webhook_secret uuid;
  logo uuid;
  connection uuid;
  email_account uuid := uuidv7();
  sms_account uuid := uuidv7();
  chat_account uuid := uuidv7();
  chat_session uuid := uuidv7();
  chat_message uuid;
  check_run uuid;
  conversation uuid;
  outbound uuid;
  outbound_sms uuid;
  inbound uuid;
  cal uuid;
  form uuid;
  automation_1 uuid;
  version_1 uuid;
  email_binding uuid;
  enrolment uuid;
  request uuid;
  proposal uuid;
  event_id uuid;
  assistant_thread uuid;
  marketplace_app uuid;
  marketplace_install uuid;
  assistant_turn uuid;
  event_at timestamptz;
  import_job uuid;
begin
  insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
    values (b, 'contact', 'contact', 'Contact', 'Contacts') returning id into ot_contact;
  insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
    values (b, 'company', 'company', 'Company', 'Companies') returning id into ot_company;
  insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
    values (b, 'deal', 'deal', 'Deal', 'Deals') returning id into ot_deal;
  -- A custom object names its primary field when it is made, and the field follows in the
  -- same transaction (0128). Its name is unique among the business's events.
  insert into crm.object_types (business_id, id, kind, key, singular_label, plural_label, description,
                                icon, primary_field_id, created_by_kind, created_by_id)
    values (b, ot_event, 'custom', 'event', 'Event', 'Events', 'An event we are planning.',
            'calendar', field_event_name, 'user', u);
  insert into crm.field_definitions (business_id, id, object_type_id, key, label, value_type,
                                     is_unique, is_searchable, created_by_kind)
    values (b, field_event_name, ot_event, 'name', 'Event name', 'text', true, true, 'user');

  insert into crm.records (business_id, id, kind, object_type_id) values
    (b, contact_1, 'contact', ot_contact),
    (b, company_1, 'company', ot_company),
    (b, deal_1, 'deal', ot_deal),
    (b, event_record, 'custom', ot_event);
  insert into crm.contacts (business_id, id, first_name, last_name, owner_user_id, created_by_kind, created_by_id)
    values (b, contact_1, 'Jordan', 'Lee', u, 'user', u);
  insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, is_primary) values
    (b, contact_1, 'email', 'Jordan@Example.com', 'jordan@example.com', true),
    (b, contact_1, 'phone', '(415) 555-0123', '+14155550123', true);
  -- Who follows the contact beside its owner (0059).
  insert into crm.contact_followers (business_id, contact_id, user_id, added_by_kind, added_by_id)
    values (b, contact_1, u, 'user', u);
  -- A bulk action started on the contact, and what became of it (0063).
  with started as (
    insert into crm.contact_bulk_actions (business_id, action, status, requested_count, done_count,
                                          actor_kind, actor_id, started_at, finished_at)
      values (b, 'trash', 'completed', 1, 1, 'user', u, now(), now()) returning id
  )
  insert into crm.contact_bulk_action_items (business_id, bulk_action_id, position, contact_id, outcome)
    select b, id, 1, contact_1, 'done' from started;
  insert into crm.companies (business_id, id, name, domain, created_by_kind)
    values (b, company_1, 'Lee Family', 'leefamily.example', 'user');

  insert into crm.pipelines (business_id, name) values (b, 'Weddings') returning id into pipeline_1;
  insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
    values (b, pipeline_1, 'New lead', 0) returning id into stage_new;
  insert into crm.pipeline_stages (business_id, pipeline_id, name, position) values (b, pipeline_1, 'Booked', 1);
  insert into crm.lost_reasons (business_id, label) values (b, 'Chose another planner');
  insert into crm.deals (business_id, id, name, pipeline_id, stage_id, amount, currency, owner_user_id, created_by_kind)
    values (b, deal_1, 'Lee wedding', pipeline_1, stage_new, 12000, 'USD', u, 'user');
  insert into crm.deal_stage_history (business_id, deal_id, pipeline_id, stage_id, entered_at, entered_by_kind)
    values (b, deal_1, pipeline_1, stage_new, now(), 'user');
  -- Who follows the deal beside its owner, and a bulk action run on it (0062).
  insert into crm.deal_followers (business_id, deal_id, user_id, added_by_kind, added_by_id)
    values (b, deal_1, u, 'user', u);
  insert into crm.bulk_actions (business_id, object_kind, action, requested_count, done_count,
                                unchanged_count, skipped_count, actor_kind, actor_id)
    values (b, 'deal', 'set_status', 1, 1, 0, 0, 'user', u);
  insert into crm.custom_records (business_id, id, title, created_by_kind)
    values (b, event_record, 'Lee wedding, 12 June', 'user');
  -- Its primary field's value: the title follows it, and the value takes its place in the
  -- ledger of unique values (0128).
  insert into crm.field_values (business_id, record_id, field_id, value_type, value_text, source_kind, source_id)
    values (b, event_record, field_event_name, 'text', 'Lee wedding, 12 June', 'user', u);

  insert into crm.field_definitions (business_id, object_type_id, key, label, description, value_type, created_by_kind)
    values (b, ot_deal, 'event_date', 'Event date', 'The day of the event, not the day they booked.', 'date', 'user')
    returning id into field_event_date;
  insert into crm.field_definitions (business_id, object_type_id, key, label, value_type, options, created_by_kind)
    values (b, ot_deal, 'services_wanted', 'Services wanted', 'multi_choice',
            '[{"key": "opt_planning", "label": "Planning"}, {"key": "opt_lighting", "label": "Lighting"}]', 'user')
    returning id into field_services;
  -- 0053: every object type above already has its system field folder. A folder the
  -- business made holds one of its fields, and a custom value sits in a folder of its own.
  insert into crm.field_folders (business_id, object_type_id, name, created_by_kind, created_by_id)
    values (b, ot_deal, 'Event details', 'user', u) returning id into field_folder;
  update crm.field_definitions set folder_id = field_folder where id = field_event_date;
  insert into crm.custom_value_folders (business_id, name, created_by_kind, created_by_id)
    values (b, 'Links', 'user', u) returning id into value_folder;
  insert into crm.custom_values (business_id, key, name, value, folder_id, created_by_kind, created_by_id)
    values (b, 'sample_reel_url', 'Sample reel URL', 'https://harborlights.example/reel', value_folder, 'user', u);
  -- 0096: a lead source rule of the business's own.
  insert into crm.lead_source_rules (business_id, position, name, conditions, source_label, created_by_kind, created_by_id)
    values (b, 1, 'Spring campaign', '[{"fact": "utm_campaign", "op": "contains", "value": "spring"}]',
            'Spring promo', 'user', u);
  insert into crm.field_key_aliases (business_id, object_type_id, alias_key, field_id)
    values (b, ot_deal, 'wedding_date', field_event_date);
  insert into crm.field_values (business_id, record_id, field_id, value_type, value_date, source_kind, source_id)
    values (b, deal_1, field_event_date, 'date', date '2027-06-12', 'user', u);
  insert into crm.field_values (business_id, record_id, field_id, value_type, value_options, source_kind, confidence)
    values (b, deal_1, field_services, 'multi_choice', array['opt_planning', 'opt_lighting'], 'ai_agent', 0.86);

  insert into crm.tag_groups (business_id, name) values (b, 'Event type') returning id into tag_group;
  insert into crm.tags (business_id, name, group_id, description, created_by_kind)
    values (b, 'Wedding', tag_group, 'Planning a wedding or rehearsal dinner.', 'user') returning id into tag_wedding;
  insert into crm.record_tags (business_id, record_id, tag_id, source_kind, source_id)
    values (b, contact_1, tag_wedding, 'user', u);
  insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id, label, reverse_label, allows_primary)
    values (b, 'deal_contact', ot_deal, ot_contact, 'Contacts', 'Deals', true) returning id into link_deal_contact;
  insert into crm.record_links (business_id, link_type_id, from_record_id, to_record_id, is_primary, source_kind)
    values (b, link_deal_contact, deal_1, contact_1, true, 'user');

  insert into crm.notes (business_id, record_id, body, body_text, author_kind, author_id)
    values (b, contact_1, '{"type": "doc"}', 'Called about a June date.', 'user', u);
  insert into crm.tasks (business_id, record_id, title, assignee_user_id, created_by_kind, created_by_id)
    values (b, deal_1, 'Send the proposal', u, 'user', u);
  insert into crm.task_series (business_id, record_id, title, assignee_user_id, frequency, every,
      anchor_due_at, time_zone, lead_seconds, next_run_at, created_by_kind, created_by_id)
    values (b, deal_1, 'Check in weekly', u, 'weekly', 1, now() + interval '1 day', 'UTC', 86400,
      now() + interval '7 days', 'user', u);
  -- 0122: the engagement score profile, a draft rule, a contact's score and its change.
  insert into crm.score_profiles (business_id) values (b);
  insert into crm.score_rules (business_id, action, qualifier, calculation, points, created_by_kind, created_by_id)
    values (b, 'email_event', '{"event": "bounced"}', 'subtract', 5, 'user', u);
  insert into crm.contact_scores (business_id, contact_id, score) values (b, contact_1, 3);
  insert into crm.score_changes (business_id, contact_id, source, change, actor_kind, actor_id)
    values (b, contact_1, 'person', 3, 'user', u);
  -- 0123: a group of contacts said not to be duplicates.
  insert into crm.duplicate_rejections (business_id, kind, value_key, contact_ids, rejected_by_kind, rejected_by_id)
    values (b, 'email', 'jordan@example.com',
            array(select id from unnest(array[contact_1, deal_1]) as id order by id), 'user', u);
  insert into crm.saved_views (business_id, object_type_id, name, owner_user_id)
    values (b, ot_contact, 'Weddings this year', u);
  -- A shared view too: the checks below see it through the owner policies, so only tenant
  -- isolation keeps it from other businesses.
  insert into crm.saved_views (business_id, object_type_id, name, visibility, owner_user_id)
    values (b, ot_contact, 'Open weddings', 'shared', u);
  -- A share by name, kept on the private view: it gives nobody that view until the view is
  -- shared with chosen people.
  insert into crm.saved_view_shares (business_id, view_id, user_id, access)
    select b, id, current_setting('test.u1')::uuid, 'view' from crm.saved_views
    where business_id = b and name = 'Weddings this year';
  insert into crm.settings (business_id) values (b);

  insert into events.events (agency_id, business_id, type, actor_kind, actor_id, correlation_id, subject_kind, subject_id)
    values (a, b, 'contact.created', 'user', u, uuidv7(), 'record', contact_1)
    returning id, recorded_at into event_id, event_at;
  insert into crm.timeline_entries (business_id, record_id, occurred_at, event_id, event_recorded_at, event_type)
    values (b, contact_1, event_at, event_id, event_at, 'contact.created');

  insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
    values (a, b, 'mailbox.password', 1, decode(repeat('01', 32), 'hex'), decode(repeat('ab', 32), 'hex'))
    returning id into business_secret;
  insert into files.files (agency_id, business_id, storage, storage_key, filename, content_type, size_bytes, sha256, uploaded_by_kind, uploaded_by_id)
    values (a, b, 'local', 'b1/proposal.pdf', 'proposal.pdf', 'application/pdf', 1024, sha256('proposal'::bytea), 'user', u)
    returning id into logo;
  -- The file as one of the contact's documents (0120).
  insert into crm.record_files (business_id, file_id, record_id, created_by_kind, created_by_id)
    values (b, logo, contact_1, 'user', u);
  -- A media library folder (0087).
  insert into files.folders (business_id, name, created_by_kind) values (b, 'Brand', 'user');

  insert into messaging.provider_connections (agency_id, business_id, provider, label, account_ref, secret_id)
    values (a, b, 'twilio', 'Main', 'AC00000000000000000000000000000001', business_secret) returning id into connection;
  insert into messaging.sms_connection_attempts (business_id,label,account_ref,secret_id)
    values (b,'Pending','AC00000000000000000000000000000002',business_secret);
  insert into messaging.provider_numbers (business_id,connection_id,provider_number_ref,e164,capabilities)
    values (b,connection,'PN00000000000000000000000000000001','+14155550100','{sms}');
  insert into messaging.channel_accounts (business_id, id, channel, name) values
    (b, email_account, 'email', 'Dana'),
    (b, sms_account, 'sms', 'Main line'),
    (b, chat_account, 'webchat', 'Website chat');
  insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host, smtp_port, smtp_security,
                                   smtp_username, imap_host, imap_port, imap_security, imap_username, secret_id)
    values (b, email_account, 'dana@harborlights.example', 'password', 'mail.harborlights.example', 587, 'starttls',
            'dana@harborlights.example', 'mail.harborlights.example', 993, 'tls', 'dana@harborlights.example', business_secret);
  insert into messaging.mailbox_connection_attempts (business_id, email_address, secret_id)
    values (b, 'pending@harborlights.example', business_secret);
  insert into messaging.mailbox_check_runs (business_id, mailbox_id, trigger, method, score, finished_at)
    values (b, email_account, 'connect', 'self', 72, now()) returning id into check_run;
  insert into messaging.mailbox_check_results (business_id, run_id, check_key, status, points_awarded, points_possible, details)
    values (b, check_run, 'dmarc', 'fail', 0, 14, '{"fix": {"type": "TXT", "name": "_dmarc"}}');
  insert into messaging.phone_numbers (business_id, id, e164, provider_connection_id, provider_number_ref)
    values (b, sms_account, '+14155550100', connection, 'PN0001');
  -- Phone System settings (0108, ADR-108): the business's calling defaults, and the
  -- number's own routing to the member.
  insert into messaging.phone_system_settings (business_id, default_phone_number_id, inbound_fallback_e164)
    values (b, sms_account, '+14155550199');
  insert into messaging.phone_number_settings (business_id, phone_number_id, owner_user_id, primary_user_id)
    values (b, sms_account, u, u);
  -- A call record, its provider leg and a progress report (0110, ADR-110).
  insert into messaging.calls (business_id, direction, phone_number_id, provider_connection_id, local_e164,
                               remote_e164, contact_id, user_id, requested_by_kind, requested_by_id, state,
                               idempotency_key, request_hash, reserved_at)
    values (b, 'outbound', sms_account, connection, '+14155550100', '+14155550123', contact_1, u, 'user', u,
            'dialing', 'call-fixture-0001', repeat('c', 64), now());
  insert into messaging.call_legs (business_id, call_id, party, provider_connection_id, provider_call_sid, status, sequence)
    select b, id, 'remote', connection, 'CA' || substr(md5(b::text), 1, 32), 'ringing', 1
    from messaging.calls where business_id = b;
  insert into messaging.call_progress (business_id, leg_id, sequence, status)
    select b, id, 1, 'ringing' from messaging.call_legs where business_id = b;
  -- An incoming call ringing its first step: Dana's browser (0133).
  with inbound as (
    insert into messaging.calls (business_id, direction, phone_number_id, provider_connection_id, local_e164,
                                 remote_e164, contact_id, requested_by_kind, state)
      values (b, 'inbound', sms_account, connection, '+14155550100', '+14155550124', contact_1, 'contact',
              'ringing')
      returning id
  )
  insert into messaging.call_routes (business_id, call_id, steps, voicemail, timeout_seconds, caller_id)
    select b, id, '[[{"kind": "client", "address": "dana", "membershipId": "00000000-0000-0000-0000-000000000000"}]]',
           true, 15, '+14155550124'
    from inbound;
  -- A call recording reported by Twilio on the incoming call (0135).
  insert into messaging.call_recordings (business_id, call_id, provider_connection_id, provider_recording_sid, kind, status)
    select b, call_id, connection, 'RE' || substr(md5(b::text), 1, 32), 'call', 'in-progress'
    from messaging.call_routes where business_id = b;
  -- Browser calling set up on the connection: its key's SID, the secret in the vault (0114).
  insert into messaging.voice_setups (business_id, connection_id, status, key_sid, secret_id, requested_by, finished_at)
    values (b, connection, 'ready', 'SK' || substr(md5(b::text), 1, 32), business_secret, u, now());
  -- Dana's browser calling token, issued and not read yet.
  insert into messaging.voice_grants (business_id, user_id, connection_id, status, token, token_expires_at, issued_at)
    values (b, u, connection, 'issued', 'token-for-dana', now() + interval '10 minutes', now());
  insert into messaging.webchat_widgets (business_id, id, public_key) values (b, chat_account, 'pk_test_b1_widget_00001');

  insert into messaging.conversations (business_id, contact_id, last_message_at)
    values (b, contact_1, now()) returning id into conversation;
  insert into messaging.messages (business_id, conversation_id, channel, channel_account_id, direction, status, subject,
                                  body_text, idempotency_key, author_kind, author_id)
    values (b, conversation, 'email', email_account, 'outbound', 'queued', 'Your June date', 'Hi Jordan',
            'send:' || uuidv7()::text, 'user', u) returning id into outbound;
  insert into messaging.outbound_dispatch (business_id,id,identity_id,purpose,lane,request_hash)
    select b,outbound,id,'transactional','reply',repeat('a',64)
    from crm.contact_identities where business_id=b and contact_id=contact_1 and kind='email';
  -- The calendar invite an email carries (0102).
  insert into messaging.message_invites (business_id, message_id, method, content)
    values (b, outbound, 'REQUEST', 'BEGIN:VCALENDAR' || chr(13) || chr(10) || 'END:VCALENDAR');
  insert into messaging.messages (business_id,conversation_id,channel,channel_account_id,direction,status,
                                  body_text,idempotency_key,author_kind,author_id)
    values (b,conversation,'sms',sms_account,'outbound','sent','SMS fixture',
            'sms:' || uuidv7()::text,'user',u) returning id into outbound_sms;
  insert into messaging.sms_deliveries (business_id,message_id,provider_status,status_rank)
    values (b,outbound_sms,'sent',3);
  insert into messaging.messages (business_id, conversation_id, channel, channel_account_id, direction, status, body_text,
                                  email_message_id, author_kind)
    values (b, conversation, 'email', email_account, 'inbound', 'received', 'Sounds great', '<reply-1@example.com>', 'contact')
    returning id into inbound;
  insert into messaging.mailbox_inbound_uids
    (business_id, mailbox_id, uid_validity, uid, outcome, message_id, source_sha256)
    values (b, email_account, 1, 1, 'stored', inbound, sha256('inbound fixture'::bytea));
  insert into messaging.messages (business_id, conversation_id, channel, channel_account_id, direction, status, body_text,
                                  author_kind, author_id)
    values (b, conversation, 'webchat', chat_account, 'inbound', 'received', 'Do you have the 14th free?', 'contact', contact_1)
    returning id into chat_message;
  insert into messaging.webchat_sessions (business_id, id, widget_id, token_digest, origin, contact_id, conversation_id,
                                          last_seq, inbound_count, expires_at)
    values (b, chat_session, chat_account, encode(sha256('chat session fixture'::bytea), 'hex'),
            'https://harborlights.example', contact_1, conversation, 1, 1, now() + interval '30 days');
  insert into messaging.webchat_session_messages (business_id, session_id, seq, message_id, client_message_id)
    values (b, chat_session, 1, chat_message, uuidv7());
  insert into messaging.message_attachments (business_id, message_id, file_id) values (b, outbound, logo);
  insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
    values (b, contact_1, 'email', 'marketing', 'granted', 'form', 'form');
  -- An address's withdrawal, and the unsubscribe link that recorded it (0099, ADR-098).
  insert into messaging.consents (business_id, contact_id, channel, purpose, status, address_normalized,
                                  source, recorded_by_kind)
    values (b, contact_1, 'email', 'marketing', 'withdrawn', 'unsubscribed@example.com',
            'unsubscribe_link', 'contact');
  insert into messaging.unsubscribe_links (business_id, digest, address_normalized, message_id, contact_id)
    values (b, repeat('d', 64), 'unsubscribed@example.com', outbound, contact_1);
  -- A named secret a webhook step's header can use (0101, ADR-097).
  insert into automation.webhook_secrets (business_id, name, secret_id, rotated_by_kind)
    values (b, 'crm_key', business_secret, 'user');
  insert into messaging.suppressions (business_id, channel, address_normalized, reason, source_message_id)
    values (b, 'email', 'bounced@example.com', 'hard_bounce', inbound);
  insert into messaging.settings (business_id) values (b);
  insert into messaging.template_folders (business_id, name, created_by_kind)
    values (b, 'Welcome library', 'user');
  insert into messaging.templates (business_id, name, subject, body, created_by_kind)
    values (b, 'Consultation reminder', 'Your consultation', 'Hi {{contact.firstName}}', 'user');
  -- Snippets in a folder, and a trigger link with a token issued and clicked (0065).
  insert into messaging.snippet_folders (business_id, name, created_by_kind) values (b, 'Follow-ups', 'user');
  insert into messaging.snippets (business_id, kind, name, body, folder_id, created_by_kind)
    values (b, 'text', 'Running late', 'Hi {{contact.firstName}}, we are running late.',
            (select id from messaging.snippet_folders where business_id = b), 'user');
  insert into messaging.trigger_links (business_id, name, key, url, created_by_kind)
    values (b, 'Spring offer', 'spring_offer', 'https://www.harborlights.example/offer', 'user');
  insert into messaging.trigger_link_tokens (business_id, link_id, contact_id, digest)
    values (b, (select id from messaging.trigger_links where business_id = b), contact_1, repeat('e', 64));
  insert into messaging.trigger_link_clicks (business_id, link_id, contact_id, token_id)
    select business_id, link_id, contact_id, id from messaging.trigger_link_tokens where business_id = b;
  -- An email campaign in a folder of its own kind, one recipient and one test (0088).
  insert into messaging.template_folders (business_id, name, kind, created_by_kind)
    values (b, 'Spring campaigns', 'campaign', 'user');
  insert into messaging.email_campaigns (business_id, name, subject, body_text, folder_id, created_by_kind)
    values (b, 'Spring open day', 'You are invited', 'Hi {{contact.firstName}}',
            (select id from messaging.template_folders where business_id = b and kind = 'campaign'), 'user');
  insert into messaging.email_campaign_recipients (business_id, campaign_id, contact_id)
    values (b, (select id from messaging.email_campaigns where business_id = b), contact_1);
  insert into messaging.email_campaign_tests (business_id, campaign_id, addresses, requested_by_kind)
    values (b, (select id from messaging.email_campaigns where business_id = b), array['dana@harborlights.example'], 'user');

  insert into calendar.calendars (business_id, name, kind, timezone, booking_slug)
    values (b, 'Consultations', 'personal', 'America/New_York', 'consult') returning id into cal;
  insert into calendar.calendar_members (business_id, calendar_id, user_id) values (b, cal, u);
  -- A group with the calendar in it (0074).
  insert into calendar.calendar_groups (business_id, name) values (b, 'Sales calls');
  update calendar.calendars
    set group_id = (select id from calendar.calendar_groups where business_id = b and name = 'Sales calls')
    where business_id = b and id = cal;
  insert into calendar.weekly_hours (business_id, calendar_id, weekday, start_time, end_time) values (b, cal, 1, '09:00', '17:00');
  insert into calendar.date_overrides (business_id, calendar_id, on_date) values (b, cal, current_date + 14);
  insert into calendar.appointments (business_id, calendar_id, contact_id, assigned_user_id, title, starts_at, ends_at, source)
    values (b, cal, contact_1, u, 'Consultation', now() + interval '1 day', now() + interval '1 day 1 hour', 'booking_page');
  insert into calendar.appointment_operations
    (business_id, appointment_id, operation_request_id, operation, request_digest, receipt, confirmation_status)
    select b, id, uuidv7(), 'reschedule', repeat('b', 64),
      jsonb_build_object(
        'status', status,
        'startsAt', to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'endsAt', to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ), 'unavailable'
    from calendar.appointments where business_id = b and calendar_id = cal;
  -- A reminder's link to the appointment (0107): the digest of a token, never the token.
  insert into calendar.appointment_links (business_id, appointment_id, digest)
    select b, id, repeat('d0', 32)
    from calendar.appointments where business_id = b and calendar_id = cal;
  insert into calendar.user_schedules (business_id, user_id, timezone) values (b, u, 'America/New_York');
  insert into calendar.user_weekly_hours (business_id, user_id, weekday, start_minute, end_minute) values (b, u, 1, 540, 1020);
  insert into calendar.user_date_overrides (business_id, user_id, on_date) values (b, u, current_date + 14);
  insert into calendar.blocked_slots (business_id, user_id, starts_at, ends_at, title)
    values (b, u, now() + interval '30 days', now() + interval '31 days', 'Annual leave');
  -- The member's Google Calendar (0106, ADR-106): the connection, an attempt, a calendar,
  -- busy time with its window, a fresh look, and the appointment written to Google.
  insert into calendar.google_connections
    (business_id, user_id, status, google_sub, google_email, secret_id, write_calendar_id)
    values (b, u, 'connected', '1000000001', 'dana@harborlights.example', business_secret, 'primary');
  insert into calendar.google_connect_attempts (business_id, user_id, state_digest)
    values (b, u, sha256(convert_to(b::text, 'UTF8')));
  insert into calendar.google_calendars
    (business_id, connection_id, calendar_id, name, is_primary, access_role, check_conflicts, position)
    select b, id, 'primary', 'Dana', true, 'owner', true, 0
    from calendar.google_connections where business_id = b;
  insert into calendar.google_busy (business_id, connection_id, starts_at, ends_at)
    select b, id, now() + interval '2 days', now() + interval '2 days 1 hour'
    from calendar.google_connections where business_id = b;
  insert into calendar.google_busy_windows (business_id, connection_id, starts_at, ends_at)
    select b, id, now(), now() + interval '14 days'
    from calendar.google_connections where business_id = b;
  insert into calendar.google_busy_checks (business_id, connection_id, starts_at, ends_at)
    select b, id, now() + interval '3 days', now() + interval '3 days 30 minutes'
    from calendar.google_connections where business_id = b;
  insert into calendar.google_event_syncs
    (business_id, appointment_id, connection_id, google_calendar_id, event_id, state)
    select b, a.id, c.id, 'primary', 'crm' || replace(a.id::text, '-', '') || 'g1', 'written'
    from calendar.appointments a
    join calendar.google_connections c on c.business_id = a.business_id
    where a.business_id = b and a.calendar_id = cal;

  insert into forms.forms (business_id, name, definition, status, public_key, allowed_origins,
                           published_definition, published_at)
    values (b, 'Inquiry', '{"fields": []}', 'published', 'pk_test_b1_form_000001',
            '{https://www.harborlights.example}', '{"fields": []}', now())
    returning id into form;
  insert into forms.submissions (business_id, form_id, contact_id, data, client_submission_id,
                                 request_digest, origin, page_url, contact_outcome)
    values (b, form, contact_1, '{"name": "Jordan"}', uuidv7(), repeat('a', 64),
            'https://www.harborlights.example', 'https://www.harborlights.example/contact', 'created');
  -- One that could not be attached to a contact: the only kind the application may delete.
  insert into forms.submissions (business_id, form_id, data, client_submission_id, request_digest,
                                 origin, contact_outcome)
    values (b, form, '{"name": "Unmatched"}', uuidv7(), repeat('b', 64),
            'https://www.harborlights.example', 'unresolved');
  -- The form's numbers for one day: shown twelve times, two submissions timed.
  insert into forms.daily_stats (business_id, form_id, day, views, timed_submissions, fill_seconds)
    values (b, form, date '2026-10-10', 12, 2, 95);
  -- 0131: External Tracking, its events, a page's day, a visitor known to be the contact and
  -- an external form's submission.
  insert into forms.tracking_settings (business_id, tracking_id)
    values (b, 'tk_' || repeat('b1', 16));
  insert into forms.tracking_events (business_id, kind, page_host, page_path, visitor_id, contact_id)
    values (b, 'page_view', 'www.harborlights.example', '/pricing', uuidv7(), contact_1);
  insert into forms.tracking_page_days (business_id, page_host, page_path, day, page_views, last_seen_at)
    values (b, 'www.harborlights.example', '/pricing', current_date, 1, now());
  insert into forms.tracking_visitors (business_id, visitor_id, contact_id)
    values (b, uuidv7(), contact_1);
  insert into forms.external_submissions (business_id, contact_id, form_name, page_host, page_path, fields,
                                          client_submission_id, view_mark)
    values (b, contact_1, 'Contact us', 'www.harborlights.example', '/contact',
            '[{"name": "email", "label": "Email", "value": "jordan@example.com"}]', uuidv7(), repeat('m', 43));
  -- Where the contact came from (0086): one touch, its first and its latest; and a saved report.
  insert into crm.contact_attributions
    (business_id, contact_id, medium, session_source, utm_source, subject_kind, subject_id, is_first, is_latest)
    values (b, contact_1, 'form', 'paid_search', 'adwords', 'contact', contact_1, true, true);
  insert into reporting.reports (business_id, name, definition, definition_version, created_by_kind, created_by_id)
    values (b, 'Pipeline & Attribution Report', '{"version": 1}', 1, 'user', u);

  insert into automation.automations (business_id, name, draft, created_by_kind)
    values (b, 'Follow up new leads', '{"name": "Follow up new leads"}', 'user') returning id into automation_1;
  insert into automation.versions (business_id, automation_id, version, document, published_by_kind)
    values (b, automation_1, 1, '{"name": "Follow up new leads"}', 'user') returning id into version_1;
  update automation.automations set published_version_id = version_1, status = 'active'
    where business_id = b and id = automation_1;
  insert into automation.email_bindings (business_id, automation_id, version_id, step)
    values (b, automation_1, version_1, 'send_welcome') returning id into email_binding;
  insert into automation.email_content_revisions
    (business_id, binding_id, revision, mode, subject, body, created_by_kind)
    values (b, email_binding, 1, 'copy', 'Your welcome guide', 'An independent workflow email.', 'user');
  -- A folder with the automation in it (0055).
  insert into automation.folders (business_id, name, created_by_kind) values (b, 'Lead follow-up', 'user');
  update automation.automations
    set folder_id = (select id from automation.folders where business_id = b and name = 'Lead follow-up')
    where business_id = b and id = automation_1;
  insert into automation.trigger_subscriptions (business_id, automation_id, version_id, event_type)
    values (b, automation_1, version_1, 'contact.created');
  -- A date trigger's cursor and one firing of it (0072).
  insert into automation.trigger_cursors (business_id, automation_id, trigger_id, swept_through)
    values (b, automation_1, 'the_day', now());
  insert into automation.trigger_firings (business_id, automation_id, trigger_id, record_id, occurrence)
    values (b, automation_1, 'the_day', contact_1, current_date);
  -- Whose turn it is at a step that shares contacts between team members (0081).
  insert into automation.assignment_cursors (business_id, automation_id, step_key, next_position)
    values (b, automation_1, 'assign_sales', 1);
  insert into automation.enrolments (business_id, automation_id, version_id, record_id, status, reentry_key, current_step, wake_at, correlation_id)
    values (b, automation_1, version_1, contact_1, 'waiting', contact_1, 'wait_two_days', now() + interval '2 days', uuidv7())
    returning id into enrolment;
  -- A time the automation did not start for the contact, and why (0083); and the deal a
  -- run would have in hand is a column of the enrolment (0082), so it has no row of its own.
  insert into automation.trigger_evaluations
    (business_id, automation_id, trigger_id, record_id, event_id, event_type, reason, detail)
    values (b, automation_1, 'created', contact_1, uuidv7(), 'contact.created', 'condition_false',
            '{"values": {"contact.lastName": null}}');
  -- The enrolment wrote its statistics as rows to fold (0055): folded here into the
  -- counters, and the step run below writes more, so both tables hold rows of business 1.
  perform private.compact_automation_stats(1000);
  insert into automation.event_waits (business_id, enrolment_id, kind, event_type, record_id)
    values (b, enrolment, 'reply', 'message.received', contact_1);
  insert into automation.step_runs (business_id, enrolment_id, step_key, status, explanation)
    values (b, enrolment, 'send_welcome', 'succeeded', 'Sent the welcome email.');
  -- A call the run left for a person (0065).
  insert into automation.manual_actions (business_id, automation_id, enrolment_id, step_key, contact_id, kind)
    values (b, automation_1, enrolment, 'call_them', contact_1, 'call');
  insert into automation.test_runs (business_id, automation_id, draft_revision, sample_record_id, status, outcome, created_by_kind)
    values (b, automation_1, 1, contact_1, 'passed', '{"kind":"completed"}', 'user');
  insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
    values (a, b, 'automation.webhook_signing', 1, decode(repeat('06', 32), 'hex'), decode(repeat('cd', 32), 'hex'))
    returning id into webhook_secret;
  insert into automation.webhook_signing (business_id, secret_id, rotated_by_kind, rotated_by_id)
    values (b, webhook_secret, 'user', u);

  insert into ai.provider_keys (agency_id, business_id, provider, label, secret_id, key_last4)
    values (a, b, 'anthropic', 'Own key', business_secret, 'a1f3');
  insert into ai.settings (business_id, key_source, monthly_limit) values (b, 'own', 50);
  insert into ai.job_models (business_id, job, provider, model) values (b, 'replies', 'anthropic', 'claude-sonnet-5-5');
  insert into ai.requests (business_id, job, provider, model, key_source, status, input_tokens, output_tokens, cost_estimate, actor_kind, finished_at)
    values (b, 'replies', 'anthropic', 'claude-sonnet-5-5', 'own', 'ok', 1200, 300, 0.0054, 'ai_agent', now())
    returning id into request;
  -- A call still in flight, holding money against the monthly limit (0050).
  insert into ai.requests (business_id, job, provider, model, key_source, status, cost_estimate, actor_kind,
                           reserved_estimate, reserved_until)
    values (b, 'replies', 'anthropic', 'claude-sonnet-5-5', 'own', 'started', null, 'ai_agent',
            0.25, now() + interval '15 minutes');
  -- A test of the key that called a model (0051): the test and its call are the business's.
  insert into ai.connection_tests (agency_id, business_id, connection_id, status, outcome, latency_ms,
                                   request_id, finished_at)
    select a, b, k.id, 'finished', 'ok', 800, request, now()
    from ai.provider_keys k where k.business_id = b and k.provider = 'anthropic';
  insert into ai.proposals (business_id, agent, kind, conversation_id, summary, command, autonomy, request_id, revision)
    values (b, 'inbox', 'reply', conversation, 'Reply to Jordan about the June date',
            '{"name": "conversation.reply", "input": {}}', 'ask', request, 'thread:1')
    returning id into proposal;
  -- The request that asked for that draft (0052): the worker wrote it, and it is the business's.
  insert into ai.draft_requests (business_id, conversation_id, origin, status, outcome, proposal_id, request_id, finished_at)
    values (b, conversation, 'message', 'finished', 'drafted', proposal, request, now());
  insert into ai.autonomy_rules (business_id, agent, action, level) values (b, 'inbox', 'send_message', 'ask');
  insert into ai.contact_facts (business_id, contact_id, statement, field_id, confidence, source_event_ids)
    values (b, contact_1, 'Planning a June wedding', field_event_date, 0.9, array[event_id]);
  insert into ai.contact_summaries (business_id, contact_id, summary, model)
    values (b, contact_1, 'Jordan is planning a June wedding.', 'claude-haiku-4-5');
  -- One reading of that conversation by the extraction job (0061).
  insert into ai.extractions (business_id, conversation_id, contact_id, revision, status, outcome,
                              request_id, proposed_facts, finished_at)
    values (b, conversation, contact_1, 'thread:1', 'finished', 'extracted', request, 1, now());

  insert into audit.commands (agency_id, business_id, command, actor_kind, actor_id, outcome, correlation_id)
    values (a, b, 'contact.create', 'user', u, 'ok', uuidv7());
  insert into intake.webhooks (provider, endpoint, headers, body, signature_valid, business_id)
    values ('twilio', '/hooks/twilio/sms', '{}', '\x00'::bytea, true, b);
  -- An import that ran to its end (0054): its file, who started it, and what became of a row.
  insert into imports.jobs (business_id, source, status, objects, created_by_kind, created_by_id,
                            file_id, file_name, row_count, processed_count, created_count,
                            started_at, finished_at)
    values (b, 'ghl', 'completed', '{contact}', 'user', u, logo, 'contacts.csv', 1, 1, 1, now(), now())
    returning id into import_job;
  insert into imports.id_map (business_id, source, source_type, source_id, target_kind, target_id, job_id)
    values (b, 'ghl', 'contact', 'ghl-contact-1', 'contact', contact_1, import_job);
  insert into imports.job_rows (business_id, job_id, row_number, outcome, record_id)
    values (b, import_job, 2, 'created', contact_1);
  insert into reporting.daily_metrics (business_id, metric, day, value) values (b, 'leads.new', current_date, 3);
  insert into tenancy.invitations (agency_id, business_id, email, role_id, token_hash, invited_by_user_id, expires_at)
    values (a, b, 'new.hire@harborlights.example', business_role, sha256('invite-token'::bytea), u, now() + interval '7 days');
  -- What the agency keeps about a person on its team (0073).
  insert into tenancy.user_profiles (agency_id, user_id, first_name, last_name, phone_e164, phone_extension)
    values (a, u, 'Dana', 'Brooks', '+13055550123', '204');
  insert into tenancy.api_keys (agency_id, business_id, name, key_prefix, key_hash, scopes, created_by_user_id)
    values (a, b, 'Zapier', 'crm_live_b1zap', sha256('api-key'::bytea), array['contacts:read'], u);
  -- An app the agency lists in its App Marketplace, and business 1's install of it (0112).
  insert into tenancy.marketplace_apps (agency_id, name, developer, scopes, status, created_by)
    values (a, 'Harbor Sync', 'Harbor Lights', array['contacts.manage'], 'listed', u)
    returning id into marketplace_app;
  insert into tenancy.marketplace_installs (business_id, agency_id, app_id, granted_scopes, installed_by)
    values (b, a, marketplace_app, array['contacts.manage'], u)
    returning id into marketplace_install;
  -- Its app key and a code from Dana's consent (0113); its token pair is written below.
  insert into tenancy.api_keys (agency_id, business_id, name, scopes, read_groups, created_by_user_id,
                                marketplace_install_id)
    values (a, b, 'Harbor Sync', array['contacts.manage'], array['Contacts'], u, marketplace_install);
  insert into tenancy.marketplace_oauth_codes (business_id, agency_id, install_id, code_hash, redirect_uri,
                                               code_challenge, issued_by, expires_at, used_at)
    values (b, a, marketplace_install, sha256('oauth-code'::bytea), 'https://sync.example/callback',
            'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', u, now() + interval '10 minutes', now());
  -- A webhook delivery to that install about a contact created here (0115).
  insert into tenancy.marketplace_webhook_deliveries (business_id, agency_id, install_id, app_id, event_id,
                                                      event_type, body)
    values (b, a, marketplace_install, marketplace_app, uuidv7(), 'contact.created',
            '{"type": "contact.created"}');
  -- Dana's conversation with the in-app assistant (0084): a thread, the turn her message
  -- started and the message itself, written by Dana herself. And a proposal about a form.
  insert into ai.assistant_threads (business_id, user_id, title, message_seq)
    values (b, u, 'Build a wedding enquiry form', 1)
    returning id into assistant_thread;
  insert into ai.assistant_turns (business_id, thread_id, user_id, page, correlation_id)
    values (b, assistant_thread, u, '{"route": "/forms", "selection": []}', uuidv7())
    returning id into assistant_turn;
  insert into ai.assistant_messages (business_id, thread_id, turn_id, user_id, seq, kind, text)
    values (b, assistant_thread, assistant_turn, u, 1, 'user', 'Build a wedding enquiry form');
  insert into ai.proposals (business_id, agent, kind, form_id, summary, command, autonomy, revision)
    values (b, 'copilot', 'form_publish', form, 'Publish the form "Wedding inquiry"',
            '{"name": "forms.publish", "input": {}}', 'ask', 'form:1');
  -- What Dana chose not to be told of (0056), written by Dana herself. Then a notification
  -- for her, which only the worker writes: the system, for the rest of this block.
  insert into notifications.preferences (business_id, user_id, kind, in_app)
    values (b, u, 'message.received_other', false);
  perform set_config('app.actor_kind', 'system', true);
  perform set_config('app.actor_id', '', true);
  insert into ai.assistant_tool_calls (business_id, thread_id, turn_id, user_id, call_id, operation_id, effect)
    values (b, assistant_thread, assistant_turn, u, 'fixture:tool', 'getContact', 'read');
  insert into notifications.notifications (agency_id, business_id, user_id, kind, source_key, collapse_key,
                                           event_id, actor_kind, subject_kind, subject_id, record_id)
    values (a, b, u, 'conversation.assigned', 'event:' || event_id, 'conversation.assigned:' || conversation,
            event_id, 'system', 'conversation', conversation, contact_1);
end $$;

-- Sites (0070): a domain, a funnel in a folder with a step, its page and a version, a day of
-- statistics, a saved section, a redirect, a template of the business and a favourite.
do $$
declare
  a constant uuid := current_setting('test.a1');
  b constant uuid := current_setting('test.b1');
  u constant uuid := current_setting('test.u2');
  site_domain uuid;
  site_folder uuid;
  site_1 uuid;
  step_1 uuid;
  page_1 uuid;
  template_1 uuid;
begin
  insert into sites.domains (business_id, hostname, created_by_kind)
    values (b, 'go.harborlights.example', 'user') returning id into site_domain;
  insert into sites.folders (business_id, kind, name, created_by_kind)
    values (b, 'funnel', 'Campaigns', 'user') returning id into site_folder;
  insert into sites.sites (business_id, kind, name, folder_id, domain_id, path, created_by_kind)
    values (b, 'funnel', 'Spring offer', site_folder, site_domain, 'spring', 'user') returning id into site_1;
  insert into sites.security_headers (business_id, site_id, name, value)
    values (b, site_1, 'X-Frame-Options', 'DENY');
  insert into sites.steps (business_id, site_id, name, path, position, created_by_kind)
    values (b, site_1, 'Landing Page', 'landing', 0, 'user') returning id into step_1;
  insert into sites.pages (business_id, step_id, site_id, site_kind)
    values (b, step_1, site_1, 'funnel') returning id into page_1;
  insert into sites.page_versions (business_id, page_id, number, format, document, created_by_kind)
    values (b, page_1, 1, 1, '{"format": 1, "mode": "visual"}', 'user');
  insert into sites.step_stats_daily (business_id, page_id, day, step_id, site_id, views, unique_views, opt_ins)
    values (b, page_1, date '2026-10-10', step_1, site_1, 12, 9, 2);
  insert into sites.saved_sections (business_id, site_id, name, format, document, created_by_kind)
    values (b, null, 'Header', 1, '{"type": "section"}', 'user');
  insert into sites.redirects (business_id, domain_id, path, target_site_id, created_by_kind)
    values (b, site_domain, '/offer', site_1, 'user');
  insert into sites.templates (agency_id, business_id, kind, name, format, content, created_by_kind)
    values (a, b, 'funnel', 'Our spring funnel', 1, '{"kind": "funnel"}', 'user') returning id into template_1;
  insert into sites.template_favorites (business_id, user_id, template_id) values (b, u, template_1);
end $$;

-- Commerce (0079, 0080): settings, the three counters, a product, an issued invoice with a
-- line, a payment against it (its receipt) and the invoice's public address.
do $$
declare
  b constant uuid := current_setting('test.b1');
  u constant uuid := current_setting('test.u2');
  product_1 uuid;
  invoice_1 uuid;
  contact_1 uuid;
  reminder_1 uuid;
begin
  select id into contact_1 from crm.contacts where business_id = b order by id limit 1;
  insert into commerce.settings (business_id, payment_terms_days, tax_number, default_tax_rate)
    values (b, 14, 'P051234567X', 16);
  insert into commerce.sequences (business_id, kind, prefix, next_number, last_number) values
    (b, 'quote', 'QUO-', 1, 0), (b, 'invoice', 'INV-', 2, 1), (b, 'receipt', 'RCT-', 2, 1);
  insert into commerce.products (business_id, kind, name, sku, unit, unit_price, currency, tax_rate,
                                 created_by_kind, created_by_id)
    values (b, 'service', 'Event planning', 'PLAN-1', 'hour', 50, 'USD', 16, 'user', u)
    returning id into product_1;
  -- Made as a draft, given its line, then issued: lines change only under a draft.
  insert into commerce.documents (business_id, kind, contact_id, currency, customer_name,
                                  created_by_kind, created_by_id)
    values (b, 'invoice', contact_1, 'USD', 'Jordan', 'user', u)
    returning id into invoice_1;
  insert into commerce.document_lines (business_id, document_id, position, product_id, name, quantity,
                                       unit, unit_price, tax_rate, amount, taxable_amount, tax_amount)
    values (b, invoice_1, 0, product_1, 'Event planning', 2, 'hour', 50, 16, 100, 100, 16);
  update commerce.documents
  set status = 'partly_paid', number = 'INV-0001', sequence_number = 1,
      issue_date = date '2026-10-10', due_date = date '2026-10-24', issued_at = now(),
      seller = '{"name": "Harbor Lights Events"}',
      subtotal = 100, tax_total = 16, total = 116, amount_paid = 16, balance_due = 100
  where business_id = b and id = invoice_1;
  insert into commerce.payments (business_id, document_id, number, sequence_number, amount, currency,
                                 paid_on, method, balance_after, recorded_by_kind, recorded_by_id)
    values (b, invoice_1, 'RCT-0001', 1, 16, 'USD', date '2026-10-11', 'cash', 100, 'user', u);
  -- Its public address (0080): the digest of a token, never the token.
  insert into commerce.document_links (business_id, document_id, digest, created_by_kind, created_by_id)
    values (b, invoice_1, repeat('c0', 32), 'user', u);
  -- Invoice reminders (0139): when, how often and what they say; and each send made.
  insert into commerce.invoice_reminders (
    business_id, name, enabled, every_amount, every_unit, direction, anchor, max_sends, subject, body
  ) values (
    b, 'Overdue reminder', true, 3, 'days', 'after', 'due_date', 3,
    'Your invoice {{invoice.number}} is overdue',
    'Please pay invoice {{invoice.number}} at {{invoice.url}}'
  ) returning id into reminder_1;
  insert into commerce.invoice_reminder_sends (business_id, reminder_id, document_id, step)
    values (b, reminder_1, invoice_1, 1);
end $$;

-- Integrations (0132): a connected account with its sealed credentials, an OAuth attempt,
-- a record's id at the provider and the account's activity.
do $$
declare
  b constant uuid := current_setting('test.b1');
  u constant uuid := current_setting('test.u2');
  secret_1 uuid;
  connection_1 uuid;
  contact_1 uuid;
begin
  select id into contact_1 from crm.contacts where business_id = b order by id limit 1;
  -- One of the business's own secrets: the count of what each business sees stays as it is.
  select id into secret_1 from vault.secrets where business_id = b order by id limit 1;
  insert into integrations.connections (business_id, provider, account_ref, account_label, status,
                                        secret_id, is_primary, connected_by, webhook_digest)
    values (b, 'standin', 'T0001', 'Harbor Lights', 'connected', secret_1, true, u, repeat('ab', 32))
    returning id into connection_1;
  insert into integrations.connect_attempts (business_id, provider, user_id, state_digest)
    values (b, 'standin', u, sha256(convert_to('integrations:' || b::text, 'UTF8')));
  insert into integrations.external_ids (business_id, connection_id, entity_kind, entity_id, external_id)
    values (b, connection_1, 'contact', contact_1, 'C-1');
  insert into integrations.activity (business_id, connection_id, kind)
    values (b, connection_1, 'connected');
end $$;

-- Stripe (0141): the business's own account with its sealed key and webhook secrets, and an
-- earlier endpoint waiting to be removed.
do $$
declare
  b constant uuid := current_setting('test.b1');
  secret_1 uuid;
  document_1 uuid;
begin
  -- One of the business's own secrets: the count of what each business sees stays as it is.
  select id into secret_1 from vault.secrets where business_id = b order by id limit 1;
  insert into commerce.stripe_connections (business_id, status, livemode, key_secret_id,
                                           webhook_token_secret_id, webhook_digest,
                                           webhook_endpoint_id, webhook_secret_id, connected_at)
    values (b, 'connected', false, secret_1, secret_1, repeat('5e', 32), 'we_0000000000000001',
            secret_1, now());
  insert into commerce.stripe_endpoint_removals (business_id, key_secret_id, webhook_endpoint_id)
    values (b, secret_1, 'we_0000000000000002');
  -- A customer paying an invoice by card (0142): a session made and waiting at Stripe.
  select id into document_1 from commerce.documents
    where business_id = b and kind = 'invoice' order by id limit 1;
  insert into commerce.stripe_checkouts (business_id, document_id, status, amount, currency,
                                         session_id, session_url, expires_at, livemode)
    values (b, document_1, 'open', 1500, 'KES', 'cs_test_0000000000000001',
            'https://checkout.stripe.com/c/pay/cs_test_0000000000000001', now() + interval '1 hour',
            false);
end $$;

-- 3. Business 2 (same agency) and business 3 (another agency): just enough to compare --------

set app.business_id = :'b2';
set app.user_id = :'u1';

do $$
declare
  a constant uuid := current_setting('test.a1');
  b constant uuid := current_setting('test.b2');
  ot_contact uuid;
  contact_2 uuid := uuidv7();
begin
  insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
    values (b, 'contact', 'contact', 'Contact', 'Contacts') returning id into ot_contact;
  insert into crm.records (business_id, id, kind, object_type_id) values (b, contact_2, 'contact', ot_contact);
  insert into crm.contacts (business_id, id, first_name, created_by_kind) values (b, contact_2, 'Jordan', 'user');
  -- The same address as in business 1 is fine: identities are unique per business.
  insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, is_primary)
    values (b, contact_2, 'email', 'jordan@example.com', 'jordan@example.com', true);
  insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
    values (a, b, 'mailbox.password', 1, decode(repeat('03', 32), 'hex'), decode(repeat('ef', 32), 'hex'));
end $$;

-- Agency-level rows: shared by every business in agency 1.
set app.business_id = '';
insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
  values (:'a1', null, 'ai.anthropic_key', 1, decode(repeat('04', 32), 'hex'), decode(repeat('aa', 32), 'hex'));
-- A price the agency entered for a model (0050): every business of agency 1 reads it.
insert into ai.model_prices (agency_id, provider, model, input_per_mtok, output_per_mtok,
                             cache_read_per_mtok, cache_write_per_mtok, source, checked_on)
  values (:'a1', 'openai_compatible', 'llama3.2', 0, 0, 0, 0, 'Runs on our own server', '2026-10-10');

set app.agency_id = :'a2';
set app.business_id = :'b3';
set app.user_id = :'u3';
insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
  values (:'a2', :'b3', 'mailbox.password', 1, decode(repeat('05', 32), 'hex'), decode(repeat('bb', 32), 'hex'));

reset role;

-- Only the token endpoint, as crm_auth, writes token pairs (0113): the one business 1's
-- code became.
set role crm_auth;
insert into tenancy.marketplace_oauth_tokens (business_id, agency_id, install_id, code_id, access_hash,
                                              access_expires_at, refresh_hash, refresh_expires_at)
  select c.business_id, c.agency_id, c.install_id, c.id, sha256('access-token'::bytea),
         now() + interval '1 day', sha256('refresh-token'::bytea), now() + interval '365 days'
  from tenancy.marketplace_oauth_codes c
  where c.business_id = :'b1';
reset role;

-- Only private.accept_stripe_webhook writes Stripe's events (0143); it queues a Graphile job,
-- which not every run of these suites has, so the owner keeps one for business 1 instead.
set role crm_owner;
insert into commerce.stripe_webhooks (business_id, signature, body, received_at)
  values (:'b1', 't=1,v1=00', convert_to('{}', 'UTF8'), now());
reset role;

-- 4. Every tenant table really has business 1 data, so the checks below mean something ------

set role crm_app;
set app.agency_id = :'a1';
set app.business_id = :'b1';
insert into messaging.email_verifications (business_id,address_normalized)
  values (:'b1','checks@example.test');
insert into messaging.email_verification_checks
  (business_id,id,address_normalized,charged,outcome,actor_kind)
  values (:'b1',uuidv7(),'checks@example.test',false,'valid','system');
reset role;

do $$
declare
  v_table regclass;
  v_count bigint;
  v_missing text := '';
begin
  for v_table in
    select c.oid::regclass
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped
    where c.relkind in ('r', 'p') and not c.relispartition
      and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_temp%'
  loop
    execute format('select count(*) from %s where business_id = $1', v_table)
      into v_count using current_setting('test.b1')::uuid;
    if v_count = 0 then
      v_missing := v_missing || v_table::text || ' ';
    end if;
  end loop;
  if v_missing <> '' then
    raise exception 'the fixture has no business 1 rows in: %', v_missing;
  end if;
  raise notice 'ok: the fixture covers every table with a business_id';
end $$;

-- 5. Isolation checks, as crm_app ------------------------------------------------------------

set role crm_app;

-- Business 2 sees nothing of business 1, in any table.
set app.agency_id = :'a1';
set app.business_id = :'b2';
set app.user_id = :'u1';
do $$
declare
  v_table regclass;
  v_count bigint;
  v_leaks text := '';
begin
  for v_table in
    select c.oid::regclass
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped
    where c.relkind in ('r', 'p') and not c.relispartition and c.relrowsecurity
      -- A table crm_app can't read at all (calendar.host_bookings) can't show it anything.
      and has_table_privilege(c.oid, 'select')
  loop
    execute format('select count(*) from %s where business_id = $1', v_table)
      into v_count using current_setting('test.b1')::uuid;
    if v_count > 0 then
      v_leaks := v_leaks || format('%s (%s rows) ', v_table, v_count);
    end if;
  end loop;
  if v_leaks <> '' then
    raise exception 'business 2 can see business 1 rows in: %', v_leaks;
  end if;
  raise notice 'ok: business 2 sees no business 1 rows';
end $$;

-- Another agency sees nothing of agency 1 or its businesses.
set app.agency_id = :'a2';
set app.business_id = :'b3';
set app.user_id = :'u3';
do $$
declare
  v_table record;
  v_count bigint;
  v_leaks text := '';
begin
  for v_table in
    select c.oid::regclass as name,
           exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'agency_id' and not a.attisdropped) as has_agency,
           exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped) as has_business
    from pg_class c
    where c.relkind in ('r', 'p') and not c.relispartition and c.relrowsecurity
      and has_table_privilege(c.oid, 'select')
  loop
    if v_table.has_agency then
      execute format('select count(*) from %s where agency_id = $1', v_table.name)
        into v_count using current_setting('test.a1')::uuid;
    elsif v_table.has_business then
      execute format('select count(*) from %s where business_id in ($1, $2)', v_table.name)
        into v_count using current_setting('test.b1')::uuid, current_setting('test.b2')::uuid;
    else
      continue;
    end if;
    if v_count > 0 then
      v_leaks := v_leaks || format('%s (%s rows) ', v_table.name, v_count);
    end if;
  end loop;
  if v_leaks <> '' then
    raise exception 'agency 2 can see agency 1 rows in: %', v_leaks;
  end if;
  raise notice 'ok: agency 2 sees no agency 1 rows';
end $$;

-- Without a context, every protected table reads as empty. Graphile Worker's queue tables
-- also have row-level security, but they hold no tenant rows and crm_app can't reach
-- their schema at all; nor can it read the sign-in tables, which only crm_auth may
-- (01_catalog.sql). Tables crm_app can't read at all are skipped here.
set app.agency_id = '';
set app.business_id = '';
set app.user_id = '';
do $$
declare
  v_table regclass;
  v_count bigint;
  v_leaks text := '';
begin
  for v_table in
    select c.oid::regclass from pg_class c
    where c.relkind in ('r', 'p') and not c.relispartition and c.relrowsecurity
      and c.relnamespace <> 'graphile_worker'::regnamespace
      and has_table_privilege(c.oid, 'select')
  loop
    execute format('select count(*) from %s', v_table) into v_count;
    if v_count > 0 then
      v_leaks := v_leaks || format('%s (%s rows) ', v_table, v_count);
    end if;
  end loop;
  if v_leaks <> '' then
    raise exception 'rows visible without a tenant context in: %', v_leaks;
  end if;
  raise notice 'ok: with no context set, every protected table is empty';
end $$;

-- A business can't write a row into another business.
set app.agency_id = :'a1';
set app.business_id = :'b2';
do $$
begin
  begin
    insert into crm.tags (business_id, name, created_by_kind)
      values (current_setting('test.b1')::uuid, 'Smuggled', 'user');
    raise exception 'expected the row-level security check to reject the insert';
  exception when insufficient_privilege then
    raise notice 'ok: inserting into another business is rejected';
  end;
end $$;

-- Agency staff see all of the agency's businesses; inside a business, only that one.
set app.business_id = '';
do $$
begin
  if (select count(*) from tenancy.businesses) <> 2 then
    raise exception 'agency 1 staff should see exactly its 2 businesses';
  end if;
  if (select count(*) from auth.users) <> 2 then
    raise exception 'agency 1 should see exactly its 2 members';
  end if;
  raise notice 'ok: agency staff see their agency''s businesses and people, nothing else';
end $$;

set app.business_id = :'b1';
do $$
begin
  if (select count(*) from tenancy.businesses) <> 1 then
    raise exception 'inside business 1 only business 1 should be visible';
  end if;
  -- Business 1's two purpose-bound secrets plus the agency's shared secret; never business 2's.
  if (select count(*) from vault.secrets) <> 3
     or exists (select 1 from vault.secrets where business_id = current_setting('test.b2')::uuid) then
    raise exception 'business 1 should see its own and the agency''s shared secrets only';
  end if;
  raise notice 'ok: a business sees its own and its agency''s shared rows only';
end $$;

-- Append-only and delete-through-the-registry rules hold for crm_app.
do $$
declare
  v_contact uuid := uuidv7();
  v_type uuid;
  v_partition text := format('events.events_p%s', to_char(now() at time zone 'UTC', 'YYYY_MM'));
begin
  begin
    update events.events set type = 'contact.changed';
    raise exception 'expected crm_app to be unable to update events';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from crm.contacts;
    raise exception 'expected crm_app to be unable to delete contacts directly';
  exception when insufficient_privilege then null;
  end;
  begin
    execute format('select count(*) from %s', v_partition);
    raise exception 'expected crm_app to be unable to read a partition directly';
  exception when insufficient_privilege then null;
  end;

  select id into v_type from crm.object_types where kind = 'contact';
  insert into crm.records (business_id, id, kind, object_type_id) values (app.business_id(), v_contact, 'contact', v_type);
  insert into crm.contacts (business_id, id, first_name, created_by_kind) values (app.business_id(), v_contact, 'Temporary', 'user');
  insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
    values (app.business_id(), v_contact, 'email', 'temp@example.com', 'temp@example.com');
  delete from crm.records where id = v_contact;
  if exists (select 1 from crm.contacts where id = v_contact)
     or exists (select 1 from crm.contact_identities where contact_id = v_contact) then
    raise exception 'deleting the registry row should remove the contact and its identities';
  end if;
  raise notice 'ok: logs are append-only and records are deleted only through the registry';
end $$;

-- The private functions are the only ways across businesses, and they work.
do $$
declare
  v_business uuid;
begin
  if private.maintain_partitions() <> 0 then
    raise exception 'partitions should already exist three months ahead';
  end if;
  select business_id into v_business from private.resolve_phone_number('+14155550100');
  if v_business is distinct from current_setting('test.b1')::uuid then
    raise exception 'resolve_phone_number should find business 1';
  end if;
  raise notice 'ok: partition upkeep and inbound routing work through private functions';
end $$;

-- Contact search reads its indexes as the owner, outside row-level security (ADR-028), so
-- it keeps to the request's business itself. Both businesses have a Jordan at
-- jordan@example.com: business 1's search finds only its own, and no business, no search.
do $$
declare
  v_found uuid[];
  v_jordan uuid;
begin
  perform set_config('app.business_id', current_setting('test.b1'), true);
  select id into v_jordan from crm.contacts where first_name = 'Jordan';
  select array_agg(found.id) into v_found
    from (select distinct id from private.search_contacts('jordan:*', '%jordan%', '4155550123', 100) as found (id)) found;
  if v_found is distinct from array[v_jordan] then
    raise exception 'search_contacts should find only business 1''s Jordan, found %', v_found;
  end if;
  perform set_config('app.business_id', '', true);
  begin
    perform private.search_contacts('jordan:*', null, null, 100);
    raise exception 'search_contacts should refuse to search without a business';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok: contact search finds only the business the request works in, and needs one';
end $$;

-- Company and deal search work the same way (ADR-033). Business 1 has the Lee Family and
-- the Lee wedding; business 2 has neither, so its search finds nothing, and no business,
-- no search.
do $$
declare
  v_companies uuid[];
  v_deals uuid[];
begin
  perform set_config('app.business_id', current_setting('test.b1'), true);
  select array_agg(distinct found.id) into v_companies
    from private.search_companies('lee:*', '%famil%', 100) as found (id);
  if v_companies is distinct from array(select id from crm.companies where name = 'Lee Family') then
    raise exception 'search_companies should find business 1''s Lee Family, found %', v_companies;
  end if;
  select array_agg(distinct found.id) into v_deals
    from private.search_deals('wed:*', '%wedd%', 100) as found (id);
  if v_deals is distinct from array(select id from crm.deals where name = 'Lee wedding') then
    raise exception 'search_deals should find business 1''s Lee wedding, found %', v_deals;
  end if;
  perform set_config('app.business_id', current_setting('test.b2'), true);
  if exists (select from private.search_companies('lee:*', '%lee%', 100))
     or exists (select from private.search_deals('lee:*', '%lee%', 100)) then
    raise exception 'business 2 should find none of business 1''s companies or deals';
  end if;
  perform set_config('app.business_id', '', true);
  begin
    perform private.search_companies('lee:*', null, 100);
    raise exception 'search_companies should refuse to search without a business';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform private.search_deals('lee:*', null, 100);
    raise exception 'search_deals should refuse to search without a business';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok: company and deal search find only the business the request works in, and need one';
end $$;

-- Records of a custom object are searched the same way (0128): by their title's words and
-- any part of it (03_integrity.sql tries a searchable field). Business 1's event is found
-- both ways; business 2 finds nothing even with business 1's object, and no business, no
-- search.
do $$
declare
  v_event_type uuid;
  v_found uuid[];
begin
  perform set_config('app.business_id', current_setting('test.b1'), true);
  select id into strict v_event_type from crm.object_types where key = 'event';
  select array_agg(distinct found.id) into v_found
    from private.search_custom_records(v_event_type, 'wedd:*', null, 100) as found (id);
  if v_found is distinct from array(select id from crm.custom_records where title like 'Lee wedding%') then
    raise exception 'search_custom_records should find business 1''s event by its words, found %', v_found;
  end if;
  select array_agg(distinct found.id) into v_found
    from private.search_custom_records(v_event_type, null, '%12 jun%', 100) as found (id);
  if cardinality(v_found) is distinct from 1 then
    raise exception 'search_custom_records should find business 1''s event by part of its name, found %', v_found;
  end if;
  perform set_config('app.business_id', current_setting('test.b2'), true);
  if exists (select from private.search_custom_records(v_event_type, 'lee:*', '%lee%', 100)) then
    raise exception 'business 2 should find none of business 1''s events';
  end if;
  perform set_config('app.business_id', '', true);
  begin
    perform private.search_custom_records(v_event_type, 'lee:*', null, 100);
    raise exception 'search_custom_records should refuse to search without a business';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok: custom record search finds only the business the request works in, and needs one';
end $$;

-- Task lists page newest first through their indexes under row-level security (ADR-034).
-- With sequential scans and sorts discouraged, each list's plan must read an index in order:
-- one with no index that gives the order still sorts, and fails here.
do $$
declare
  v_record uuid;
  v_task uuid;
  v_person uuid;
  v_plan text;
begin
  perform set_config('app.business_id', current_setting('test.b1'), true);
  perform set_config('enable_seqscan', 'off', true);
  perform set_config('enable_sort', 'off', true);
  select record_id, id into v_record, v_task from crm.tasks where record_id is not null limit 1;
  select assignee_user_id into v_person from crm.tasks where assignee_user_id is not null limit 1;
  if v_record is null or v_person is null then
    raise exception 'expected business 1 to have a task on a record, assigned to someone';
  end if;

  execute 'explain (format json, costs off) select id from crm.tasks
    where completed_at is null order by created_at desc, id desc limit 51' into v_plan;
  if v_plan like '%Sort"%' or v_plan not like '%tasks_open_list_idx%' then
    raise exception 'the open task list should read tasks_open_list_idx in order: %', v_plan;
  end if;

  execute 'explain (format json, costs off) select id from crm.tasks
    order by created_at desc, id desc limit 51' into v_plan;
  if v_plan like '%Sort"%' or v_plan not like '%tasks_list_idx%' then
    raise exception 'the task list of every status should read tasks_list_idx in order: %', v_plan;
  end if;

  execute format('explain (format json, costs off) select id from crm.tasks
    where record_id = %L order by created_at desc, id desc limit 51', v_record) into v_plan;
  if v_plan like '%Sort"%' or v_plan not like '%tasks_record_idx%' then
    raise exception 'a record''s task list should read tasks_record_idx in order: %', v_plan;
  end if;

  execute format('explain (format json, costs off) select id from crm.tasks
    where assignee_user_id = %L order by created_at desc, id desc limit 51', v_person) into v_plan;
  if v_plan like '%Sort"%' or v_plan not like '%tasks_mine_idx%' then
    raise exception 'a person''s task list should read tasks_mine_idx in order: %', v_plan;
  end if;

  execute format('explain (format json, costs off) select id from crm.tasks
    where assignee_user_id = %L and completed_at is null
    order by created_at desc, id desc limit 51', v_person) into v_plan;
  if v_plan like '%Sort"%' or v_plan not like '%tasks_open_mine_idx%' then
    raise exception 'a person''s open tasks should read tasks_open_mine_idx in order: %', v_plan;
  end if;

  -- A later page starts at its cursor, in the index.
  execute format('explain (format json, costs off) select id from crm.tasks
    where completed_at is null
      and created_at <= (select created_at from crm.tasks where id = %1$L)
      and (created_at < (select created_at from crm.tasks where id = %1$L) or id < %1$L)
    order by created_at desc, id desc limit 51', v_task) into v_plan;
  if v_plan like '%Sort"%' or v_plan not like '%"Index Cond"%created_at <=%' then
    raise exception 'a later page of tasks should start at its cursor in the index: %', v_plan;
  end if;
  raise notice 'ok: task lists page newest first through their indexes, under row-level security';
end $$;

-- Saved views (ADR-035): tenant isolation keeps businesses apart, and restrictive policies
-- keep a private view its owner's alone. Only the owner acting as themselves counts: agency
-- staff, an API key and an actor carrying the owner's id on their behalf see shared views
-- only, and nobody writes a view for someone else or makes someone else's view private.
do $$
declare
  v_type uuid;
  v_private uuid;
  v_shared uuid;
  v_rows bigint;
begin
  perform set_config('app.agency_id', current_setting('test.a1'), true);
  perform set_config('app.business_id', current_setting('test.b1'), true);
  perform set_config('app.actor_kind', 'user', true);
  perform set_config('app.user_id', current_setting('test.u2'), true);
  perform set_config('app.actor_id', current_setting('test.u2'), true);
  select id into strict v_type from crm.object_types where kind = 'contact';
  select id into strict v_private from crm.saved_views where visibility = 'private';
  select id into strict v_shared from crm.saved_views where visibility = 'shared';
  -- The owner may make their shared view private, and share it again.
  update crm.saved_views set visibility = 'private' where id = v_shared;
  get diagnostics v_rows = row_count;
  update crm.saved_views set visibility = 'shared' where id = v_shared;
  if v_rows <> 1 then
    raise exception 'the owner should be able to make their shared view private';
  end if;

  -- The agency's owner works in business 1 too, as someone else.
  perform set_config('app.user_id', current_setting('test.u1'), true);
  perform set_config('app.actor_id', current_setting('test.u1'), true);
  if exists (select 1 from crm.saved_views where id = v_private) then
    raise exception 'agency staff should not see another person''s private view';
  end if;
  if not exists (select 1 from crm.saved_views where id = v_shared) then
    raise exception 'a shared view should be visible to everyone in the business';
  end if;
  update crm.saved_views set name = 'Taken over' where id = v_private;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'another person should not be able to change a private view';
  end if;
  delete from crm.saved_views where id = v_private;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'another person should not be able to delete a private view';
  end if;
  -- A write that reads no column skips the select policies, so the owner policy must cover
  -- writes too: this one may reach the shared view only.
  update crm.saved_views set updated_at = now();
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'a write that reads no column should reach the shared view only, not % views', v_rows;
  end if;
  begin
    insert into crm.saved_views (business_id, object_type_id, name, owner_user_id)
      values (app.business_id(), v_type, 'Planted', current_setting('test.u2')::uuid);
    raise exception 'expected the policy to reject a view written for someone else';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into crm.saved_views (business_id, object_type_id, name, visibility, owner_user_id)
      values (app.business_id(), v_type, 'Planted and shared', 'shared',
              current_setting('test.u2')::uuid);
    raise exception 'expected the policy to reject a shared view written for someone else';
  exception when insufficient_privilege then null;
  end;
  begin
    update crm.saved_views set visibility = 'private' where id = v_shared;
    raise exception 'expected the policy to reject making someone else''s view private';
  exception when insufficient_privilege then null;
  end;

  -- Carrying the owner's id isn't enough: another kind of actor, or another actor of the
  -- owner's kind, is not the owner acting themselves.
  perform set_config('app.user_id', current_setting('test.u2'), true);
  perform set_config('app.actor_kind', 'ai_agent', true);
  perform set_config('app.actor_id', current_setting('test.u2'), true);
  if exists (select 1 from crm.saved_views where id = v_private) then
    raise exception 'an AI agent carrying a person''s id should not see their private views';
  end if;
  begin
    insert into crm.saved_views (business_id, object_type_id, name, visibility, owner_user_id)
      values (app.business_id(), v_type, 'Agent view', 'shared', current_setting('test.u2')::uuid);
    raise exception 'expected the policy to reject a view an AI agent writes for a person';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.actor_kind', 'user', true);
  perform set_config('app.actor_id', uuidv7()::text, true);
  if exists (select 1 from crm.saved_views where id = v_private) then
    raise exception 'another actor carrying a person''s id should not see their private views';
  end if;
  begin
    insert into crm.saved_views (business_id, object_type_id, name, visibility, owner_user_id)
      values (app.business_id(), v_type, 'Borrowed view', 'shared', current_setting('test.u2')::uuid);
    raise exception 'expected the policy to reject a view another actor writes for a person';
  exception when insufficient_privilege then null;
  end;

  -- An API key: no person at all.
  perform set_config('app.user_id', '', true);
  perform set_config('app.actor_kind', 'api_key', true);
  if (select array_agg(id) from crm.saved_views) is distinct from array[v_shared] then
    raise exception 'an API key should see the shared view only';
  end if;
  begin
    insert into crm.saved_views (business_id, object_type_id, name, visibility, owner_user_id)
      values (app.business_id(), v_type, 'Machine view', 'shared', current_setting('test.u2')::uuid);
    raise exception 'expected the policy to reject a view written by a machine';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: a private saved view is its owner''s alone, and only people write views';
end $$;

-- Notifications (0056, ADR-065): scoped isolation keeps agencies and businesses apart, and
-- restrictive policies make a notification its person's alone, while they belong to the
-- business. Only that person acting themselves reads and marks it; only the worker writes
-- one, and only for someone who belongs; nobody else reads a person's preferences.
do $$
declare
  v_note uuid;
  v_rows bigint;
begin
  perform set_config('app.agency_id', current_setting('test.a1'), true);
  perform set_config('app.business_id', current_setting('test.b1'), true);
  perform set_config('app.actor_kind', 'user', true);
  perform set_config('app.user_id', current_setting('test.u2'), true);
  perform set_config('app.actor_id', current_setting('test.u2'), true);
  select id into strict v_note from notifications.notifications;
  if (select count(*) from notifications.preferences) <> 1 then
    raise exception 'a person should read their own notification preferences';
  end if;

  -- The person changes whether it is read, and nothing else; nobody deletes one.
  begin
    update notifications.notifications set kind = 'task.due' where id = v_note;
    raise exception 'expected crm_app to be unable to rewrite a notification';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from notifications.notifications where id = v_note;
    raise exception 'expected crm_app to be unable to delete a notification';
  exception when insufficient_privilege then null;
  end;
  -- A person cannot write themselves, or anyone, a notification.
  begin
    insert into notifications.notifications (agency_id, business_id, user_id, kind, source_key, actor_kind, subject_kind)
      values (app.agency_id(), app.business_id(), app.user_id(), 'ai.limit_reached', 'planted', 'system', 'ai_settings');
    raise exception 'expected the policy to reject a notification written by a person';
  exception when insufficient_privilege then null;
  end;

  -- Without the membership the notification is hidden at once, and cannot be marked.
  begin
    delete from tenancy.memberships
      where user_id = current_setting('test.u2')::uuid and business_id = current_setting('test.b1')::uuid;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'the fixture should have exactly one membership to remove';
    end if;
    if exists (select 1 from notifications.notifications) then
      raise exception 'a person who left the business should not see its notifications';
    end if;
    update notifications.notifications set read_at = now();
    get diagnostics v_rows = row_count;
    if v_rows <> 0 then
      raise exception 'a person who left the business should not mark its notifications';
    end if;
    -- Put the membership back: only this nested block is undone.
    raise exception using errcode = 'NTF01', message = 'undo';
  exception when sqlstate 'NTF01' then null;
  end;
  if not exists (select 1 from notifications.notifications where id = v_note and read_at is null) then
    raise exception 'the notification should be back, unread, with the membership';
  end if;

  -- The agency's owner works in business 1 too, as someone else.
  perform set_config('app.user_id', current_setting('test.u1'), true);
  perform set_config('app.actor_id', current_setting('test.u1'), true);
  if exists (select 1 from notifications.notifications)
     or exists (select 1 from notifications.preferences) then
    raise exception 'agency staff should not see another person''s notifications or preferences';
  end if;
  -- A write that reads no column skips the select policies: the update policy holds alone.
  update notifications.notifications set read_at = now();
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'another person should not be able to mark a notification read';
  end if;
  update notifications.preferences set in_app = true;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'another person should not be able to change a person''s preferences';
  end if;
  begin
    insert into notifications.preferences (business_id, user_id, kind, in_app)
      values (app.business_id(), current_setting('test.u2')::uuid, 'task.due', false);
    raise exception 'expected the policy to reject a preference written for someone else';
  exception when insufficient_privilege then null;
  end;

  -- Carrying the person's id isn't enough: an assistant, another actor of the person's
  -- kind, and an API key are not the person acting themselves.
  perform set_config('app.user_id', current_setting('test.u2'), true);
  perform set_config('app.actor_kind', 'ai_agent', true);
  perform set_config('app.actor_id', current_setting('test.u2'), true);
  if exists (select 1 from notifications.notifications)
     or exists (select 1 from notifications.preferences) then
    raise exception 'an AI agent carrying a person''s id should not see their notifications';
  end if;
  perform set_config('app.actor_kind', 'user', true);
  perform set_config('app.actor_id', uuidv7()::text, true);
  if exists (select 1 from notifications.notifications) then
    raise exception 'another actor carrying a person''s id should not see their notifications';
  end if;
  perform set_config('app.user_id', '', true);
  perform set_config('app.actor_kind', 'api_key', true);
  if exists (select 1 from notifications.notifications)
     or exists (select 1 from notifications.preferences) then
    raise exception 'an API key should see no notifications and no preferences';
  end if;

  -- The worker reads both, to keep one notification per source and to leave out what a
  -- person turned off. It marks nothing read, changes no preference, and writes only for
  -- someone who belongs: agency 2's person is refused.
  perform set_config('app.actor_kind', 'system', true);
  perform set_config('app.actor_id', '', true);
  if (select count(*) from notifications.notifications) <> 1
     or (select count(*) from notifications.preferences) <> 1 then
    raise exception 'the worker should read the business''s notifications and preferences';
  end if;
  update notifications.notifications set read_at = now();
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'the worker should not mark a person''s notification read';
  end if;
  begin
    insert into notifications.preferences (business_id, user_id, kind, in_app)
      values (app.business_id(), current_setting('test.u2')::uuid, 'task.due', false);
    raise exception 'expected the policy to reject a preference written by the worker';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into notifications.notifications (agency_id, business_id, user_id, kind, source_key, actor_kind, subject_kind)
      values (app.agency_id(), app.business_id(), 'eeeeeee3-0000-7000-8000-000000000000',
              'ai.limit_reached', 'outsider', 'system', 'ai_settings');
    raise exception 'expected the policy to reject a notification for someone outside the business';
  exception when insufficient_privilege then null;
  end;

  -- The person marks it read: once, and the first time stays.
  perform set_config('app.actor_kind', 'user', true);
  perform set_config('app.user_id', current_setting('test.u2'), true);
  perform set_config('app.actor_id', current_setting('test.u2'), true);
  update notifications.notifications set read_at = '2026-10-01T00:00:00Z' where id = v_note;
  update notifications.notifications set read_at = now() where id = v_note;
  if (select read_at from notifications.notifications where id = v_note) <> '2026-10-01T00:00:00Z' then
    raise exception 'a notification should keep the first time it was read';
  end if;
  raise notice 'ok: a notification is its person''s alone while they belong, and only the worker writes one';
end $$;

-- The in-app assistant's conversations (0084, ADR-084): tenant isolation keeps businesses
-- apart, and a restrictive policy on each table makes a thread, its turns and its messages
-- their person's alone. Only that person acting themselves, and the worker that runs the
-- turn, read or write them.
do $$
declare
  v_thread uuid;
  v_turn uuid;
  v_rows bigint;
begin
  perform set_config('app.agency_id', current_setting('test.a1'), true);
  perform set_config('app.business_id', current_setting('test.b1'), true);
  perform set_config('app.actor_kind', 'user', true);
  perform set_config('app.user_id', current_setting('test.u2'), true);
  perform set_config('app.actor_id', current_setting('test.u2'), true);
  select id into strict v_thread from ai.assistant_threads;
  select id into strict v_turn from ai.assistant_turns;
  if (select count(*) from ai.assistant_messages) <> 1 then
    raise exception 'a person should read the messages of their own thread';
  end if;

  -- A message is written once: crm_app neither rewrites nor deletes one, nor deletes a turn.
  begin
    update ai.assistant_messages set text = 'rewritten';
    raise exception 'expected crm_app to be unable to rewrite an assistant message';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from ai.assistant_messages;
    raise exception 'expected crm_app to be unable to delete an assistant message';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from ai.assistant_turns;
    raise exception 'expected crm_app to be unable to delete an assistant turn';
  exception when insufficient_privilege then null;
  end;
  -- One turn of a thread at a time, and a message keeps its place in the thread.
  begin
    insert into ai.assistant_turns (business_id, thread_id, user_id, page, correlation_id)
      values (app.business_id(), v_thread, app.user_id(), '{"route": "/forms"}', uuidv7());
    raise exception 'expected a second open turn of a thread to be refused';
  exception when unique_violation then null;
  end;
  begin
    insert into ai.assistant_messages (business_id, thread_id, turn_id, user_id, seq, kind, text)
      values (app.business_id(), v_thread, v_turn, app.user_id(), 1, 'assistant', 'Again');
    raise exception 'expected a second message with the same place to be refused';
  exception when unique_violation then null;
  end;

  -- The agency's owner works in business 1 too, as someone else: nothing to read, nothing
  -- to change, and no way to plant a thread, a turn or a message on Dana.
  perform set_config('app.user_id', current_setting('test.u1'), true);
  perform set_config('app.actor_id', current_setting('test.u1'), true);
  if exists (select 1 from ai.assistant_threads) or exists (select 1 from ai.assistant_turns)
     or exists (select 1 from ai.assistant_messages) then
    raise exception 'a colleague should not see another person''s assistant conversations';
  end if;
  update ai.assistant_threads set title = 'taken';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'a colleague should not be able to change another person''s thread';
  end if;
  update ai.assistant_turns set cancel_requested_at = now();
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'a colleague should not be able to cancel another person''s turn';
  end if;
  delete from ai.assistant_threads;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'a colleague should not be able to delete another person''s thread';
  end if;
  begin
    insert into ai.assistant_threads (business_id, user_id, title)
      values (app.business_id(), current_setting('test.u2')::uuid, 'planted');
    raise exception 'expected the policy to reject a thread written for someone else';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into ai.assistant_messages (business_id, thread_id, turn_id, user_id, seq, kind, text)
      values (app.business_id(), v_thread, v_turn, current_setting('test.u2')::uuid, 2, 'assistant', 'planted');
    raise exception 'expected a message written into someone else''s thread to be refused';
  -- The turn is not theirs to see, so the message has no turn to belong to.
  exception when insufficient_privilege or check_violation then null;
  end;
  -- Nor a turn of their own in Dana's thread: a turn belongs to its thread's person.
  begin
    insert into ai.assistant_turns (business_id, thread_id, user_id, page, correlation_id)
      values (app.business_id(), v_thread, app.user_id(), '{"route": "/forms"}', uuidv7());
    raise exception 'expected a turn in someone else''s thread to be refused';
  exception when check_violation then null;
  end;

  -- Carrying the person's id isn't enough: an assistant running a tool for Dana, another
  -- actor of her kind, and an API key are not Dana acting herself.
  perform set_config('app.user_id', current_setting('test.u2'), true);
  perform set_config('app.actor_kind', 'ai_agent', true);
  perform set_config('app.actor_id', '', true);
  if exists (select 1 from ai.assistant_threads) or exists (select 1 from ai.assistant_turns)
     or exists (select 1 from ai.assistant_messages) then
    raise exception 'an AI agent carrying a person''s id should not see their conversations';
  end if;
  perform set_config('app.actor_kind', 'user', true);
  perform set_config('app.actor_id', uuidv7()::text, true);
  if exists (select 1 from ai.assistant_threads) or exists (select 1 from ai.assistant_messages) then
    raise exception 'another actor carrying a person''s id should not see their conversations';
  end if;
  perform set_config('app.user_id', '', true);
  perform set_config('app.actor_kind', 'api_key', true);
  if exists (select 1 from ai.assistant_threads) or exists (select 1 from ai.assistant_turns)
     or exists (select 1 from ai.assistant_messages) then
    raise exception 'an API key should see no assistant conversations';
  end if;

  -- The worker runs the turn: it reads the thread, marks the turn and writes its messages.
  perform set_config('app.actor_kind', 'system', true);
  perform set_config('app.actor_id', '', true);
  if (select count(*) from ai.assistant_threads) <> 1 or (select count(*) from ai.assistant_messages) <> 1 then
    raise exception 'the worker should read the business''s assistant conversations';
  end if;
  update ai.assistant_turns set status = 'running', started_at = now() where id = v_turn;
  insert into ai.assistant_messages (business_id, thread_id, turn_id, user_id, seq, kind, text, activity)
    values (app.business_id(), v_thread, v_turn, current_setting('test.u2')::uuid, 2, 'activity',
            'Listed the forms', '{"operationId": "listForms", "effect": "read", "ok": true, "target": null}');
  -- A message belongs to its turn's thread and person, whoever writes it.
  begin
    insert into ai.assistant_messages (business_id, thread_id, turn_id, user_id, seq, kind, text)
      values (app.business_id(), v_thread, v_turn, current_setting('test.u1')::uuid, 3, 'assistant', 'Hello');
    raise exception 'expected a message for another person than its turn''s to be refused';
  exception when check_violation then null;
  end;
  update ai.assistant_turns set status = 'finished', outcome = 'answered', finished_at = now() where id = v_turn;

  -- Dana deletes her thread, and its turns and messages go with it.
  perform set_config('app.actor_kind', 'user', true);
  perform set_config('app.user_id', current_setting('test.u2'), true);
  perform set_config('app.actor_id', current_setting('test.u2'), true);
  begin
    delete from ai.assistant_threads where id = v_thread;
    if exists (select 1 from ai.assistant_turns) or exists (select 1 from ai.assistant_messages) then
      raise exception 'deleting a thread should remove its turns and messages';
    end if;
    -- Keep the fixture: only this nested block is undone.
    raise exception using errcode = 'AST01', message = 'undo';
  exception when sqlstate 'AST01' then null;
  end;
  raise notice 'ok: an assistant conversation is its person''s alone, and only the worker runs its turns';
end $$;

-- A browser calling token is its person's alone: tenant isolation keeps businesses apart,
-- and a restrictive policy lets only that person acting themselves, or the worker, read it.
do $$
declare
  v_rows bigint;
begin
  perform set_config('app.agency_id', current_setting('test.a1'), true);
  perform set_config('app.business_id', current_setting('test.b1'), true);
  perform set_config('app.actor_kind', 'user', true);
  perform set_config('app.user_id', current_setting('test.u2'), true);
  perform set_config('app.actor_id', current_setting('test.u2'), true);
  if (select count(*) from messaging.voice_grants where token is not null) <> 1 then
    raise exception 'a person should read their own calling token';
  end if;

  -- A colleague in the same business: nothing to read, change, or plant on Dana.
  perform set_config('app.user_id', current_setting('test.u1'), true);
  perform set_config('app.actor_id', current_setting('test.u1'), true);
  if exists (select 1 from messaging.voice_grants) then
    raise exception 'a colleague should not see another person''s calling token';
  end if;
  update messaging.voice_grants set token = null;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'a colleague should not be able to change another person''s calling token';
  end if;
  begin
    insert into messaging.voice_grants (business_id, user_id, connection_id)
      select app.business_id(), current_setting('test.u2')::uuid, connection_id
      from messaging.voice_setups limit 1;
    raise exception 'expected the policy to reject a calling token request made for someone else';
  exception when insufficient_privilege then null;
  end;

  -- Carrying Dana's id is not Dana acting herself, and an API key sees no token.
  perform set_config('app.user_id', current_setting('test.u2'), true);
  perform set_config('app.actor_kind', 'ai_agent', true);
  perform set_config('app.actor_id', '', true);
  if exists (select 1 from messaging.voice_grants) then
    raise exception 'an AI agent carrying a person''s id should not see their calling token';
  end if;
  perform set_config('app.user_id', '', true);
  perform set_config('app.actor_kind', 'api_key', true);
  if exists (select 1 from messaging.voice_grants) then
    raise exception 'an API key should see no calling token';
  end if;

  -- The worker issues tokens: it reads and writes them.
  perform set_config('app.actor_kind', 'system', true);
  if (select count(*) from messaging.voice_grants) <> 1 then
    raise exception 'the worker should read the business''s calling token requests';
  end if;
  raise notice 'ok: a calling token is its person''s alone, and only the worker issues it';
end $$;

-- Migration 0095's receipts are private like conversation messages, and only the worker
-- can attest completion. A person, API key or tool invocation cannot forge a receipt.
do $$
declare
  v_thread uuid;
  v_turn uuid;
  v_call uuid;
  v_rows bigint;
begin
  perform set_config('app.agency_id', current_setting('test.a1'), true);
  perform set_config('app.business_id', current_setting('test.b1'), true);
  perform set_config('app.actor_kind', 'system', true);
  perform set_config('app.actor_id', '', true);
  perform set_config('app.user_id', '', true);
  select id into strict v_thread from ai.assistant_threads;
  select id into strict v_turn from ai.assistant_turns;
  insert into ai.assistant_tool_calls (business_id, thread_id, turn_id, user_id, call_id, operation_id, effect)
    values (app.business_id(), v_thread, v_turn, current_setting('test.u2')::uuid, 'isolation:call', 'getContact', 'read')
    returning id into v_call;

  perform set_config('app.actor_kind', 'user', true);
  perform set_config('app.user_id', current_setting('test.u2'), true);
  perform set_config('app.actor_id', current_setting('test.u2'), true);
  if not exists (select 1 from ai.assistant_tool_calls where id = v_call) then
    raise exception 'a person should see their own tool receipt';
  end if;
  update ai.assistant_tool_calls set state = 'completed', finished_at = now() where id = v_call;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then raise exception 'a person must not forge completion'; end if;
  begin
    insert into ai.assistant_tool_calls (business_id, thread_id, turn_id, user_id, call_id, operation_id, effect)
      values (app.business_id(), v_thread, v_turn, app.user_id(), 'forged', 'getContact', 'read');
    raise exception 'a person must not admit a tool call';
  exception when insufficient_privilege then null;
  end;

  perform set_config('app.user_id', current_setting('test.u1'), true);
  perform set_config('app.actor_id', current_setting('test.u1'), true);
  if exists (select 1 from ai.assistant_tool_calls) then raise exception 'a colleague must not see receipts'; end if;
  perform set_config('app.user_id', current_setting('test.u2'), true);
  perform set_config('app.actor_kind', 'ai_agent', true);
  if exists (select 1 from ai.assistant_tool_calls) then raise exception 'an AI tool must not see receipts'; end if;
  perform set_config('app.actor_kind', 'api_key', true);
  if exists (select 1 from ai.assistant_tool_calls) then raise exception 'an API key must not see receipts'; end if;
  perform set_config('app.actor_kind', 'system', true);
  perform set_config('app.business_id', current_setting('test.b2'), true);
  if exists (select 1 from ai.assistant_tool_calls where id = v_call) then raise exception 'another business must not see receipts'; end if;
  perform set_config('app.business_id', current_setting('test.b1'), true);
  update ai.assistant_tool_calls set state = 'completed', finished_at = now() where id = v_call;
  if not exists (select 1 from ai.assistant_tool_calls where id = v_call and state = 'completed') then
    raise exception 'the worker should attest completion';
  end if;
  perform set_config('app.actor_kind', 'user', true);
  perform set_config('app.actor_id', current_setting('test.u2'), true);
  begin
    delete from ai.assistant_threads where id = v_thread;
    if exists (select 1 from ai.assistant_tool_calls where id = v_call) then
      raise exception 'deleting a thread should remove its receipts';
    end if;
    raise exception using errcode = 'AST02', message = 'undo';
  exception when sqlstate 'AST02' then null;
  end;
  raise notice 'ok: tool receipts are private and only the worker attests completion';
end $$;

reset role;
