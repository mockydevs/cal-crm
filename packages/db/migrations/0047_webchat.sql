-- P1.39: the web chat widget. A widget (0006) already has a public key, its allowed
-- websites and its settings, and its channel account's status turns it on and off. What
-- was missing is the visitor: a session that proves a chat is theirs, and the list of
-- messages that belong to that session and to no other.

-- At most 20 websites, each one stored origin (packages/contracts/src/webchat.ts): the
-- application writes the canonical form, and the database refuses a list no request
-- could be matched against sensibly.
alter table messaging.webchat_widgets
  add constraint webchat_widgets_origins_bounded check (
    cardinality(allowed_origins) <= 20
    and array_position(allowed_origins, null) is null
    and array_position(allowed_origins, '') is null
    and array_position(allowed_origins, 'null') is null
    and array_position(allowed_origins, '*') is null);

-- One visitor's chat on one website. The token is shown to the visitor once; only its
-- SHA-256 digest (with the widget's id in it) is stored, so a copy of this table opens no
-- chat. A session starts without a contact: the visitor's details wait here until the
-- first message, when the contact and the conversation are made and the details cleared.
--
-- Nothing a visitor types proves who they are (ADR-049). So a session always gets a
-- contact and a conversation of its own, and never joins a contact that already existed:
-- a conversation has at most one session, and a session reads and is answered in no other.
create table messaging.webchat_sessions (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  widget_id uuid not null,
  token_digest text not null constraint webchat_sessions_digest_valid check (token_digest ~ '^[0-9a-f]{64}$'),
  -- The website it was started on. A session answers nowhere else.
  origin text not null constraint webchat_sessions_origin_length check (length(origin) between 1 and 255),
  visitor_name text constraint webchat_sessions_name_length check (length(visitor_name) between 1 and 80),
  visitor_email text constraint webchat_sessions_email_length check (length(visitor_email) between 3 and 320),
  -- True only when the visitor ticked the box, with the exact words that were beside it.
  marketing_consent boolean not null default false,
  consent_wording text constraint webchat_sessions_wording_length check (length(consent_wording) between 1 and 300),
  contact_id uuid,
  conversation_id uuid,
  -- The contact that already held the email address the visitor typed, if one did. It is a
  -- claim for the team to judge: the session was not attached to that contact.
  claimed_contact_id uuid,
  -- The place of the session's last message. Given while the session row is locked, so a
  -- message stored later always has a higher place, whichever transaction commits first.
  last_seq integer not null default 0 constraint webchat_sessions_seq_nonnegative check (last_seq >= 0),
  -- What the visitor has sent: in all, and in the current one-minute window.
  inbound_count integer not null default 0 constraint webchat_sessions_inbound_nonnegative check (inbound_count >= 0),
  minute_started_at timestamptz,
  minute_count integer not null default 0 constraint webchat_sessions_minute_nonnegative check (minute_count >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  primary key (business_id, id),
  foreign key (business_id, widget_id) references messaging.webchat_widgets (business_id, id) on delete cascade,
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade,
  foreign key (business_id, conversation_id) references messaging.conversations (business_id, id) on delete cascade,
  foreign key (business_id, claimed_contact_id) references crm.contacts (business_id, id)
    on delete set null (claimed_contact_id),
  constraint webchat_sessions_digest_unique unique (token_digest),
  constraint webchat_sessions_contact_with_conversation check ((contact_id is null) = (conversation_id is null)),
  constraint webchat_sessions_consent_has_proof
    check (not marketing_consent or (visitor_email is not null and consent_wording is not null)),
  constraint webchat_sessions_wording_only_with_consent check (marketing_consent or consent_wording is null),
  -- Once the contact exists the details live there, not here.
  constraint webchat_sessions_details_until_contact
    check (contact_id is null or (visitor_name is null and visitor_email is null and not marketing_consent)),
  constraint webchat_sessions_expiry_after_start check (expires_at > created_at),
  constraint webchat_sessions_window_complete check ((minute_started_at is null) = (minute_count = 0)),
  -- One session per contact and per conversation: the team's reply has one place to go.
  constraint webchat_sessions_contact_unique unique (business_id, contact_id),
  constraint webchat_sessions_conversation_unique unique (business_id, conversation_id),
  constraint webchat_sessions_claim_needs_contact check (claimed_contact_id is null or contact_id is not null),
  constraint webchat_sessions_claim_is_another check (claimed_contact_id <> contact_id)
);
-- How many sessions a widget started lately, and its expired ones.
create index webchat_sessions_widget_idx on messaging.webchat_sessions (business_id, widget_id, created_at);
create index webchat_sessions_claimed_contact_idx on messaging.webchat_sessions (business_id, claimed_contact_id);
-- Expired sessions that never became a chat, oldest first, for private.expire_webchat_sessions.
create index webchat_sessions_expiry_idx on messaging.webchat_sessions (expires_at)
  where contact_id is null;

-- Which messages a session may read: the visitor's own and the team's replies to that
-- session. A conversation is one per contact and holds every channel, and a visitor's
-- email address is only a claim, so a session never reads its conversation: it reads this.
create table messaging.webchat_session_messages (
  business_id uuid not null,
  session_id uuid not null,
  seq integer not null constraint webchat_session_messages_seq_positive check (seq >= 1),
  message_id uuid not null,
  -- Chosen by the widget for each message it sends, so a repeated request stores nothing new.
  client_message_id uuid,
  primary key (business_id, session_id, seq),
  foreign key (business_id, session_id) references messaging.webchat_sessions (business_id, id) on delete cascade,
  foreign key (business_id, message_id) references messaging.messages (business_id, id) on delete cascade,
  constraint webchat_session_messages_message_unique unique (business_id, message_id),
  constraint webchat_session_messages_client_unique unique (business_id, session_id, client_message_id)
);

call util.enable_tenant_rls('messaging.webchat_sessions');
call util.enable_tenant_rls('messaging.webchat_session_messages');
-- A session that never became a chat is deleted once expired. One that did is kept: it
-- holds none of the visitor's details any more, and it is what says the conversation came
-- through web chat, from whom nobody proved, and whose address they claimed. A session's
-- message list is only ever added to.
grant select, insert, update, delete on messaging.webchat_sessions to crm_app;
grant select, insert on messaging.webchat_session_messages to crm_app;

-- Removes sessions that expired without ever becoming a chat, in batches, for the worker's
-- maintenance schedule: the name and address a visitor typed must not outlive such a
-- session, on a widget nobody visits any more. A session another transaction holds is left
-- for the next run, so this never waits for a row.
create function private.expire_webchat_sessions(p_limit integer) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_deleted integer;
begin
  with due as (
    select s.business_id, s.id
    from messaging.webchat_sessions s
    where s.expires_at <= now() and s.contact_id is null
    order by s.expires_at
    limit least(greatest(p_limit, 1), 10000)
    for update skip locked
  )
  delete from messaging.webchat_sessions s using due
  where s.business_id = due.business_id and s.id = due.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;
revoke execute on function private.expire_webchat_sessions(integer) from public;
grant execute on function private.expire_webchat_sessions(integer) to crm_app;
