-- Inbound mail is read on every tick of the worker's two-minute schedule. 0035 called a
-- mailbox due only once its last read was two full minutes old, and a read ends a few
-- seconds after the tick that queued it: at the next tick it was a few seconds short of
-- two minutes, was passed over, and so was read every four minutes. One minute is past at
-- the next tick for any read that took less than a minute, and still keeps a mailbox just
-- read, by hand or by a recovery, from being read again at once. Nothing else about the
-- function changes.
create or replace function private.due_mailbox_syncs(p_limit integer)
returns table (agency_id uuid, business_id uuid, mailbox_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, m.business_id, m.id
  from messaging.mailboxes m
  join messaging.channel_accounts c on c.business_id = m.business_id and c.id = m.id
  join tenancy.businesses b on b.id = m.business_id
  where c.status = 'active' and b.status = 'active' and m.use_for_conversations
    and m.imap_host is not null
    and (m.last_synced_at is null or m.last_synced_at <= now() - interval '1 minute')
  order by m.last_sync_enqueued_at nulls first, m.business_id, m.id
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function private.due_mailbox_syncs(integer) from public;
grant execute on function private.due_mailbox_syncs(integer) to crm_app;
