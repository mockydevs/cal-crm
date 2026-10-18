-- Integrity rules the database enforces on its own, whatever the application does.
-- Each block attempts something invalid and expects one specific error; a block that
-- succeeds, or fails with a different error, stops the suite.
-- Runs after 02_tenant_isolation.sql and reuses its fixture.

\set ON_ERROR_STOP on
set client_min_messages = notice;

\set a1 'aaaaaaa1-0000-7000-8000-000000000000'
\set b1 'bbbbbbb1-0000-7000-8000-000000000000'
\set b2 'bbbbbbb2-0000-7000-8000-000000000000'
\set u2 'eeeeeee2-0000-7000-8000-000000000000'
set test.b2 = :'b2';

-- Cross-business references, attempted as the owner (which bypasses row-level security),
-- so only the composite foreign keys stand in the way.

set role crm_owner;

do $$
declare
  b1 constant uuid := 'bbbbbbb1-0000-7000-8000-000000000000';
  b2 constant uuid := 'bbbbbbb2-0000-7000-8000-000000000000';
  v_pipeline_b2 uuid;
  v_stage_b2 uuid;
  v_deal_type uuid;
  v_deal uuid := uuidv7();
begin
  insert into crm.pipelines (business_id, name) values (b2, 'Sales') returning id into v_pipeline_b2;
  insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
    values (b2, v_pipeline_b2, 'New lead', 0) returning id into v_stage_b2;
  select id into v_deal_type from crm.object_types where business_id = b1 and kind = 'deal';
  begin
    insert into crm.records (business_id, id, kind, object_type_id) values (b1, v_deal, 'deal', v_deal_type);
    insert into crm.deals (business_id, id, name, pipeline_id, stage_id, currency, created_by_kind)
      values (b1, v_deal, 'Cross-business deal', v_pipeline_b2, v_stage_b2, 'USD', 'user');
    raise exception 'expected a deal in business 1 to be unable to use a business 2 stage';
  exception when foreign_key_violation then null;
  end;
  raise notice 'ok: a row can''t reference another business''s rows, even bypassing row-level security';
end $$;

do $$
declare
  v_secret_b2 uuid;
  v_account uuid := uuidv7();
begin
  select id into v_secret_b2 from vault.secrets where business_id = 'bbbbbbb2-0000-7000-8000-000000000000';
  begin
    insert into messaging.channel_accounts (business_id, id, channel, name)
      values ('bbbbbbb1-0000-7000-8000-000000000000', v_account, 'email', 'Borrowed secret');
    insert into messaging.mailboxes (business_id, id, email_address, auth_method, secret_id)
      values ('bbbbbbb1-0000-7000-8000-000000000000', v_account, 'x@harborlights.example', 'google_oauth', v_secret_b2);
    raise exception 'expected a mailbox to be unable to use another business''s secret';
  exception when foreign_key_violation then null;
  end;
  raise notice 'ok: a mailbox can only use its own business''s secret';
end $$;

do $$
begin
  begin
    insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
      values ('eeeeeee1-0000-7000-8000-000000000000', 'aaaaaaa1-0000-7000-8000-000000000000',
              'bbbbbbb2-0000-7000-8000-000000000000', 'cccccc01-0000-7000-8000-000000000000');
    raise exception 'expected an agency role to be rejected for a business membership';
  exception when foreign_key_violation then null;
  end;
  raise notice 'ok: agency roles and business roles can''t be mixed up';
end $$;

do $$
begin
  begin
    insert into events.events (agency_id, business_id, recorded_at, type, actor_kind, correlation_id, subject_kind, subject_id)
      values ('aaaaaaa1-0000-7000-8000-000000000000', 'bbbbbbb1-0000-7000-8000-000000000000',
              now() + interval '5 years', 'contact.created', 'system', uuidv7(), 'record', uuidv7());
    raise exception 'expected an event outside every partition to fail loudly';
  exception when check_violation then null;
  end;
  raise notice 'ok: a missing partition is an error, never a silent default';
end $$;

do $$
declare
  v_constraint text;
begin
  begin
    insert into events.events (agency_id, business_id, occurred_at, type, actor_kind, correlation_id, subject_kind, subject_id)
      values ('aaaaaaa1-0000-7000-8000-000000000000', 'bbbbbbb1-0000-7000-8000-000000000000',
              now() + interval '1 second', 'contact.created', 'system', uuidv7(), 'record', uuidv7());
    raise exception 'expected an event recorded before it happened to be rejected';
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'events_recorded_after_occurred' then
      raise;
    end if;
  end;
  -- Imported history keeps its real, earlier date.
  insert into events.events (agency_id, business_id, occurred_at, type, actor_kind, correlation_id, subject_kind, subject_id)
    values ('aaaaaaa1-0000-7000-8000-000000000000', 'bbbbbbb1-0000-7000-8000-000000000000',
            now() - interval '3 years', 'contact.created', 'import', uuidv7(), 'record', uuidv7());
  -- Partitions inherit the rule, including the ones maintenance adds later.
  if exists (
    select from pg_inherits i
    where i.inhparent = 'events.events'::regclass
      and not exists (select from pg_constraint c
                      where c.conrelid = i.inhrelid and c.conname = 'events_recorded_after_occurred')
  ) then
    raise exception 'expected every events partition to have events_recorded_after_occurred';
  end if;
  raise notice 'ok: an event is never recorded before it happened; imported history keeps its date';
end $$;

reset role;

-- Everything else runs as the application, inside business 1 ------------------------------

set role crm_app;
set app.agency_id = :'a1';
set app.business_id = :'b1';
set app.user_id = :'u2';

do $$
declare
  v_type uuid;
begin
  select id into v_type from crm.object_types where kind = 'contact';
  begin
    insert into crm.records (business_id, kind, object_type_id) values (app.business_id(), 'contact', v_type);
    set constraints crm.records_have_subtype immediate;
    raise exception 'expected a registry row without its contact row to be rejected';
  exception when foreign_key_violation then null;
  end;
  raise notice 'ok: every registry row needs its typed row';
end $$;

do $$
declare
  v_type uuid;
  v_id uuid := uuidv7();
begin
  select id into v_type from crm.object_types where kind = 'deal';
  begin
    insert into crm.records (business_id, id, kind, object_type_id) values (app.business_id(), v_id, 'deal', v_type);
    insert into crm.contacts (business_id, id, first_name, created_by_kind) values (app.business_id(), v_id, 'Wrong kind', 'user');
    raise exception 'expected a contact row on a deal registry row to be rejected';
  exception when foreign_key_violation then null;
  end;
  raise notice 'ok: a typed row must match its registry row''s kind';
end $$;

do $$
declare
  v_deal_type uuid;
  v_pipeline uuid;
  v_other_pipeline uuid;
  v_other_stage uuid;
  v_deal uuid := uuidv7();
begin
  select id into v_deal_type from crm.object_types where kind = 'deal';
  select id into v_pipeline from crm.pipelines where name = 'Weddings';
  insert into crm.pipelines (business_id, name) values (app.business_id(), 'Corporate') returning id into v_other_pipeline;
  insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
    values (app.business_id(), v_other_pipeline, 'Inquiry', 0) returning id into v_other_stage;
  begin
    insert into crm.records (business_id, id, kind, object_type_id) values (app.business_id(), v_deal, 'deal', v_deal_type);
    insert into crm.deals (business_id, id, name, pipeline_id, stage_id, currency, created_by_kind)
      values (app.business_id(), v_deal, 'Mismatched stage', v_pipeline, v_other_stage, 'USD', 'user');
    raise exception 'expected a stage from another pipeline to be rejected';
  exception when foreign_key_violation then null;
  end;
  raise notice 'ok: a deal''s stage must belong to its pipeline';
end $$;

do $$
begin
  begin
    update crm.deals set status = 'won' where name = 'Lee wedding';
    raise exception 'expected a won deal without closed_at to be rejected';
  exception when check_violation then null;
  end;
  begin
    update crm.deals set lost_note = 'Too expensive' where name = 'Lee wedding';
    raise exception 'expected lost details on an open deal to be rejected';
  exception when check_violation then null;
  end;
  update crm.deals set status = 'won', closed_at = now() where name = 'Lee wedding';
  update crm.deals set status = 'open', closed_at = null where name = 'Lee wedding';
  raise notice 'ok: deal status, close date and lost details stay consistent';
end $$;

do $$
declare
  v_deal uuid;
  v_event_date uuid;
  v_services uuid;
  v_deal_type uuid;
begin
  select id into v_deal from crm.deals where name = 'Lee wedding';
  select id into v_event_date from crm.field_definitions where key = 'event_date';
  select id into v_services from crm.field_definitions where key = 'services_wanted';
  select id into v_deal_type from crm.object_types where kind = 'deal';
  delete from crm.field_values where record_id = v_deal;

  begin
    insert into crm.field_values (business_id, record_id, field_id, value_type, value_number, source_kind)
      values (app.business_id(), v_deal, v_event_date, 'number', 5, 'user');
    raise exception 'expected a value typed differently from its field to be rejected';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into crm.field_values (business_id, record_id, field_id, value_type, value_text, source_kind)
      values (app.business_id(), v_deal, v_event_date, 'date', '2027-06-12', 'user');
    raise exception 'expected a date field stored as text to be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into crm.field_values (business_id, record_id, field_id, value_type, value_text, source_kind)
      values (app.business_id(), v_deal, v_services, 'multi_choice', 'Lighting', 'user');
    raise exception 'expected a choice field stored as text to be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into crm.field_definitions (business_id, object_type_id, key, label, value_type, created_by_kind)
      values (app.business_id(), v_deal_type, 'budget', 'Budget', 'money', 'user');
    raise exception 'expected a money field without a currency to be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into crm.field_definitions (business_id, object_type_id, key, label, value_type, created_by_kind)
      values (app.business_id(), v_deal_type, 'venue_type', 'Venue type', 'single_choice', 'user');
    raise exception 'expected a choice field without options to be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into crm.field_definitions (business_id, object_type_id, key, label, value_type, created_by_kind)
      values (app.business_id(), v_deal_type, 'event_day', 'EVENT DATE', 'date', 'user');
    raise exception 'expected a second field labelled "Event date" to be rejected';
  exception when unique_violation then null;
  end;
  raise notice 'ok: field values match their field''s type, and fields are well formed';
end $$;

do $$
begin
  insert into crm.tags (business_id, name, created_by_kind) values (app.business_id(), 'Hot Lead', 'user');
  begin
    insert into crm.tags (business_id, name, created_by_kind) values (app.business_id(), 'hot-lead', 'user');
    raise exception 'expected "hot-lead" to clash with "Hot Lead"';
  exception when unique_violation then null;
  end;
  begin
    insert into crm.tags (business_id, name, created_by_kind) values (app.business_id(), '  HOT_lead ', 'user');
    raise exception 'expected "  HOT_lead " to clash with "Hot Lead"';
  exception when unique_violation then null;
  end;
  raise notice 'ok: tag names that differ only in case, spaces, hyphens or underscores can''t coexist';
