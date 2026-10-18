-- Consent and opt-out belong to the address (ADR-098, superseding ADR-039).
--
-- A consent change now names the email address or phone number it was given or withdrawn
-- for. A grant counts only for the contact and address it names; a withdrawal counts for
-- its address whichever contact holds it later, and for every address of its contact.
-- Withdrawals that name an address outlive their contact: a contact purged from the trash
-- and imported again is still opted out (15 U.S.C. 7704(a)(4): no commercial email to a
-- recipient more than 10 business days after an opt-out request).

-- Every change knows its business directly, so rows kept after their contact still go
-- with the business.
alter table messaging.consents
  add column address_normalized text
    constraint consents_address_length check (length(address_normalized) between 1 and 320),
  alter column contact_id drop not null,
  add foreign key (business_id) references tenancy.businesses (id) on delete cascade;

alter table messaging.consents drop constraint consents_business_id_contact_id_fkey;
alter table messaging.consents
  add constraint consents_business_id_contact_id_fkey foreign key (business_id, contact_id)
    references crm.contacts (business_id, id) on delete set null (contact_id),
  -- Only an address's withdrawal is kept without its contact (the trigger below).
  add constraint consents_kept_without_contact
    check (contact_id is not null or (address_normalized is not null and status = 'withdrawn'));

create index consents_address_idx
  on messaging.consents (business_id, channel, purpose, address_normalized, recorded_at desc, id desc)
  where address_normalized is not null;

-- When a contact is purged, its grants and its contact-wide changes go with it, as before;
-- the withdrawals of an address stay, with no contact, so the address stays opted out.
-- Security definer: the app role may not delete ledger rows (0012), and the purge is
-- the only delete of a contact.
create function private.keep_address_withdrawals() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from messaging.consents k
  where k.business_id = old.business_id and k.contact_id = old.id
    and not (k.status = 'withdrawn' and k.address_normalized is not null);
  return old;
end
$$;
revoke execute on function private.keep_address_withdrawals() from public;
create trigger contacts_keep_address_withdrawals
  before delete on crm.contacts
  for each row execute function private.keep_address_withdrawals();

-- The unsubscribe capability is its own record: the address the email went to, kept after
-- the message, the conversation or the contact is gone, so the link works however long
-- after the send it is used (the FTC asks for at least 30 days).
create table messaging.unsubscribe_links (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  digest text primary key constraint unsubscribe_links_digest_valid check (digest ~ '^[0-9a-f]{64}$'),
  channel text not null default 'email' constraint unsubscribe_links_channel_valid check (channel = 'email'),
  address_normalized text not null
    constraint unsubscribe_links_address_length check (length(address_normalized) between 3 and 320),
  message_id uuid,
  contact_id uuid,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  foreign key (business_id, message_id)
    references messaging.messages (business_id, id) on delete set null (message_id),
  foreign key (business_id, contact_id)
    references crm.contacts (business_id, id) on delete set null (contact_id)
);
create unique index unsubscribe_links_message_idx
  on messaging.unsubscribe_links (business_id, message_id) where message_id is not null;
create index unsubscribe_links_contact_idx on messaging.unsubscribe_links (business_id, contact_id);
call util.enable_tenant_rls('messaging.unsubscribe_links');
grant select, insert, update on messaging.unsubscribe_links to crm_app;

-- Links issued before this migration move over, with the address their email went to.
insert into messaging.unsubscribe_links
  (business_id, digest, address_normalized, message_id, contact_id, created_at, last_used_at)
select d.business_id, d.unsubscribe_digest, m.to_addresses[1], d.id, d.unsubscribe_contact_id,
  coalesce(d.reserved_at, m.created_at), d.unsubscribe_used_at
from messaging.outbound_dispatch d
join messaging.messages m on m.business_id = d.business_id and m.id = d.id
where d.unsubscribe_digest is not null and cardinality(m.to_addresses) >= 1;

-- The message keeps only whether its link was used, for its statistics.
drop function private.unsubscribe_scope(text);
alter table messaging.outbound_dispatch
  drop constraint outbound_dispatch_unsubscribe_used_needs_digest,
  drop column unsubscribe_digest,
  drop column unsubscribe_contact_id;

-- A capability locates its tenant before any session exists. It exposes no address, body
-- or credential and grants no write: the tenant command reads the link again.
create function private.unsubscribe_scope(p_digest text)
returns table (agency_id uuid, business_id uuid, contact_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, l.business_id, l.contact_id
  from messaging.unsubscribe_links l
  join tenancy.businesses b on b.id = l.business_id
  where l.digest = p_digest
$$;
revoke execute on function private.unsubscribe_scope(text) from public;
grant execute on function private.unsubscribe_scope(text) to crm_app;
