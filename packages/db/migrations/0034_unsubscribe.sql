-- The recipient capability is random, message-bound and stored only as a digest.
alter table messaging.outbound_dispatch
  add column unsubscribe_contact_id uuid,
  add column unsubscribe_digest text
    constraint outbound_dispatch_unsubscribe_digest_valid
      check (unsubscribe_digest ~ '^[0-9a-f]{64}$'),
  add column unsubscribe_used_at timestamptz,
  add constraint outbound_dispatch_unsubscribe_used_needs_digest
    check (unsubscribe_used_at is null or unsubscribe_digest is not null),
  add foreign key (business_id, unsubscribe_contact_id)
    references crm.contacts (business_id, id) on delete set null (unsubscribe_contact_id);

create unique index outbound_dispatch_unsubscribe_digest_idx
  on messaging.outbound_dispatch (unsubscribe_digest) where unsubscribe_digest is not null;
create index outbound_dispatch_unsubscribe_contact_idx
  on messaging.outbound_dispatch (business_id, unsubscribe_contact_id);

-- A capability locates its tenant before any session exists. It exposes no addresses,
-- bodies or credentials and grants no write: the tenant command validates it again.
create function private.unsubscribe_scope(p_digest text)
returns table (agency_id uuid, business_id uuid, contact_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, d.business_id, d.unsubscribe_contact_id
  from messaging.outbound_dispatch d
  join messaging.messages m on m.business_id=d.business_id and m.id=d.id
  join messaging.conversations v on v.business_id=m.business_id and v.id=m.conversation_id
  join tenancy.businesses b on b.id=d.business_id
  where d.unsubscribe_digest=p_digest and d.purpose='marketing'
    and v.contact_id=d.unsubscribe_contact_id
    and m.direction='outbound' and m.channel='email'
$$;
revoke execute on function private.unsubscribe_scope(text) from public;
grant execute on function private.unsubscribe_scope(text) to crm_app;