end $$;

do $$
declare
  v_contact uuid;
begin
  select id into v_contact from crm.contacts where first_name = 'Jordan';
  begin
    insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
      values (app.business_id(), v_contact, 'email', 'jordan@example.com', 'jordan@example.com');
    raise exception 'expected a duplicate email in the same business to be rejected';
  exception when unique_violation then null;
  end;
  begin
    insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
      values (app.business_id(), v_contact, 'email', 'Other@Example.com', 'Other@Example.com');
    raise exception 'expected an email that wasn''t lowercased to be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
      values (app.business_id(), v_contact, 'phone', '555-0123', '5550123');
    raise exception 'expected a phone number that isn''t E.164 to be rejected';
  exception when check_violation then null;
  end;
  raise notice 'ok: an email or phone number belongs to one contact per business, normalized';
end $$;

do $$
declare
  v_calendar uuid;
  v_contact uuid;
  v_start timestamptz := date_trunc('hour', now()) + interval '3 days';
begin
  select id into v_calendar from calendar.calendars where booking_slug = 'consult';
  select id into v_contact from crm.contacts where first_name = 'Jordan';
  insert into calendar.appointments (business_id, calendar_id, contact_id, assigned_user_id, title, starts_at, ends_at, source)
    values (app.business_id(), v_calendar, v_contact, app.user_id(), 'First', v_start, v_start + interval '1 hour', 'user');
  begin
    insert into calendar.appointments (business_id, calendar_id, contact_id, assigned_user_id, title, starts_at, ends_at, source)
      values (app.business_id(), v_calendar, v_contact, app.user_id(), 'Overlapping', v_start + interval '30 minutes',
              v_start + interval '90 minutes', 'ai_agent');
    raise exception 'expected an overlapping booking for the same person to be rejected';
  exception when exclusion_violation then null;
  end;
  insert into calendar.appointments (business_id, calendar_id, contact_id, assigned_user_id, title, starts_at, ends_at, source)
    values (app.business_id(), v_calendar, v_contact, app.user_id(), 'Back to back', v_start + interval '1 hour',
            v_start + interval '2 hours', 'user');
  insert into calendar.appointments (business_id, calendar_id, contact_id, assigned_user_id, title, starts_at, ends_at,
                                     status, cancelled_at, source)
    values (app.business_id(), v_calendar, v_contact, app.user_id(), 'Cancelled', v_start, v_start + interval '1 hour',
            'cancelled', now(), 'user');
  raise notice 'ok: nobody is double-booked; back-to-back and cancelled bookings are fine';
end $$;

do $$
declare
  v_conversation uuid;
  v_account uuid;
begin
  select id into v_conversation from messaging.conversations limit 1;
  select id into v_account from messaging.mailboxes where email_address = 'dana@harborlights.example';
  insert into messaging.messages (business_id, conversation_id, channel, channel_account_id, direction, status, body_text,
                                  idempotency_key, author_kind)
    values (app.business_id(), v_conversation, 'email', v_account, 'outbound', 'queued', 'Once', 'step:abc:1', 'automation');
  begin
    insert into messaging.messages (business_id, conversation_id, channel, channel_account_id, direction, status, body_text,
                                    idempotency_key, author_kind)
      values (app.business_id(), v_conversation, 'email', v_account, 'outbound', 'queued', 'Twice', 'step:abc:1', 'automation');
    raise exception 'expected a repeated idempotency key to be rejected';
  exception when unique_violation then null;
  end;
  begin
    insert into messaging.messages (business_id, conversation_id, channel, channel_account_id, direction, status, body_text, author_kind)
      values (app.business_id(), v_conversation, 'email', v_account, 'outbound', 'queued', 'No key', 'user');
    raise exception 'expected an outbound message without an idempotency key to be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into messaging.messages (business_id, conversation_id, channel, channel_account_id, direction, status, body_text,
                                    email_message_id, author_kind)
      values (app.business_id(), v_conversation, 'email', v_account, 'inbound', 'received', 'Again', '<reply-1@example.com>', 'contact');
    raise exception 'expected the same inbound Message-ID on the same mailbox to be rejected';
  exception when unique_violation then null;
  end;
  begin
    insert into messaging.messages (business_id, conversation_id, channel, channel_account_id, direction, status, body_text,
                                    idempotency_key, author_kind)
      values (app.business_id(), v_conversation, 'sms', v_account, 'outbound', 'queued', 'Wrong account', 'sms:1', 'user');
    raise exception 'expected an SMS through a mailbox to be rejected';
  exception when foreign_key_violation then null;
  end;
  raise notice 'ok: no double sends, no duplicate inbound mail, accounts match their channel';
end $$;

do $$
declare
  v_automation uuid;
  v_version uuid;
  v_contact uuid;
  v_first uuid;
begin
  select id, published_version_id into v_automation, v_version from automation.automations where name = 'Follow up new leads';
  select id into v_contact from crm.contacts where first_name = 'Jordan';
  select id into v_first from automation.enrolments where automation_id = v_automation and record_id = v_contact;
  begin
    insert into automation.enrolments (business_id, automation_id, version_id, record_id, reentry_key, correlation_id)
      values (app.business_id(), v_automation, v_version, v_contact, v_contact, uuidv7());
    raise exception 'expected a second live enrolment of the same record to be rejected';
  exception when unique_violation then null;
  end;
  update automation.enrolments set status = 'completed', finished_at = now(), wake_at = null where id = v_first;
  insert into automation.enrolments (business_id, automation_id, version_id, record_id, reentry_key, correlation_id)
    values (app.business_id(), v_automation, v_version, v_contact, v_contact, uuidv7());
  raise notice 'ok: one live enrolment per record unless re-entry is allowed; a finished one frees it';
end $$;

do $$
declare
  v_conversation uuid;
  v_contact uuid;
begin
  select id, contact_id into v_conversation, v_contact from messaging.conversations limit 1;
  begin
    update messaging.conversations set status = 'snoozed' where id = v_conversation;
    raise exception 'expected snoozing without a wake-up time to be rejected';
  exception when check_violation then null;
  end;
  begin
    -- Valid in everything but its two subjects, so that is what is refused.
    insert into ai.proposals (business_id, agent, kind, record_id, conversation_id, summary, command, autonomy, revision)
      values (app.business_id(), 'inbox', 'reply', v_contact, v_conversation, 'Two subjects',
              '{"name": "conversation.reply", "input": {}}', 'ask', 'thread:1');
    raise exception 'expected a proposal about two things at once to be rejected';
  exception when check_violation then
    if sqlerrm not like '%proposals_one_subject%' then raise; end if;
  end;
  begin
    insert into ai.proposals (business_id, agent, kind, conversation_id, summary, command, autonomy, revision)
      values (app.business_id(), 'inbox', 'reply', v_conversation, 'No command to run', '{}', 'ask', 'thread:1');
    raise exception 'expected a proposal without a command to run to be rejected';
  exception when check_violation then
    if sqlerrm not like '%proposals_command_shape%' then raise; end if;
  end;
  raise notice 'ok: conversations and proposals stay internally consistent';
end $$;

-- A proposal is decided once (0052): it only moves forward, and what it proposed stays.
do $$
declare
  v_conversation uuid;
  v_proposal uuid;
begin
  select id into v_conversation from messaging.conversations limit 1;
  update ai.proposals set status = 'expired', decided_at = now(), decided_by_kind = 'system'
    where conversation_id = v_conversation and status = 'pending';
  insert into ai.proposals (business_id, agent, kind, conversation_id, summary, command, autonomy, revision)
    values (app.business_id(), 'inbox', 'reply', v_conversation, 'Reply about the date',
            '{"name": "conversation.reply", "input": {}}', 'ask', 'thread:1')
    returning id into v_proposal;
  begin
    insert into ai.proposals (business_id, agent, kind, conversation_id, summary, command, autonomy, revision)
      values (app.business_id(), 'inbox', 'reply', v_conversation, 'A second waiting draft',
              '{"name": "conversation.reply", "input": {}}', 'ask', 'thread:1');
    raise exception 'expected a second waiting proposal of one kind for a conversation to be rejected';
  exception when unique_violation then null;
  end;
  begin
    update ai.proposals set status = 'undone', undone_at = now(), undone_by_kind = 'user' where id = v_proposal;
    raise exception 'expected undoing a proposal nobody applied to be rejected';
  exception when check_violation then null;
  end;
  begin
    update ai.proposals set status = 'applied', decided_at = now(), decided_by_kind = 'user' where id = v_proposal;
    raise exception 'expected an applied proposal with no way back recorded to be rejected';
  exception when check_violation then
    if sqlerrm not like '%proposals_applied_has_undo%' then raise; end if;
  end;
  update ai.proposals
    set status = 'applied', decided_at = now(), decided_by_kind = 'user',
        result = '{"kind": "message"}', undo = '{"impossible": "message_sent"}'
    where id = v_proposal;
  begin
    update ai.proposals set status = 'pending', decided_at = null, decided_by_kind = null,
        result = null, undo = null where id = v_proposal;
    raise exception 'expected an applied proposal going back to waiting to be rejected';
  exception when check_violation then
    if sqlerrm not like '%cannot go from applied to pending%' then raise; end if;
  end;
  begin
    update ai.proposals set status = 'dismissed' where id = v_proposal;
    raise exception 'expected dismissing an applied proposal to be rejected';
  exception when check_violation then null;
  end;
  begin
    update ai.proposals set command = '{"name": "contact.trash", "input": {}}' where id = v_proposal;
    raise exception 'expected rewriting what an applied proposal ran to be rejected';
  exception when check_violation then
    if sqlerrm not like '%a decided proposal is not changed%' then raise; end if;
  end;
  begin
    update ai.proposals set agent = 'copilot' where id = v_proposal;
    raise exception 'expected changing who proposed to be rejected';
  exception when check_violation then
    if sqlerrm not like '%never changes%' then raise; end if;
  end;
  begin
    update ai.proposals set status = 'undone', undone_at = now(), undone_by_kind = 'user',
        undo = '{"impossible": "rewritten"}' where id = v_proposal;
    raise exception 'expected an undo that rewrites how it was applied to be rejected';
  exception when check_violation then
    if sqlerrm not like '%does not rewrite%' then raise; end if;
  end;
  update ai.proposals set status = 'undone', undone_at = now(), undone_by_kind = 'user' where id = v_proposal;
  begin
    update ai.proposals set status = 'applied', undone_at = null, undone_by_kind = null where id = v_proposal;
    raise exception 'expected an undone proposal going back to applied to be rejected';
  exception when check_violation then null;
  end;
  raise notice 'ok: a proposal is decided once, moves only forward, and keeps what it proposed';
