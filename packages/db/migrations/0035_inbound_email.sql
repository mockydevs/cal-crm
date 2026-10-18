-- P1.35: inbound email over IMAP (ADR-040). Every inbox UID the sync reads gets exactly one
-- outcome, so a permanently refused or withheld message can't block later mail, a re-sync can't store a
-- message twice, and P1.36 can find delivery reports again by their UID.

-- Auto-Submitted mail (RFC 3834) stays ordinary inbox mail, marked for anti-loop policy.
alter table messaging.messages add column automated boolean not null default false;
-- The stored message a reply answers, proven by a lookup in the same conversation; the raw
-- In-Reply-To and References stay in in_reply_to and email_references.
alter table messaging.messages add column parent_message_id uuid;
alter table messaging.messages add constraint messages_parent_fk
  foreign key (business_id, parent_message_id) references messaging.messages (business_id, id)
  on delete set null (parent_message_id);
alter table messaging.messages add constraint messages_parent_not_self
  check (parent_message_id is distinct from id);
create index messages_parent_idx on messaging.messages (business_id, parent_message_id)
  where parent_message_id is not null;

-- When inbound sync began, taken just before the inbox baseline was read: mail the server
-- sends again after a UIDVALIDITY reset is read only if it was received after this.
alter table messaging.mailboxes add column inbound_started_at timestamptz;
-- Independent of successful reads: failing mailboxes must not monopolize discovery's limit.
alter table messaging.mailboxes add column last_sync_enqueued_at timestamptz;
-- The UIDVALIDITY of that baseline. Every batch read under another one, from the first
-- reset on, is held to the start time, so no batch imports mail from before it.
alter table messaging.mailboxes add column inbound_uid_validity bigint
  constraint mailboxes_inbound_uid_validity_range check (inbound_uid_validity between 1 and 4294967295);

create table messaging.mailbox_inbound_uids (
  business_id uuid not null,
  mailbox_id uuid not null,
  -- RFC 9051: both are nonzero unsigned 32-bit numbers.
  uid_validity bigint not null constraint mailbox_inbound_uids_validity_range
    check (uid_validity between 1 and 4294967295),
  uid bigint not null constraint mailbox_inbound_uids_uid_range check (uid between 1 and 4294967295),
  outcome text not null constraint mailbox_inbound_uids_outcome_valid check (outcome in (
    'stored',             -- a new inbound message
    'duplicate',          -- already stored: same Message-ID, or the same bytes without one
    'refused',            -- too large or not parseable; temporary read failures retry
    'own_message',        -- a message this mailbox sent, matched by its Message-ID
    'sender_is_mailbox',  -- From claims the mailbox's own address but isn't a known message of ours
    'sender_unresolved',  -- no From address, or more than one
    'delivery_report',    -- a DSN (RFC 3464), left for bounce handling (P1.36)
    'before_connection'   -- re-sent after a UIDVALIDITY reset, but received before sync began
  )),
  reason text constraint mailbox_inbound_uids_reason_valid
    check (reason in ('message_too_large', 'malformed', 'html_too_large',
      'too_many_attachments', 'received_date_unavailable')),
  message_id uuid,
  source_sha256 bytea constraint mailbox_inbound_uids_digest_length check (length(source_sha256) = 32),
  created_at timestamptz not null default now(),
  primary key (business_id, mailbox_id, uid_validity, uid),
  foreign key (business_id, mailbox_id) references messaging.mailboxes (business_id, id) on delete cascade,
  foreign key (business_id, message_id) references messaging.messages (business_id, id)
    on delete set null (message_id),
  constraint mailbox_inbound_uids_reason_only_refused check ((outcome = 'refused') = (reason is not null)),
  -- A refused source may never have been read; every other outcome comes from its bytes.
  constraint mailbox_inbound_uids_digest_unless_refused
    check (outcome = 'refused' or source_sha256 is not null),
  constraint mailbox_inbound_uids_message_only_stored
    check (outcome in ('stored', 'duplicate', 'own_message') or message_id is null)
);
-- The same bytes are stored once per mailbox, also across a UIDVALIDITY reset, which the
-- Message-ID index can't cover for mail without a Message-ID.
create unique index mailbox_inbound_uids_stored_digest_unique
  on messaging.mailbox_inbound_uids (business_id, mailbox_id, source_sha256) where outcome = 'stored';
create index mailbox_inbound_uids_message_idx on messaging.mailbox_inbound_uids (business_id, message_id)
  where message_id is not null;
create index mailbox_inbound_uids_reports_idx on messaging.mailbox_inbound_uids (business_id, mailbox_id, created_at)
  where outcome = 'delivery_report';
call util.enable_tenant_rls('messaging.mailbox_inbound_uids');
grant select, insert on messaging.mailbox_inbound_uids to crm_app;

create index mailboxes_sync_due_idx on messaging.mailboxes (last_sync_enqueued_at nulls first, business_id, id);

-- Mailboxes whose inbox is due a read. Lists identifiers only; each sync then runs in its own
-- tenant transaction, and the per-mailbox queue keeps two reads of one inbox from overlapping.
create function private.due_mailbox_syncs(p_limit integer)
returns table (agency_id uuid, business_id uuid, mailbox_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, m.business_id, m.id
  from messaging.mailboxes m
  join messaging.channel_accounts c on c.business_id = m.business_id and c.id = m.id
  join tenancy.businesses b on b.id = m.business_id
  where c.status = 'active' and b.status = 'active' and m.use_for_conversations
    and m.imap_host is not null
    and (m.last_synced_at is null or m.last_synced_at <= now() - interval '2 minutes')
  order by m.last_sync_enqueued_at nulls first, m.business_id, m.id
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function private.due_mailbox_syncs(integer) from public;
grant execute on function private.due_mailbox_syncs(integer) to crm_app;

-- The caller names only a mailbox its tenant context can see; the payload carries no
-- credentials, and the job key keeps one waiting sync per mailbox.
create function private.enqueue_mailbox_sync(p_mailbox_id uuid, p_causation_id uuid default null)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_job_id bigint;
begin
  if not exists (
    select 1 from messaging.mailboxes m
    join tenancy.businesses b on b.id = m.business_id
    where m.id = p_mailbox_id and m.business_id = app.business_id() and b.agency_id = app.agency_id()
  ) then
    raise exception 'mailbox is not available in this context';
  end if;
  -- The mailbox row first, then the job: the ingest command holds the mailbox and then
  -- queues its continuation, so one lock order keeps the two from deadlocking. Only a
  -- successful enqueue rotates this mailbox behind the others: the timestamp and the job
  -- commit or roll back together in the caller's transaction.
  update messaging.mailboxes set last_sync_enqueued_at = now()
    where id = p_mailbox_id and business_id = app.business_id();
  select job.id into v_job_id from graphile_worker.add_job(
    'mailboxes.sync',
    payload := jsonb_build_object(
      'agencyId', app.agency_id(), 'businessId', app.business_id(),
      'correlationId', app.correlation_id(), 'causationId', p_causation_id,
      'data', jsonb_build_object('mailboxId', p_mailbox_id)
    )::json,
    queue_name := 'mailbox-sync:' || p_mailbox_id::text,
    job_key := 'mailbox-sync:' || p_mailbox_id::text,
    job_key_mode := 'preserve_run_at'
  ) as job;
  return v_job_id;
end
$$;
revoke execute on function private.enqueue_mailbox_sync(uuid, uuid) from public;
grant execute on function private.enqueue_mailbox_sync(uuid, uuid) to crm_app;
