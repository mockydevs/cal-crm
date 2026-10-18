-- The install's trusted sender selection is resolved before a user signs in. Only scope
-- identifiers cross this boundary; message bodies and credentials remain tenant-owned.
create function private.install_mailbox_scope(p_mailbox_id uuid)
returns table (agency_id uuid, business_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, m.business_id
  from messaging.mailboxes m
  join messaging.channel_accounts c on c.business_id = m.business_id and c.id = m.id
  join tenancy.businesses b on b.id = m.business_id
  where m.id = p_mailbox_id and m.auth_method = 'password'
    and c.status = 'active' and b.status = 'active'
$$;
revoke execute on function private.install_mailbox_scope(uuid) from public;
grant execute on function private.install_mailbox_scope(uuid) to crm_app;

create index secrets_install_message_expiry_idx on vault.secrets (created_at, id)
  where purpose = 'mailbox.install_message';

create function private.expired_install_messages(p_limit integer)
returns table (agency_id uuid, business_id uuid, message_id uuid)
language sql stable security definer set search_path = ''
as $$
  select s.agency_id, s.business_id, s.id
  from vault.secrets s
  where s.purpose = 'mailbox.install_message' and s.business_id is not null
    and s.created_at <= now() - interval '10 minutes'
  order by s.created_at, s.id
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function private.expired_install_messages(integer) from public;
grant execute on function private.expired_install_messages(integer) to crm_app;