end $$;

-- updated_at is set by the trigger, in a later transaction than the insert.
do $$
begin
  insert into crm.tags (business_id, name, created_by_kind) values (app.business_id(), 'Corporate', 'user');
end $$;
do $$
begin
  perform pg_sleep(0.01);
  update crm.tags set description = 'Company events.' where name = 'Corporate';
  if not exists (select 1 from crm.tags where name = 'Corporate' and updated_at > created_at) then
    raise exception 'expected updated_at to move forward on update';
  end if;
  raise notice 'ok: updated_at moves forward on every update';
end $$;

reset role;

-- auth.users, as Better Auth uses it, written by the authentication module's role.

set role crm_auth;

do $$
declare
  v_constraint text;
begin
  begin
    insert into auth.users (email, name) values ('Mixed.Case@example.com', 'Mixed Case');
    raise exception 'expected an email address that isn''t lower case to be rejected';
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'users_email_lower_case' then
      raise;
    end if;
  end;
  raise notice 'ok: email addresses are stored in lower case, as sign-in looks them up';
end $$;

do $$
declare
  v_user uuid;
  v_verified_at timestamptz;
begin
  insert into auth.users (email, name) values ('verify.me@example.com', 'Verify Me') returning id into v_user;
  if (select email_verified_at from auth.users where id = v_user) is not null then
    raise exception 'expected a new user to be unverified';
  end if;
  update auth.users set email_verified = true where id = v_user;
  select email_verified_at into v_verified_at from auth.users where id = v_user;
  if v_verified_at is null then
    raise exception 'expected verifying the email to record when';
  end if;
  update auth.users set name = 'Verified' where id = v_user;
  if (select email_verified_at from auth.users where id = v_user) <> v_verified_at then
    raise exception 'expected email_verified_at to keep the first verification time';
  end if;
  update auth.users set email_verified = false where id = v_user;
  if (select email_verified_at from auth.users where id = v_user) is not null then
    raise exception 'expected unverifying the email to clear email_verified_at';
  end if;
  raise notice 'ok: email_verified_at records when the email was verified';
end $$;

reset role;

