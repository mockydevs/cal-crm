-- P1.40 and P1.41: the Inbox. A conversation's unread count and needs-reply flag are
-- derived by the database from its messages, whoever writes them, and an internal note
-- can't enter the outbound pipeline.

-- The order messages were stored in, per conversation. It is given while the conversation
-- is locked, so a message stored later always has a higher number, whatever its received
-- time says and whichever transaction commits first.
alter table messaging.conversations
  add column message_seq bigint not null default 0
    constraint conversations_message_seq_nonnegative check (message_seq >= 0),
  -- The team has read every message up to this one. Unread is what was stored after it.
  add column read_through_seq bigint not null default 0;
alter table messaging.messages add column seq bigint not null default 0;

update messaging.messages m set seq = numbered.seq
from (
  select business_id, id,
    row_number() over (partition by business_id, conversation_id order by id) as seq
  from messaging.messages
) numbered
where numbered.business_id = m.business_id and numbered.id = m.id;
-- Nothing could be marked read before this. A conversation the old counter called fully
-- read is read through its last message; any other keeps all its messages unread.
update messaging.conversations c set
  message_seq = counted.last_seq,
  read_through_seq = case when c.unread_count = 0 then counted.last_seq else 0 end
from (
  select business_id, conversation_id, max(seq) as last_seq
  from messaging.messages group by business_id, conversation_id
) counted
where counted.business_id = c.business_id and counted.conversation_id = c.id;

alter table messaging.conversations add constraint conversations_read_through_range
  check (read_through_seq between 0 and message_seq);
alter table messaging.messages add constraint messages_seq_positive check (seq > 0);
create unique index messages_conversation_seq_idx
  on messaging.messages (business_id, conversation_id, seq);
create index messages_unread_idx on messaging.messages (business_id, conversation_id, seq)
  where direction = 'inbound';

-- An internal note has a status of its own and nothing a delivery needs: no account, no
-- recipients, no schedule. It can never be 'queued', the only status
-- private.enqueue_outbound accepts. It may carry a retry key, so a request sent twice
-- stores one note; a key alone leads nowhere without a dispatch row, which it can not get.
alter table messaging.messages drop constraint messages_status_valid;
alter table messaging.messages add constraint messages_status_valid check (status in (
  'received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'bounced', 'unknown',
  'note'));
update messaging.messages set status = 'note' where channel = 'note';
alter table messaging.messages add constraint messages_note_status
  check ((channel = 'note') = (status = 'note'));
alter table messaging.messages add constraint messages_note_cannot_be_delivered check (
  channel <> 'note' or (
    channel_account_id is null and scheduled_for is null
    and provider_message_id is null and email_message_id is null and from_address is null
    and to_addresses = '{}' and cc_addresses = '{}' and bcc_addresses = '{}'
    and subject is null and body_html is null and proposal_id is null));

-- Only an outbound message can have a dispatch row, and so a delivery: the same shape as
-- the channel on channel_accounts.
alter table messaging.messages
  add constraint messages_id_direction_unique unique (business_id, id, direction);
alter table messaging.outbound_dispatch
  add column direction text not null default 'outbound'
    constraint outbound_dispatch_direction_fixed check (direction = 'outbound');
alter table messaging.outbound_dispatch add constraint outbound_dispatch_outbound_message_fk
  foreign key (business_id, id, direction)
  references messaging.messages (business_id, id, direction) on delete cascade;

-- Whatever a writer sets, these two columns hold what the messages say.
--   unread_count: the contact's messages stored after read_through_seq.
--   needs_reply:  the last stored message that counts is the contact's. Notes don't count,
--                 and neither does an outbound message that failed, bounced or whose
--                 delivery is unknown: none of those is a reply the contact received.
create function private.derive_conversation_summary()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.unread_count := (
    select count(*) from messaging.messages m
    where m.business_id = new.business_id and m.conversation_id = new.id
      and m.direction = 'inbound' and m.seq > new.read_through_seq);
  new.needs_reply := coalesce((
    select m.direction = 'inbound' from messaging.messages m
    where m.business_id = new.business_id and m.conversation_id = new.id
      and m.direction <> 'internal'
      and not (m.direction = 'outbound' and m.status in ('failed', 'bounced', 'unknown'))
    order by m.seq desc limit 1), false);
  return new;
end
$$;
revoke execute on function private.derive_conversation_summary() from public;
create trigger derive_summary
  before insert or update on messaging.conversations
  for each row execute function private.derive_conversation_summary();

-- Locks the conversation before the message exists, so numbers follow the lock order.
-- The one lock order for everything that writes conversations and messages is: the
-- business row, then the conversation, then messages. The outbound worker holds the
-- business FOR UPDATE while it changes a message, and that change reaches the conversation
-- through message_changed below; so a writer that held a conversation and only then needed
-- the business (an event's foreign key takes it FOR KEY SHARE) could deadlock with it.
-- The business is therefore taken here first, for a writer that has not taken it itself.
create function private.number_message()
returns trigger language plpgsql set search_path = ''
as $$
begin
  perform 1 from tenancy.businesses b where b.id = new.business_id for key share;
  update messaging.conversations set message_seq = message_seq + 1
    where business_id = new.business_id and id = new.conversation_id
    returning message_seq into new.seq;
  if not found then
    raise exception 'the conversation of a message must exist and be visible'
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end
$$;
revoke execute on function private.number_message() from public;
create trigger number_message
  before insert on messaging.messages
  for each row execute function private.number_message();

-- A stored message, or one whose status changed, brings its conversation up to date and
-- tells open dashboards to refetch (ADR-025): PostgreSQL delivers the notification only
-- after commit, and it carries the business id and no row data.
create function private.message_changed()
returns trigger language plpgsql set search_path = ''
as $$
begin
  update messaging.conversations
    set last_message_at = case when new.direction = 'internal' then last_message_at
      else greatest(last_message_at, new.created_at) end
    where business_id = new.business_id and id = new.conversation_id;
  perform pg_notify('crm_business_changed', new.business_id::text);
  return null;
end
$$;
revoke execute on function private.message_changed() from public;
create trigger message_changed
  after insert or update of status on messaging.messages
  for each row execute function private.message_changed();

-- Bring every existing conversation to the derived values.
update messaging.conversations set message_seq = message_seq;

-- The list: latest activity first. A conversation with no message yet sorts by its start.
create index conversations_activity_idx on messaging.conversations
  (business_id, (coalesce(last_message_at, created_at)) desc, id desc);
-- The sidebar's counts read only the conversations that count.
create index conversations_unread_idx on messaging.conversations (business_id)
  where unread_count > 0;
create index conversations_needs_reply_idx on messaging.conversations
  (business_id, (coalesce(last_message_at, created_at)) desc, id desc) where needs_reply;