-- Changing a password (0016) ends the links that could sign in without it: password resets
-- (whose value is the user's id) and magic links (whose value is JSON with the email).

set role crm_auth;

do $$
declare
  v_user uuid;
  v_other uuid;
  v_left text;
begin
  insert into auth.users (email, name) values ('links@example.com', 'Links') returning id into v_user;
  insert into auth.users (email, name) values ('bystander@example.com', 'Bystander') returning id into v_other;
  insert into auth.accounts (user_id, account_id, provider_id, password)
    values (v_user, v_user::text, 'credential', 'old-hash');
  insert into auth.verifications (identifier, value, expires_at) values
    ('reset-mine', v_user::text, now() + interval '1 hour'),
    ('magic-mine', '{"type":"magic-link","email":"Links@Example.com"}', now() + interval '15 minutes'),
    ('reset-theirs', v_other::text, now() + interval '1 hour'),
    ('magic-theirs', '{"type":"magic-link","email":"bystander@example.com"}', now() + interval '15 minutes'),
    ('not-json', '{not json', now() + interval '1 hour');

  update auth.accounts set updated_at = now() where user_id = v_user;
  if (select count(*) from auth.verifications where identifier like '%-mine') <> 2 then
    raise exception 'expected an update that keeps the password to leave the links alone';
  end if;

  update auth.accounts set password = 'new-hash' where user_id = v_user;
  select string_agg(identifier, ', ' order by identifier) into v_left from auth.verifications
    where identifier in ('reset-mine', 'magic-mine', 'reset-theirs', 'magic-theirs', 'not-json');
  if v_left is distinct from 'magic-theirs, not-json, reset-theirs' then
    raise exception 'expected a new password to end only that person''s links, but left: %', v_left;
  end if;

  -- A person who had no password and sets one, by a reset, loses their other links too.
  insert into auth.verifications (identifier, value, expires_at)
    values ('reset-theirs-2', v_other::text, now() + interval '1 hour');
  insert into auth.accounts (user_id, account_id, provider_id, password)
    values (v_other, v_other::text, 'credential', 'first-hash');
  if exists (select from auth.verifications where value = v_other::text) then
    raise exception 'expected a first password to end that person''s reset links';
  end if;
  raise notice 'ok: a new password ends that person''s reset and magic links, and nobody else''s';
end $$;

reset role;

-- Two-factor sign-in and passkeys (0017): one authenticator app per person, and a passkey
-- credential belongs to one person.
set role crm_auth;

do $$
declare
  v_user uuid;
  v_other uuid;
begin
  insert into auth.users (email, name) values ('factors@example.com', 'Factors') returning id into v_user;
  insert into auth.users (email, name) values ('copycat@example.com', 'Copycat') returning id into v_other;

  insert into auth.two_factors (user_id, secret, backup_codes) values (v_user, 'secret', 'codes');
  begin
    insert into auth.two_factors (user_id, secret, backup_codes) values (v_user, 'second', 'codes');
    raise exception 'expected a second authenticator app for one person to be refused';
  exception when unique_violation then null;
  end;

  insert into auth.passkeys (user_id, public_key, credential_id, counter, device_type, backed_up)
    values (v_user, 'key', 'credential-1', 0, 'singleDevice', false);
  begin
    insert into auth.passkeys (user_id, public_key, credential_id, counter, device_type, backed_up)
      values (v_other, 'key', 'credential-1', 0, 'singleDevice', false);
    raise exception 'expected a passkey credential already in use to be refused';
  exception when unique_violation then null;
  end;
  raise notice 'ok: one authenticator app per person, and each passkey credential belongs to one person';
end $$;

-- Proving an address removes what was set up before it was proven: someone else who knew
-- the password the person was given could have added the app or the passkey.
do $$
declare
  v_unproven uuid;
  v_proven uuid;
begin
  insert into auth.users (email, name, two_factor_enabled)
    values ('unproven@example.com', 'Unproven', true) returning id into v_unproven;
  insert into auth.users (email, name, email_verified, two_factor_enabled)
    values ('proven@example.com', 'Proven', true, true) returning id into v_proven;
  insert into auth.two_factors (user_id, secret, backup_codes) values
    (v_unproven, 'secret', 'codes'), (v_proven, 'secret', 'codes');
  insert into auth.passkeys (user_id, public_key, credential_id, counter, device_type, backed_up)
    values (v_unproven, 'key', 'unproven-1', 0, 'singleDevice', false),
           (v_proven, 'key', 'proven-1', 0, 'singleDevice', false);

  update auth.users set name = 'Still unproven' where id = v_unproven;
  if not exists (select from auth.passkeys where user_id = v_unproven) then
    raise exception 'expected a change other than proving the address to keep the passkeys';
  end if;

  update auth.users set email_verified = true where id in (v_unproven, v_proven);
  if exists (select from auth.two_factors where user_id = v_unproven)
     or exists (select from auth.passkeys where user_id = v_unproven)
     or (select two_factor_enabled from auth.users where id = v_unproven) then
    raise exception 'expected proving the address to remove the app and passkeys set up before';
  end if;
  if not exists (select from auth.two_factors where user_id = v_proven)
     or not exists (select from auth.passkeys where user_id = v_proven)
     or not (select two_factor_enabled from auth.users where id = v_proven) then
    raise exception 'expected someone already proven to keep their app and passkeys';
  end if;
  raise notice 'ok: proving an address removes the app and passkeys set up before it, and nothing else';
end $$;

reset role;

-- The first admin's setup links (0018): each token is stored as its hash, once.
set role crm_auth;

do $$
begin
  insert into auth.setup_links (token_hash, expires_at) values ('hash-1', now() + interval '24 hours');
  begin
    insert into auth.setup_links (token_hash, expires_at) values ('hash-1', now() + interval '24 hours');
    raise exception 'expected a second link with the same token to be refused';
  exception when unique_violation then null;
  end;
  delete from auth.setup_links;
  raise notice 'ok: a setup link''s token is stored once';
end $$;

reset role;

-- The vault (0019): a sealed secret keeps HPKE's 32-byte encapsulated key, and rotation
-- lists only the secrets sealed under another key version, across every tenant.
do $$
declare
  v_agency uuid;
  v_business uuid;
  v_listed text;
begin
  insert into tenancy.agencies (name, slug) values ('Vault Agency', 'vault-agency') returning id into v_agency;
  insert into tenancy.businesses (agency_id, name, slug) values (v_agency, 'Vault Business', 'vault-business')
    returning id into v_business;
  insert into vault.secrets (id, agency_id, business_id, purpose, key_version, enc, ciphertext) values
    ('00000000-0000-7000-8000-00000000a001', v_agency, null, 'ai.key', 1, decode(repeat('aa', 32), 'hex'), decode(repeat('bb', 20), 'hex')),
    ('00000000-0000-7000-8000-00000000a002', v_agency, v_business, 'mailbox.password', 2, decode(repeat('aa', 32), 'hex'), decode(repeat('bb', 20), 'hex')),
    ('00000000-0000-7000-8000-00000000a003', v_agency, v_business, 'mailbox.password', 1, decode(repeat('aa', 32), 'hex'), decode(repeat('bb', 20), 'hex'));
  begin
    insert into vault.secrets (agency_id, purpose, key_version, enc, ciphertext)
      values (v_agency, 'ai.key', 1, decode(repeat('aa', 12), 'hex'), decode(repeat('bb', 20), 'hex'));
    raise exception 'expected an encapsulated key that isn''t 32 bytes to be refused';
  exception when check_violation then null;
  end;

  set local role crm_app;
  select string_agg(secret_id::text, ',' order by secret_id) into v_listed
    from private.secrets_to_rotate(2::smallint, null, 1000) where agency_id = v_agency;
  if v_listed is distinct from '00000000-0000-7000-8000-00000000a001,00000000-0000-7000-8000-00000000a003' then
    raise exception 'expected rotation to list the secrets under key version 1, across tenants, but got %', v_listed;
  end if;
  select string_agg(secret_id::text, ',' order by secret_id) into v_listed
    from private.secrets_to_rotate(2::smallint, '00000000-0000-7000-8000-00000000a001', 1000)
    where agency_id = v_agency;
  reset role;
  if v_listed is distinct from '00000000-0000-7000-8000-00000000a003' then
    raise exception 'expected rotation to continue after the id it was given, but got %', v_listed;
  end if;

  -- How many secrets each key version seals, across every tenant, and nothing more.
  set local role crm_app;
  select string_agg(format('%s:%s', key_version, secrets), ',' order by key_version) into v_listed
    from private.secret_key_versions();
  reset role;
  if v_listed is distinct from (
    select string_agg(format('%s:%s', key_version, n), ',' order by key_version)
    from (select key_version, count(*) as n from vault.secrets group by key_version) counted
  ) then
    raise exception 'expected the secrets under each key version, but got %', v_listed;
  end if;

  -- crm_app rewrites a secret's sealed bytes, never whose or what it is.
  set local role crm_app;
  begin
    update vault.secrets set purpose = 'ai.key' where id = '00000000-0000-7000-8000-00000000a002';
    raise exception 'expected crm_app to be refused a change of purpose';
  exception when insufficient_privilege then null;
  end;
  begin
    update vault.secrets set business_id = null where id = '00000000-0000-7000-8000-00000000a002';
    raise exception 'expected crm_app to be refused a change of business';
  exception when insufficient_privilege then null;
  end;
  reset role;
  delete from vault.secrets where agency_id = v_agency;
  delete from tenancy.agencies where id = v_agency;
  raise notice 'ok: rotation lists and counts secrets by key version, crm_app rewrites only sealed bytes, and enc is 32 bytes';
end $$;

-- A won explanation cannot survive reopening or becoming lost, and is bounded.
set role crm_owner;
do $$
declare
  b constant uuid := 'bbbbbbb1-0000-7000-8000-000000000000';
  pipeline uuid;
  stage uuid;
  object_type uuid;
  record uuid := uuidv7();
begin
  insert into crm.pipelines (business_id, name) values (b, 'Outcome checks') returning id into pipeline;
  insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
    values (b, pipeline, 'Proposal', 0) returning id into stage;
  select id into object_type from crm.object_types where business_id = b and kind = 'deal';
  insert into crm.records (business_id, id, kind, object_type_id) values (b, record, 'deal', object_type);
  insert into crm.deals (business_id, id, name, pipeline_id, stage_id, currency, status, closed_at, won_note, created_by_kind)
    values (b, record, 'Won', pipeline, stage, 'KES', 'won', now(), 'Signed contract', 'system');
  begin
    update crm.deals set status = 'open', closed_at = null where business_id = b and id = record;
    raise exception 'expected reopening with a won explanation to fail';
  exception when check_violation then
    if sqlerrm not like '%deals_won_note_only_when_won%' then raise; end if;
  end;
  begin
    update crm.deals set won_note = '   ' where business_id = b and id = record;
    raise exception 'expected a blank won explanation to fail';
  exception when check_violation then
    if sqlerrm not like '%deals_won_note_length%' then raise; end if;
  end;
  begin
    update crm.deals set won_note = repeat('x', 2001) where business_id = b and id = record;
    raise exception 'expected an oversized won explanation to fail';
  exception when check_violation then
    if sqlerrm not like '%deals_won_note_length%' then raise; end if;
  end;
  update crm.deals set status = 'open', closed_at = null, won_note = null where business_id = b and id = record;
  raise notice 'ok: won explanations are bounded and only belong to won deals';
end $$;
reset role;

-- A note's last editor is a known kind of actor, recorded with the time of the edit; a note
-- nobody has edited has neither.
set role crm_owner;
do $$
declare
  b constant uuid := 'bbbbbbb1-0000-7000-8000-000000000000';
  object_type uuid;
  record uuid := uuidv7();
  v_note uuid;
begin
  select id into object_type from crm.object_types where business_id = b and kind = 'contact';
  insert into crm.records (business_id, id, kind, object_type_id) values (b, record, 'contact', object_type);
  insert into crm.contacts (business_id, id, first_name, created_by_kind) values (b, record, 'Edited', 'system');
  insert into crm.notes (business_id, record_id, body, body_text, author_kind)
    values (b, record, '{"type": "doc"}', 'Note', 'user') returning id into v_note;
  begin
    update crm.notes set edited_by_id = uuidv7(), edited_at = now() where business_id = b and id = v_note;
    raise exception 'expected an editor id without its kind to fail';
  exception when check_violation then
    if sqlerrm not like '%notes_edited_together%' then raise; end if;
  end;
  begin
    update crm.notes set edited_by_kind = 'user', edited_by_id = uuidv7() where business_id = b and id = v_note;
    raise exception 'expected an edit without its time to fail';
  exception when check_violation then
    if sqlerrm not like '%notes_edited_together%' then raise; end if;
  end;
  begin
    update crm.notes set edited_at = now() where business_id = b and id = v_note;
    raise exception 'expected an edit time without its editor to fail';
  exception when check_violation then
    if sqlerrm not like '%notes_edited_together%' then raise; end if;
  end;
  begin
    update crm.notes set edited_by_kind = 'robot', edited_at = now() where business_id = b and id = v_note;
    raise exception 'expected an unknown kind of editor to fail';
  exception when check_violation then
    if sqlerrm not like '%notes_edited_by_kind_valid%' then raise; end if;
  end;
  -- The system edits without an id.
  update crm.notes set edited_by_kind = 'system', edited_at = now() where business_id = b and id = v_note;
  delete from crm.records where business_id = b and id = record;
  raise notice 'ok: a note''s last editor is a known kind of actor, with the time of the edit';
end $$;
reset role;

-- Whoever completes a task is a known kind of actor; a machine or the system may complete
-- one too, the system without an id.
set role crm_owner;
do $$
declare
  b constant uuid := 'bbbbbbb1-0000-7000-8000-000000000000';
  v_task uuid;
begin
  insert into crm.tasks (business_id, title, created_by_kind)
    values (b, 'Completion checks', 'system') returning id into v_task;
  begin
    update crm.tasks set completed_at = now(), completed_by_kind = 'robot'
      where business_id = b and id = v_task;
    raise exception 'expected an unknown kind of completer to fail';
  exception when check_violation then
    if sqlerrm not like '%tasks_completed_by_kind_valid%' then raise; end if;
  end;
  update crm.tasks set completed_at = now(), completed_by_kind = 'api_key', completed_by_id = uuidv7()
    where business_id = b and id = v_task;
  update crm.tasks set completed_by_kind = 'system', completed_by_id = null
    where business_id = b and id = v_task;
  delete from crm.tasks where business_id = b and id = v_task;
  raise notice 'ok: whoever completes a task is a known kind of actor, machines and the system included';
end $$;
reset role;

-- The media library (0087): a library file is one business's, a folder and a
-- public address are a library file's, a public key has one shape and is nobody else's,
-- and files.file_usage knows every table that points at a file.
set role crm_owner;
do $$
declare
  a constant uuid := 'aaaaaaa1-0000-7000-8000-000000000000';
  b constant uuid := 'bbbbbbb1-0000-7000-8000-000000000000';
  b2 constant uuid := 'bbbbbbb2-0000-7000-8000-000000000000';
  v_folder uuid;
  v_folder_b2 uuid;
  v_file uuid;
  v_other uuid;
  v_missing text;
begin
  insert into files.folders (business_id, name, created_by_kind) values (b, 'Media checks', 'system')
    returning id into v_folder;
  insert into files.folders (business_id, name, created_by_kind) values (b2, 'Theirs', 'system')
    returning id into v_folder_b2;
  insert into files.files (agency_id, business_id, storage, storage_key, filename, content_type, size_bytes, sha256, uploaded_by_kind, library, folder_id)
    values (a, b, 'local', 'media-checks-1', 'a.png', 'image/png', 1, sha256('a'::bytea), 'system', true, v_folder)
    returning id into v_file;
  insert into files.files (agency_id, business_id, storage, storage_key, filename, content_type, size_bytes, sha256, uploaded_by_kind)
    values (a, b, 'local', 'media-checks-2', 'b.png', 'image/png', 1, sha256('b'::bytea), 'system')
    returning id into v_other;

  begin
    insert into files.folders (business_id, name, created_by_kind) values (b, ' MEDIA checks ', 'system');
    raise exception 'expected a sibling folder name in another case to fail';
  exception when unique_violation then
    if sqlerrm not like '%folders_name_unique%' then raise; end if;
  end;
  begin
    update files.folders set parent_id = id where business_id = b and id = v_folder;
    raise exception 'expected a folder as its own parent to fail';
  exception when check_violation then
    if sqlerrm not like '%folders_not_self%' then raise; end if;
  end;
  begin
    update files.folders set parent_id = v_folder_b2 where business_id = b and id = v_folder;
    raise exception 'expected a parent in another business to fail';
  exception when foreign_key_violation then null;
  end;
  begin
    update files.files set folder_id = v_folder_b2 where id = v_file;
    raise exception 'expected a file in another business''s folder to fail';
  exception when foreign_key_violation then null;
  end;
  begin
    delete from files.folders where business_id = b and id = v_folder;
    raise exception 'expected a folder that holds a file not to be deleted from under it';
  exception when foreign_key_violation then null;
  end;
  begin
    update files.files set folder_id = v_folder where id = v_other;
    raise exception 'expected a folder for a file outside the library to fail';
  exception when check_violation then
    if sqlerrm not like '%files_folder_needs_library%' then raise; end if;
  end;
  begin
    update files.files set public_key = 'AAAAAAAAAAAAAAAAAAAAAA' where id = v_other;
    raise exception 'expected a public address for a file outside the library to fail';
  exception when check_violation then
    if sqlerrm not like '%files_public_needs_live_library%' then raise; end if;
  end;
  begin
    update files.files set public_key = 'too-short' where id = v_file;
    raise exception 'expected a public key of another shape to fail';
  exception when check_violation then
    if sqlerrm not like '%files_public_key_shape%' then raise; end if;
  end;
  begin
    insert into files.files (agency_id, storage, storage_key, filename, content_type, size_bytes, sha256, uploaded_by_kind, library)
      values (a, 'local', 'media-checks-3', 'c.png', 'image/png', 1, sha256('c'::bytea), 'system', true);
    raise exception 'expected a library file of no business to fail';
  exception when check_violation then
    if sqlerrm not like '%files_library_has_business%' then raise; end if;
  end;
  update files.files set public_key = 'AAAAAAAAAAAAAAAAAAAAAA' where id = v_file;
  begin
    update files.files set deleted_at = now() where id = v_file;
    raise exception 'expected a deleted file to be unable to keep its public address';
  exception when check_violation then
    if sqlerrm not like '%files_public_needs_live_library%' then raise; end if;
  end;
  begin
    update files.files set library = true, public_key = 'AAAAAAAAAAAAAAAAAAAAAA' where id = v_other;
    raise exception 'expected a public key to be one file''s';
  exception when unique_violation then
    if sqlerrm not like '%files_public_key_unique%' then raise; end if;
  end;

  -- The public address finds its business, and only while the file is public and live.
  if (select count(*) from private.resolve_public_media('AAAAAAAAAAAAAAAAAAAAAA') r
      where r.agency_id = a and r.business_id = b and r.file_id = v_file) <> 1 then
    raise exception 'expected the public key to name its file';
  end if;
  if exists (select 1 from private.resolve_public_media('BBBBBBBBBBBBBBBBBBBBBB')) then
    raise exception 'expected an unknown public key to name nothing';
  end if;
  update tenancy.businesses set status = 'suspended' where id = b;
  if exists (select 1 from private.resolve_public_media('AAAAAAAAAAAAAAAAAAAAAA')) then
    raise exception 'expected a suspended business to serve no public file';
  end if;
  update tenancy.businesses set status = 'active' where id = b;

  -- Used as the business's logo, and found there.
  if exists (select 1 from files.file_usage(v_file)) then
    raise exception 'expected an unused file to be used nowhere';
  end if;
  update tenancy.businesses set logo_file_id = v_file where id = b;
  if (select array_agg(place) from files.file_usage(v_file)) <> array['business_logo'] then
    raise exception 'expected the file to be found as the business''s logo';
  end if;
  update tenancy.businesses set logo_file_id = null where id = b;

  -- A new table that points at a file must be added to files.file_usage (and to the
  -- contract's list of uses), or the library would delete a file from under it.
  select string_agg(format('%s.%s', c.conrelid::regclass, att.attname), ', ') into v_missing
  from pg_constraint c
  join pg_attribute att on att.attrelid = c.conrelid and att.attnum = c.conkey[array_length(c.conkey, 1)]
  cross join (select prosrc from pg_proc where oid = 'files.file_usage(uuid)'::regprocedure) f
  where c.contype = 'f' and c.confrelid = 'files.files'::regclass
    and (position(c.conrelid::regclass::text in f.prosrc) = 0 or position(att.attname in f.prosrc) = 0);
  if v_missing is not null then
    raise exception 'files.file_usage does not know these references to a file: %', v_missing;
  end if;

  update files.files set public_key = null where id = v_file;
  delete from files.files where id in (v_file, v_other);
  delete from files.folders where id in (v_folder, v_folder_b2);
  raise notice 'ok: the media library keeps its folders, its public addresses and its uses straight';
end $$;
reset role;

-- Email campaigns (0088): folders of templates and folders of campaigns are two
-- trees in one table, a campaign has one row per contact, a skipped recipient says why,
-- and a draft has no schedule.
set role crm_owner;
do $$
declare
  b constant uuid := 'bbbbbbb1-0000-7000-8000-000000000000';
  b2 constant uuid := 'bbbbbbb2-0000-7000-8000-000000000000';
  v_templates uuid;
  v_campaigns uuid;
  v_campaign uuid;
  v_template uuid;
  v_contact uuid;
begin
  insert into messaging.template_folders (business_id, name, created_by_kind)
    values (b, 'Campaign checks', 'system') returning id into v_templates;
  -- The same name in the same place, in the other tree.
  insert into messaging.template_folders (business_id, name, kind, created_by_kind)
    values (b, 'Campaign checks', 'campaign', 'system') returning id into v_campaigns;
  insert into messaging.email_campaigns (business_id, name, folder_id, created_by_kind)
    values (b, 'Campaign checks', v_campaigns, 'system') returning id into v_campaign;
  select id into strict v_template from messaging.templates where business_id = b limit 1;
  select id into strict v_contact from crm.contacts where business_id = b limit 1;

  begin
    insert into messaging.template_folders (business_id, name, kind, created_by_kind)
      values (b, ' campaign CHECKS ', 'campaign', 'system');
    raise exception 'expected a second campaign folder of the same name to fail';
  exception when unique_violation then
    if sqlerrm not like '%template_folders_name_unique%' then raise; end if;
  end;
  begin
    insert into messaging.template_folders (business_id, name, kind, parent_id, created_by_kind)
      values (b, 'Inside the wrong tree', 'campaign', v_templates, 'system');
    raise exception 'expected a campaign folder inside a template folder to fail';
  exception when foreign_key_violation then null;
  end;
  begin
    update messaging.email_campaigns set folder_id = v_templates where id = v_campaign;
    raise exception 'expected a campaign in a folder of templates to fail';
  exception when foreign_key_violation then null;
  end;
  begin
    update messaging.templates set folder_id = v_campaigns where id = v_template;
    raise exception 'expected a template in a folder of campaigns to fail';
  exception when foreign_key_violation then null;
  end;
  begin
    update messaging.template_folders set kind = 'bulk' where id = v_campaigns;
    raise exception 'expected an unknown kind of folder to fail';
  exception when check_violation then
    if sqlerrm not like '%template_folders_kind_valid%' then raise; end if;
  end;
  begin
    insert into messaging.email_campaigns (business_id, name, folder_id, created_by_kind)
      select b2, 'Theirs', v_campaigns, 'system';
    raise exception 'expected a campaign in another business''s folder to fail';
  exception when foreign_key_violation then null;
  end;

  -- A draft has no schedule; anything else was started by someone; HTML goes with its format.
  begin
    update messaging.email_campaigns set send_at = now() where id = v_campaign;
    raise exception 'expected a draft with a send time to fail';
  exception when check_violation then
    if sqlerrm not like '%email_campaigns_draft_unstarted%' then raise; end if;
  end;
  begin
    update messaging.email_campaigns set status = 'scheduled', send_at = now() where id = v_campaign;
    raise exception 'expected a scheduled campaign nobody started to fail';
  exception when check_violation then
    if sqlerrm not like '%email_campaigns_started_by%' then raise; end if;
  end;
  begin
    update messaging.email_campaigns set format = 'html' where id = v_campaign;
    raise exception 'expected an HTML campaign with no HTML to fail';
  exception when check_violation then
    if sqlerrm not like '%email_campaigns_html_by_format%' then raise; end if;
  end;
  begin
    update messaging.email_campaigns set subject = E'Two\nlines' where id = v_campaign;
    raise exception 'expected a subject on two lines to fail';
  exception when check_violation then
    if sqlerrm not like '%email_campaigns_subject_valid%' then raise; end if;
  end;
  begin
    update messaging.email_campaigns set status = 'sending', started_by_kind = 'user', batch_size = 10
      where id = v_campaign;
    raise exception 'expected half a batch plan to fail';
  exception when check_violation then
    if sqlerrm not like '%email_campaigns_batches_whole%' then raise; end if;
  end;

  -- One row per campaign and contact, and a skip always has its reason.
  insert into messaging.email_campaign_recipients (business_id, campaign_id, contact_id)
    values (b, v_campaign, v_contact);
  begin
    insert into messaging.email_campaign_recipients (business_id, campaign_id, contact_id)
      values (b, v_campaign, v_contact);
    raise exception 'expected the same contact twice in one campaign to fail';
  exception when unique_violation then null;
  end;
  begin
    update messaging.email_campaign_recipients set status = 'skipped'
      where campaign_id = v_campaign and contact_id = v_contact;
    raise exception 'expected a skip with no reason to fail';
  exception when check_violation then
    if sqlerrm not like '%email_campaign_recipients_skip_has_reason%' then raise; end if;
  end;
  begin
    update messaging.email_campaign_recipients set reason = 'no_consent'
      where campaign_id = v_campaign and contact_id = v_contact;
    raise exception 'expected a reason on a recipient that was not skipped to fail';
  exception when check_violation then
    if sqlerrm not like '%email_campaign_recipients_skip_has_reason%' then raise; end if;
  end;
  begin
    insert into messaging.email_campaign_tests (business_id, campaign_id, addresses, requested_by_kind)
      values (b, v_campaign, array[]::text[], 'user');
    raise exception 'expected a test to nobody to fail';
  exception when check_violation then
    if sqlerrm not like '%email_campaign_tests_addresses_count%' then raise; end if;
  end;

  -- Deleting the campaign takes its recipients with it; the folders then go too.
  delete from messaging.email_campaigns where id = v_campaign;
  if exists (select 1 from messaging.email_campaign_recipients where campaign_id = v_campaign) then
    raise exception 'expected a deleted campaign''s recipients to go with it';
  end if;
  delete from messaging.template_folders where id in (v_templates, v_campaigns);
  raise notice 'ok: campaign folders are their own tree, a campaign has one row per contact, and a draft has no schedule';
end $$;
reset role;

-- OAuth for installed apps (0113): an app key has no secret and belongs to its
-- install's business, with a list of what it reads; a code's challenge is S256's shape; a token can't name another
-- business's install; a client secret is all there or not at all.
set role crm_owner;
do $$
declare
  a constant uuid := 'aaaaaaa1-0000-7000-8000-000000000000';
  b constant uuid := 'bbbbbbb1-0000-7000-8000-000000000000';
  b2 constant uuid := 'bbbbbbb2-0000-7000-8000-000000000000';
  u constant uuid := 'eeeeeee2-0000-7000-8000-000000000000';
  v_install uuid;
  v_app uuid;
  v_code uuid;
begin
  select id, app_id into v_install, v_app from tenancy.marketplace_installs
    where business_id = b limit 1;
  select id into v_code from tenancy.marketplace_oauth_codes where business_id = b limit 1;
  begin
    insert into tenancy.api_keys (agency_id, business_id, name, key_prefix, key_hash, scopes,
                                  marketplace_install_id)
      values (a, b, 'Presentable app key', 'crm_live_appkey1', sha256('app-key'::bytea),
              array['contacts.manage'], v_install);
    raise exception 'expected an app key with a secret to fail';
  exception when check_violation then
    if sqlerrm not like '%api_keys_app_key_shape%' then raise; end if;
  end;
  begin
    insert into tenancy.api_keys (agency_id, business_id, name, scopes, marketplace_install_id)
      values (a, b, 'Unrestricted reads', array['contacts.manage'], v_install);
    raise exception 'expected an app key without read groups to fail';
  exception when check_violation then
    if sqlerrm not like '%api_keys_app_key_shape%' then raise; end if;
  end;
  begin
    insert into tenancy.api_keys (agency_id, business_id, name, scopes)
      values (a, b, 'No secret', array['contacts.manage']);
    raise exception 'expected a key with no secret and no install to fail';
  exception when check_violation then
    if sqlerrm not like '%api_keys_app_key_shape%' then raise; end if;
  end;
  begin
    update tenancy.api_keys set business_id = b2 where marketplace_install_id = v_install;
    raise exception 'expected an app key in another business than its install to fail';
  exception when foreign_key_violation then
    null;
  end;
  begin
    insert into tenancy.marketplace_oauth_codes (business_id, agency_id, install_id, code_hash,
                                                 redirect_uri, code_challenge, issued_by, expires_at)
      values (b, a, v_install, sha256('plain-code'::bytea), 'https://sync.example/callback',
              'not-a-sha256-challenge', u, now() + interval '10 minutes');
    raise exception 'expected a challenge that is not S256 to fail';
  exception when check_violation then
    if sqlerrm not like '%marketplace_oauth_codes_challenge_format%' then raise; end if;
  end;
  begin
    insert into tenancy.marketplace_oauth_tokens (business_id, agency_id, install_id, code_id,
                                                  access_hash, access_expires_at, refresh_hash,
                                                  refresh_expires_at)
      values (b2, a, v_install, v_code, sha256('a2'::bytea), now() + interval '1 day',
              sha256('r2'::bytea), now() + interval '365 days');
    raise exception 'expected a token for another business''s install to fail';
  exception when foreign_key_violation then
    null;
  end;
  begin
    update tenancy.marketplace_oauth_tokens set revoked_at = now() where business_id = b;
    raise exception 'expected a revocation without a reason to fail';
  exception when check_violation then
    if sqlerrm not like '%marketplace_oauth_tokens_revoked_pair%' then raise; end if;
  end;
  begin
    update tenancy.marketplace_apps set client_secret_hash = sha256('secret'::bytea)
      where id = v_app;
    raise exception 'expected a secret without its prefix and date to fail';
  exception when check_violation then
    if sqlerrm not like '%marketplace_apps_client_secret_together%' then raise; end if;
  end;
  raise notice 'ok: app keys have no secret and stay in their business, codes are S256, and tokens and secrets keep their shape';
end $$;
reset role;

-- Webhooks to installed apps (0115): events need an address, a delivered delivery says when,
-- one delivery per event and install, and an event an install subscribes to queues a job.
set role crm_owner;
do $$
declare
  a constant uuid := 'aaaaaaa1-0000-7000-8000-000000000000';
  b constant uuid := 'bbbbbbb1-0000-7000-8000-000000000000';
  v_install uuid;
  v_app uuid;
  v_event uuid := uuidv7();
begin
  select id, app_id into v_install, v_app from tenancy.marketplace_installs
    where business_id = b limit 1;
  begin
    update tenancy.marketplace_apps set webhook_events = array['contact.created'] where id = v_app;
    raise exception 'expected events without a webhook address to fail';
  exception when check_violation then
    if sqlerrm not like '%marketplace_apps_webhook_events_need_url%' then raise; end if;
  end;
  begin
    update tenancy.marketplace_apps set webhook_url = 'http://plain.example/hook' where id = v_app;
    raise exception 'expected a webhook address that is not https to fail';
  exception when check_violation then
    if sqlerrm not like '%marketplace_apps_webhook_https%' then raise; end if;
  end;
  insert into tenancy.marketplace_webhook_deliveries (business_id, agency_id, install_id, app_id,
                                                      event_id, event_type, body)
    values (b, a, v_install, v_app, v_event, 'contact.updated', '{}');
  begin
    insert into tenancy.marketplace_webhook_deliveries (business_id, agency_id, install_id, app_id,
                                                        event_id, event_type, body)
      values (b, a, v_install, v_app, v_event, 'contact.updated', '{}');
    raise exception 'expected a second delivery of one event to one install to fail';
  exception when unique_violation then
    null;
  end;
  begin
    update tenancy.marketplace_webhook_deliveries set status = 'delivered' where event_id = v_event;
    raise exception 'expected a delivery without its time to fail';
  exception when check_violation then
    if sqlerrm not like '%marketplace_webhook_deliveries_delivered%' then raise; end if;
  end;

  -- Subscribed, the business's next contact.created queues one dispatch job.
  update tenancy.marketplace_apps
    set webhook_url = 'https://sync.example/hook', webhook_events = array['contact.created']
    where id = v_app;
  insert into events.events (agency_id, business_id, type, actor_kind, correlation_id,
                             subject_kind, subject_id)
    values (a, b, 'contact.created', 'system', uuidv7(), 'contact', uuidv7())
    returning id into v_event;
  if not exists (select 1 from graphile_worker.jobs
                 where key = 'marketplace-dispatch:' || v_event::text) then
    raise exception 'expected a subscribed event to queue a dispatch job';
  end if;
  insert into events.events (agency_id, business_id, type, actor_kind, correlation_id,
                             subject_kind, subject_id)
    values (a, b, 'note.created', 'system', uuidv7(), 'note', uuidv7())
    returning id into v_event;
  if exists (select 1 from graphile_worker.jobs
             where key = 'marketplace-dispatch:' || v_event::text) then
    raise exception 'expected an event nobody subscribes to to queue nothing';
  end if;
  -- graphile_worker.jobs is a view: jobs go through the queue's own function.
  perform graphile_worker.remove_job(j.key)
    from graphile_worker.jobs j where j.key like 'marketplace-dispatch:%';
  update tenancy.marketplace_apps set webhook_url = null, webhook_events = '{}' where id = v_app;
  raise notice 'ok: app webhooks need an https address, are delivered once per install, and subscribed events queue a dispatch';
end $$;
reset role;

-- Engagement scoring (0122): points and scores stay in bounds, a rule or a workflow step
-- scores a contact once per key, a person's change has no key, and an event of a type the
-- live rules listen to queues one scoring job while any other type queues none.
set role crm_owner;
do $$
declare
  a constant uuid := 'aaaaaaa1-0000-7000-8000-000000000000';
  b constant uuid := 'bbbbbbb1-0000-7000-8000-000000000000';
  v_contact uuid;
  v_event uuid;
begin
  select contact_id into v_contact from crm.contact_scores where business_id = b limit 1;
  begin
    insert into crm.score_rules (business_id, action, calculation, points, created_by_kind)
      values (b, 'appointment_booked', 'add', 1001, 'user');
    raise exception 'expected a rule of more than 1000 points to fail';
  exception when check_violation then
    if sqlerrm not like '%score_rules_points_range%' then raise; end if;
  end;
  begin
    update crm.contact_scores set score = 1000001 where business_id = b;
    raise exception 'expected a score past a million to fail';
  exception when check_violation then
    if sqlerrm not like '%contact_scores_score_range%' then raise; end if;
  end;
  begin
    insert into crm.score_changes (business_id, contact_id, source, source_key, change, actor_kind)
      values (b, v_contact, 'person', 'step:x', 1, 'user');
    raise exception 'expected a person''s change with a key to fail';
  exception when check_violation then
    if sqlerrm not like '%score_changes_keyed%' then raise; end if;
  end;
  insert into crm.score_changes (business_id, contact_id, source, source_key, change, actor_kind)
    values (b, v_contact, 'workflow', 'step:integrity', 5, 'system');
  begin
    insert into crm.score_changes (business_id, contact_id, source, source_key, change, actor_kind)
      values (b, v_contact, 'workflow', 'step:integrity', 5, 'system');
    raise exception 'expected a second change under one key to fail';
  exception when unique_violation then
    null;
  end;
  delete from crm.score_changes where business_id = b and source_key = 'step:integrity';

  update crm.score_profiles set live_event_types = array['payment.recorded'] where business_id = b;
  insert into events.events (agency_id, business_id, type, actor_kind, correlation_id,
                             subject_kind, subject_id)
    values (a, b, 'payment.recorded', 'system', uuidv7(), 'contact', v_contact)
    returning id into v_event;
  if not exists (select 1 from graphile_worker.jobs
                 where key = 'score-event:' || v_event::text
                   and task_identifier = 'scoring.from_event') then
    raise exception 'expected an event the live rules listen to to queue a scoring job';
  end if;
  insert into events.events (agency_id, business_id, type, actor_kind, correlation_id,
                             subject_kind, subject_id)
    values (a, b, 'note.created', 'system', uuidv7(), 'note', uuidv7())
    returning id into v_event;
  if exists (select 1 from graphile_worker.jobs where key = 'score-event:' || v_event::text) then
    raise exception 'expected an event no live rule listens to to queue nothing';
  end if;
  perform graphile_worker.remove_job(j.key)
    from graphile_worker.jobs j where j.key like 'score-event:%';
  update crm.score_profiles set live_event_types = '{}' where business_id = b;
  raise notice 'ok: scores and points stay in bounds, each key scores once, and live event types queue scoring';
end $$;
reset role;

-- Duplicate contacts (0123): the secondary match field is never the primary one, the match
-- key follows an identity's value whatever writes it, and a rejection names two or more
-- different contacts, sorted.
set role crm_owner;
do $$
declare
  b constant uuid := 'bbbbbbb1-0000-7000-8000-000000000000';
  v_contact uuid;
  v_identity uuid;
  v_key text;
begin
  insert into crm.settings (business_id) values (b) on conflict (business_id) do nothing;
  begin
    update crm.settings set duplicate_primary = 'phone', duplicate_secondary = 'phone' where business_id = b;
    raise exception 'expected a secondary match field equal to the primary one to fail';
  exception when check_violation then
    if sqlerrm not like '%settings_duplicate_secondary_valid%' then raise; end if;
  end;
  begin
    update crm.settings set duplicate_primary = 'name' where business_id = b;
    raise exception 'expected a primary match field other than email or phone to fail';
  exception when check_violation then
    if sqlerrm not like '%settings_duplicate_primary_valid%' then raise; end if;
  end;

  select contact_id into v_contact from crm.contact_identities where business_id = b limit 1;
  insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, match_key)
    values (b, v_contact, 'email', 'Jane.Doe+News@GoogleMail.com', 'jane.doe+news@googlemail.com', 'set by hand')
    returning id, match_key into v_identity, v_key;
  if v_key is distinct from 'janedoe@gmail.com' then
    raise exception 'expected a Gmail address keyed without dots, +tag or googlemail, got %', v_key;
  end if;
  update crm.contact_identities set match_key = 'changed by hand' where business_id = b and id = v_identity
    returning match_key into v_key;
  if v_key is distinct from 'janedoe@gmail.com' then
    raise exception 'expected a key written by hand to be put back, got %', v_key;
  end if;
  update crm.contact_identities set value = 'J.Doe+x@Work.Example', value_normalized = 'j.doe+x@work.example'
    where business_id = b and id = v_identity returning match_key into v_key;
  if v_key is distinct from 'j.doe@work.example' then
    raise exception 'expected another domain keyed with its dots and without its +tag, got %', v_key;
  end if;
  delete from crm.contact_identities where business_id = b and id = v_identity;
  insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
    values (b, v_contact, 'phone', '+254 712 345678', '+254712345678') returning id, match_key into v_identity, v_key;
  if v_key is distinct from '4712345678' then
    raise exception 'expected a phone number keyed by its last ten digits, got %', v_key;
  end if;
  delete from crm.contact_identities where business_id = b and id = v_identity;
  insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
    values (b, v_contact, 'whatsapp', '+254 712 345678', '+254712345678') returning id, match_key into v_identity, v_key;
  if v_key is not null then
    raise exception 'expected no key on a kind the finder does not read, got %', v_key;
  end if;
  delete from crm.contact_identities where business_id = b and id = v_identity;

  begin
    insert into crm.duplicate_rejections (business_id, kind, value_key, contact_ids, rejected_by_kind)
      values (b, 'email', 'a@example.com',
              array['ffffffff-0000-7000-8000-000000000002', 'ffffffff-0000-7000-8000-000000000001']::uuid[], 'user');
    raise exception 'expected contacts out of order to fail';
  exception when check_violation then
    if sqlerrm not like '%duplicate_rejections_contacts_sorted%' then raise; end if;
  end;
  begin
    insert into crm.duplicate_rejections (business_id, kind, value_key, contact_ids, rejected_by_kind)
      values (b, 'email', 'a@example.com',
              array['ffffffff-0000-7000-8000-000000000001', 'ffffffff-0000-7000-8000-000000000001']::uuid[], 'user');
    raise exception 'expected a contact named twice to fail';
  exception when check_violation then
    if sqlerrm not like '%duplicate_rejections_contacts_sorted%' then raise; end if;
  end;
  begin
    insert into crm.duplicate_rejections (business_id, kind, value_key, contact_ids, rejected_by_kind)
      values (b, 'email', 'a@example.com', array['ffffffff-0000-7000-8000-000000000001']::uuid[], 'user');
    raise exception 'expected a group of one to fail';
  exception when check_violation then
    if sqlerrm not like '%duplicate_rejections_contacts_count%' then raise; end if;
  end;
  if has_table_privilege('crm_app', 'crm.duplicate_rejections', 'update')
     or has_table_privilege('crm_app', 'crm.duplicate_rejections', 'delete') then
    raise exception 'a rejection cannot be undone: crm_app should neither change nor delete one';
  end if;
  raise notice 'ok: match fields differ, match keys follow identities, and rejections name sorted different contacts';
end $$;
reset role;

-- Template trash (0124): a template in the trash is archived too, and frees its name.
set role crm_owner;
do $$
declare
  b constant uuid := 'bbbbbbb1-0000-7000-8000-000000000000';
  v_template uuid;
  v_name text;
begin
  select id, name into strict v_template, v_name
    from messaging.templates where business_id = b and archived_at is null limit 1;
  begin
    update messaging.templates set deleted_at = now() where id = v_template;
    raise exception 'expected a template in the trash that is not archived to fail';
  exception when check_violation then
    if sqlerrm not like '%templates_deleted_is_archived%' then raise; end if;
  end;
  update messaging.templates set deleted_at = now(), archived_at = now() where id = v_template;
  insert into messaging.templates (business_id, name, subject, body, created_by_kind)
    values (b, v_name, 'Same name', 'Its name is free.', 'user');
  delete from messaging.templates where business_id = b and subject = 'Same name';
  update messaging.templates set deleted_at = null, archived_at = null where id = v_template;
  raise notice 'ok: a template in the trash is archived and frees its name';
end $$;
reset role;

-- Only documented findings and state/reason provider metadata may be persisted.
set role crm_owner;
do $$
begin
  begin
    update messaging.email_verifications set reasons=array['invented_reason'];
    raise exception 'unknown verification reason accepted';
  exception when check_violation then null;
  end;
  begin
    update messaging.email_verifications set provider_result='{"name":"private data"}';
    raise exception 'provider personal data accepted';
  exception when check_violation then null;
  end;
  raise notice 'ok: email verification reasons and provider metadata are bounded';
end $$;
reset role;

-- Merging contacts (0127): a merged contact stays in the trash, marked with the contact it
-- was merged into, never itself, and is freed when that contact is purged.
set role crm_owner;
do $$
declare
  b constant uuid := 'bbbbbbb1-0000-7000-8000-000000000000';
  v_type uuid;
  v_kept uuid;
  v_merged uuid;
begin
  select id into strict v_type from crm.object_types where business_id = b and kind = 'contact';
  insert into crm.records (business_id, kind, object_type_id)
    values (b, 'contact', v_type) returning id into v_kept;
  insert into crm.contacts (business_id, id, first_name, created_by_kind)
    values (b, v_kept, 'Kept', 'system');
  insert into crm.records (business_id, kind, object_type_id)
    values (b, 'contact', v_type) returning id into v_merged;
  insert into crm.contacts (business_id, id, first_name, created_by_kind)
    values (b, v_merged, 'Merged', 'system');
  begin
    update crm.contacts set merged_into_id = v_kept where id = v_merged;
    raise exception 'expected a merged contact outside the trash to fail';
  exception when check_violation then
    if sqlerrm not like '%contacts_merged_is_trashed%' then raise; end if;
  end;
  begin
    update crm.contacts set merged_into_id = id, deleted_at = now() where id = v_merged;
    raise exception 'expected a contact merged into itself to fail';
  exception when check_violation then
    if sqlerrm not like '%contacts_merged_into_other%' then raise; end if;
  end;
  begin
    update crm.contacts set merged_into_id = gen_random_uuid(), deleted_at = now()
      where id = v_merged;
    raise exception 'expected a merge into no contact to fail';
  exception when foreign_key_violation then null;
  end;
  update crm.contacts set merged_into_id = v_kept, deleted_at = now() where id = v_merged;
  begin
    update crm.contacts set deleted_at = null where id = v_merged;
    raise exception 'expected restoring a merged contact to fail';
  exception when check_violation then
    if sqlerrm not like '%contacts_merged_is_trashed%' then raise; end if;
  end;
  delete from crm.records where business_id = b and id = v_kept;
  if (select merged_into_id from crm.contacts where id = v_merged) is not null then
    raise exception 'expected purging the kept contact to clear merged_into_id';
  end if;
  delete from crm.records where business_id = b and id = v_merged;
  raise notice 'ok: a merged contact stays in the trash, marked with another contact of its business';
end $$;
reset role;

-- Custom objects (0128): a custom object names a primary field of its own, and its key, its
-- kind and that field never change. Only short text and numbers are searchable or unique,
-- and a unique field only ever stops being one. Tried as the owner, so only the database's
-- own rules stand in the way.
set role crm_owner;
do $$
declare
  b constant uuid := 'bbbbbbb1-0000-7000-8000-000000000000';
  v_type uuid := uuidv7();
  v_field uuid := uuidv7();
  v_deal_field uuid;
  v_constraint text;
begin
  begin
    insert into crm.object_types (business_id, kind, key, singular_label, plural_label, created_by_kind)
      values (b, 'custom', 'boat', 'Boat', 'Boats', 'user');
    raise exception 'expected a custom object without a primary field to fail';
  exception when check_violation then
    if sqlerrm not like '%object_types_custom_has_primary%' then raise; end if;
  end;
  select f.id into strict v_deal_field
    from crm.field_definitions f
    join crm.object_types o on o.business_id = f.business_id and o.id = f.object_type_id
    where f.business_id = b and o.kind = 'deal' and f.key = 'event_date';
  begin
    insert into crm.object_types (business_id, id, kind, key, singular_label, plural_label,
                                  primary_field_id, created_by_kind)
      values (b, v_type, 'custom', 'boat', 'Boat', 'Boats', v_deal_field, 'user');
    set constraints all immediate;
    raise exception 'expected a primary field of another object to fail';
  exception when foreign_key_violation then null;
  end;
  set constraints all deferred;

  insert into crm.object_types (business_id, id, kind, key, singular_label, plural_label,
                                primary_field_id, created_by_kind)
    values (b, v_type, 'custom', 'boat', 'Boat', 'Boats', v_field, 'user');
  insert into crm.field_definitions (business_id, id, object_type_id, key, label, value_type,
                                     is_unique, created_by_kind)
    values (b, v_field, v_type, 'name', 'Boat name', 'text', true, 'user');
  set constraints all immediate;
  set constraints all deferred;
  if not exists (
    select from crm.field_definitions f
    join crm.field_folders d on d.business_id = f.business_id and d.id = f.folder_id
    where f.id = v_field and d.is_system and d.object_type_id = v_type) then
    raise exception 'expected the primary field in its object''s system folder';
  end if;
  begin
    update crm.object_types set key = 'ship' where id = v_type;
    raise exception 'expected an object''s key to stay';
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'object_types_identity_fixed' then raise; end if;
  end;
  begin
    update crm.object_types set primary_field_id = null where id = v_type;
    raise exception 'expected an object''s primary field to stay';
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'object_types_identity_fixed' then raise; end if;
  end;
  begin
    update crm.object_types set icon = 'Paw Print' where id = v_type;
    raise exception 'expected an icon name out of format to fail';
  exception when check_violation then
    if sqlerrm not like '%object_types_icon_format%' then raise; end if;
  end;
  update crm.object_types set singular_label = 'Vessel', plural_label = 'Vessels', icon = 'paw-print'
    where id = v_type;
  begin
    delete from crm.field_definitions where id = v_field;
    set constraints all immediate;
    raise exception 'expected the primary field to go only with its object';
  exception when foreign_key_violation then null;
  end;
  set constraints all deferred;

  begin
    update crm.field_definitions set is_searchable = true where id = v_deal_field;
    raise exception 'expected a date field to be refused as searchable';
  exception when check_violation then
    if sqlerrm not like '%field_definitions_searchable_type%' then raise; end if;
  end;
  begin
    insert into crm.field_definitions (business_id, object_type_id, key, label, value_type,
                                       is_unique, created_by_kind)
      values (b, v_type, 'skipper_email', 'Skipper email', 'email', true, 'user');
    raise exception 'expected an email field to be refused as unique';
  exception when check_violation then
    if sqlerrm not like '%field_definitions_unique_type%' then raise; end if;
  end;
  update crm.field_definitions set is_unique = false where id = v_field;
  begin
    update crm.field_definitions set is_unique = true where id = v_field;
    raise exception 'expected a field that stopped being unique to stay so';
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'field_definitions_unique_one_way' then raise; end if;
  end;
  delete from crm.object_types where id = v_type;
  raise notice 'ok: a custom object keeps its key and its own primary field, and unique fields only stop being so';
end $$;
reset role;

-- A unique field's values (0128): two records of one object never share one, compared
-- without case or surrounding spaces, until the field stops being unique; nobody deletes a
-- unique field. A record's title follows its primary field, and its object follows its
-- registry row. Searchable fields are searched, others are not. As crm_app, in business 1.
set role crm_app;
set app.agency_id = :'a1';
set app.business_id = :'b1';
set app.user_id = :'u2';
do $$
declare
  v_type uuid := uuidv7();
  v_name uuid := uuidv7();
  v_venue uuid := uuidv7();
  v_first uuid := uuidv7();
  v_second uuid := uuidv7();
  v_found uuid[];
  v_deleted integer;
begin
  insert into crm.object_types (business_id, id, kind, key, singular_label, plural_label,
                                primary_field_id, created_by_kind)
    values (app.business_id(), v_type, 'custom', 'gala', 'Gala', 'Galas', v_name, 'user');
  insert into crm.field_definitions (business_id, id, object_type_id, key, label, value_type,
                                     is_unique, created_by_kind)
    values (app.business_id(), v_name, v_type, 'name', 'Gala name', 'text', true, 'user');
  insert into crm.field_definitions (business_id, id, object_type_id, key, label, value_type,
                                     is_searchable, created_by_kind)
    values (app.business_id(), v_venue, v_type, 'venue', 'Venue', 'text', true, 'user');
  insert into crm.records (business_id, id, kind, object_type_id) values
    (app.business_id(), v_first, 'custom', v_type),
    (app.business_id(), v_second, 'custom', v_type);
  insert into crm.custom_records (business_id, id, title, created_by_kind) values
    (app.business_id(), v_first, 'Untitled', 'user'),
    (app.business_id(), v_second, 'Untitled', 'user');
  if (select count(*) from crm.custom_records
      where id in (v_first, v_second) and object_type_id = v_type) <> 2 then
    raise exception 'expected a custom record to take its object from its registry row';
  end if;

  insert into crm.field_values (business_id, record_id, field_id, value_type, value_text, source_kind)
    values (app.business_id(), v_first, v_name, 'text', 'Harbor Gala', 'user');
  if (select title from crm.custom_records where id = v_first) <> 'Harbor Gala' then
    raise exception 'expected the title to follow the primary field';
  end if;
  begin
    insert into crm.field_values (business_id, record_id, field_id, value_type, value_text, source_kind)
      values (app.business_id(), v_second, v_name, 'text', '  harbor GALA ', 'user');
    raise exception 'expected a second gala with the same name to fail';
  exception when unique_violation then
    if sqlerrm not like '%field_unique_values_pkey%' then raise; end if;
  end;
  insert into crm.field_values (business_id, record_id, field_id, value_type, value_text, source_kind)
    values (app.business_id(), v_second, v_name, 'text', 'Spring Gala', 'user');
  update crm.field_values set value_text = 'Winter Gala'
    where record_id = v_first and field_id = v_name;
  if (select title from crm.custom_records where id = v_first) <> 'Winter Gala'
     or (select value_key from crm.field_unique_values where record_id = v_first)
          <> encode(sha256(convert_to('winter gala', 'UTF8')), 'hex') then
    raise exception 'expected the title and the ledger to follow a changed value';
  end if;
  -- The old value is free again.
  update crm.field_values set value_text = 'Harbor gala'
    where record_id = v_second and field_id = v_name;

  delete from crm.field_definitions where id = v_name;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 0 then
    raise exception 'expected a unique field to be kept from deletion';
  end if;

  insert into crm.field_values (business_id, record_id, field_id, value_type, value_text, source_kind)
    values (app.business_id(), v_second, v_venue, 'text', 'The Boathouse Pavilion', 'user');
  select array_agg(distinct found.id) into v_found
    from private.search_custom_records(v_type, null, '%pavilion%', 100) as found (id);
  if v_found is distinct from array[v_second] then
    raise exception 'expected a searchable field to be searched, found %', v_found;
  end if;
  update crm.field_definitions set is_searchable = false where id = v_venue;
  if exists (select from private.search_custom_records(v_type, null, '%pavilion%', 100)) then
    raise exception 'expected a field that is not searchable to be left out of search';
  end if;

  update crm.field_definitions set is_unique = false where id = v_name;
  if exists (select from crm.field_unique_values where field_id = v_name) then
    raise exception 'expected a field that stops being unique to leave the ledger';
  end if;
  update crm.field_values set value_text = 'Harbor gala'
    where record_id = v_first and field_id = v_name;

  delete from crm.records where id in (v_first, v_second);
  delete from crm.field_definitions where id = v_venue;
  raise notice 'ok: unique values are one record''s each, titles follow the primary field, and search reads searchable fields';
end $$;

-- Associations (0128): every link type keeps its key and the objects it joins, and a
-- system one also whether it has a primary, and its place: only its labels change. A
-- user-defined one counts 1 to 1000 records a side, its pair of labels is unique for its
-- objects, and it links two records once, whichever way round.
do $$
declare
  v_type uuid := uuidv7();
  v_name uuid := uuidv7();
  v_contact_type uuid;
  v_company_type uuid;
  v_system uuid;
  v_hosts uuid;
  v_related uuid;
  v_constraint text;
  v_first uuid := uuidv7();
  v_second uuid := uuidv7();
  v_deleted integer;
begin
  select id into strict v_contact_type from crm.object_types where kind = 'contact';
  select id into strict v_company_type from crm.object_types where kind = 'company';
  insert into crm.object_types (business_id, id, kind, key, singular_label, plural_label,
                                primary_field_id, created_by_kind)
    values (app.business_id(), v_type, 'custom', 'regatta', 'Regatta', 'Regattas', v_name, 'user');
  insert into crm.field_definitions (business_id, id, object_type_id, key, label, value_type, created_by_kind)
    values (app.business_id(), v_name, v_type, 'name', 'Regatta name', 'text', 'user');

  insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id, label,
                              reverse_label, allows_primary, is_system, created_by_kind)
    values (app.business_id(), 'regatta_contact', v_type, v_contact_type, 'Sailor', 'Regatta',
            true, true, 'system')
    returning id into v_system;
  begin
    update crm.link_types set key = 'regatta_sailor' where id = v_system;
    raise exception 'expected a link type''s key to stay';
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'link_types_identity_fixed' then raise; end if;
  end;
  begin
    update crm.link_types set to_object_type_id = v_company_type where id = v_system;
    raise exception 'expected a link type''s objects to stay';
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'link_types_identity_fixed' then raise; end if;
  end;
  begin
    update crm.link_types set allows_primary = false where id = v_system;
    raise exception 'expected a system link type to keep its primary';
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'link_types_system_fixed' then raise; end if;
  end;
  update crm.link_types set label = 'Sailors', reverse_label = 'Regattas' where id = v_system;
  delete from crm.link_types where id = v_system;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 0 then
    raise exception 'expected a system link type to be kept from deletion';
  end if;

  insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id, label,
                              reverse_label, from_limit, to_limit, created_by_kind)
    values (app.business_id(), 'regatta_host', v_type, v_contact_type, 'Host', 'Hosted regatta',
            1000, 1, 'user')
    returning id into v_hosts;
  begin
    update crm.link_types set from_limit = 0 where id = v_hosts;
    raise exception 'expected a limit below 1 to fail';
  exception when check_violation then
    if sqlerrm not like '%link_types_from_limit_range%' then raise; end if;
  end;
  begin
    update crm.link_types set to_limit = 1001 where id = v_hosts;
    raise exception 'expected a limit above 1000 to fail';
  exception when check_violation then
    if sqlerrm not like '%link_types_to_limit_range%' then raise; end if;
  end;
  begin
    insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id, label,
                                reverse_label, created_by_kind)
      values (app.business_id(), 'regatta_host_2', v_type, v_contact_type, ' host ',
              'HOSTED REGATTA', 'user');
    raise exception 'expected the same pair of labels twice for one pair of objects to fail';
  exception when unique_violation then
    if sqlerrm not like '%link_types_label_unique_idx%' then raise; end if;
  end;
  begin
    insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id, label,
                                reverse_label, created_by_kind)
      values (app.business_id(), 'contact_hosted_regatta', v_contact_type, v_type,
              'Hosted regatta', 'Host', 'user');
    raise exception 'expected the same pair of labels read from the other object to fail';
  exception when unique_violation then
    if sqlerrm not like '%link_types_label_unique_idx%' then raise; end if;
  end;

  insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id, label,
                              reverse_label, from_limit, to_limit, created_by_kind)
    values (app.business_id(), 'regatta_related', v_type, v_type, 'Related', 'Related',
            1000, 1000, 'user')
    returning id into v_related;
  insert into crm.records (business_id, id, kind, object_type_id) values
    (app.business_id(), v_first, 'custom', v_type),
    (app.business_id(), v_second, 'custom', v_type);
  insert into crm.custom_records (business_id, id, title, created_by_kind) values
    (app.business_id(), v_first, 'Spring regatta', 'user'),
    (app.business_id(), v_second, 'Autumn regatta', 'user');
  insert into crm.record_links (business_id, link_type_id, from_record_id, to_record_id, source_kind)
    values (app.business_id(), v_related, v_first, v_second, 'user');
  begin
    insert into crm.record_links (business_id, link_type_id, from_record_id, to_record_id, source_kind)
      values (app.business_id(), v_related, v_second, v_first, 'user');
    raise exception 'expected the same two records linked back the other way to fail';
  exception when unique_violation then
    if sqlerrm not like '%record_links_pair_unique_idx%' then raise; end if;
  end;

  delete from crm.records where id in (v_first, v_second);
  delete from crm.link_types where id in (v_hosts, v_related);
  raise notice 'ok: link types keep their identity, system ones their place, and two records link once a type';
end $$;
reset role;

-- The daily purge finds a business by its custom records too (0128): business 2 has
-- nothing in the trash until one of its custom records has been there past retention.
set role crm_owner;
do $$
declare
  b constant uuid := 'bbbbbbb2-0000-7000-8000-000000000000';
  v_type uuid := uuidv7();
  v_name uuid := uuidv7();
  v_record uuid := uuidv7();
begin
  if exists (select from private.businesses_with_expired_trash(1000) t where t.business_id = b) then
    raise exception 'expected business 2 to have nothing expired in the trash yet';
  end if;
  insert into crm.object_types (business_id, id, kind, key, singular_label, plural_label,
                                primary_field_id, created_by_kind)
    values (b, v_type, 'custom', 'yacht', 'Yacht', 'Yachts', v_name, 'user');
  insert into crm.field_definitions (business_id, id, object_type_id, key, label, value_type, created_by_kind)
    values (b, v_name, v_type, 'name', 'Yacht name', 'text', 'user');
  insert into crm.records (business_id, id, kind, object_type_id) values (b, v_record, 'custom', v_type);
  insert into crm.custom_records (business_id, id, title, created_by_kind, deleted_at)
    values (b, v_record, 'Sea Breeze', 'user', now() - interval '40 days');
  if not exists (select from private.businesses_with_expired_trash(1000) t where t.business_id = b) then
    raise exception 'expected a custom record past retention to bring business 2 to the purge';
  end if;
  delete from crm.records where business_id = b and id = v_record;
  delete from crm.object_types where business_id = b and id = v_type;
  raise notice 'ok: the daily purge finds expired custom records';
end $$;
reset role;
