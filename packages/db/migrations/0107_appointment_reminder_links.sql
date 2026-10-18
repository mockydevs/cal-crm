-- Appointment reminders (ADR-098 and ADR-085, amendments of 2026-10-15).
--
-- 1. A reminder's own link to reschedule or cancel. The booking's management token is
--    stored only as a digest (0040), so no later message can carry it. A reminder link is
--    made the way a document's public address is (0080, ADR-085): the token is a keyed
--    digest of this row's id (HMAC-SHA-256 under the install's public intake secret), so
--    the worker can write the same address in every reminder and a copy of the database
--    alone opens nothing. The row keeps the SHA-256 of the token. One link an
--    appointment; a new one replaces the row, which stops the old one at once. It opens
--    only while the appointment is booked or confirmed and has not ended.
create table calendar.appointment_links (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  appointment_id uuid not null,
  digest text not null constraint appointment_links_digest_valid check (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint appointment_links_appointment_unique unique (business_id, appointment_id),
  constraint appointment_links_appointment foreign key (business_id, appointment_id)
    references calendar.appointments (business_id, id) on delete cascade
);
-- The lookup of an opened link, before any tenant is known.
create unique index appointment_links_digest_unique on calendar.appointment_links (digest);
call util.enable_tenant_rls('calendar.appointment_links');
-- A link is made, read and replaced (deleted and made again), never changed.
grant select, insert, delete on calendar.appointment_links to crm_app;

comment on table calendar.appointment_links is
  'A reminder''s keyed link to reschedule or cancel one appointment (ADR-085 pattern). Only the token''s SHA-256 is kept.';

-- An opened management address locates its tenant before any session exists (0040): the
-- booking's own token, as before, or a reminder link, which answers only while its
-- appointment is booked or confirmed and has not ended. Three ids, no write: the tenant
-- transaction reads the appointment again under row-level security, by the same digest.
create or replace function private.appointment_scope(p_digest text)
returns table (agency_id uuid, business_id uuid, appointment_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, a.business_id, a.id
  from calendar.appointments a join tenancy.businesses b on b.id=a.business_id
  where p_digest ~ '^[0-9a-f]{64}$' and a.management_digest=p_digest
    and a.management_expires_at>pg_catalog.statement_timestamp() and b.status='active'
  union all
  select b.agency_id, a.business_id, a.id
  from calendar.appointment_links l
  join calendar.appointments a on a.business_id=l.business_id and a.id=l.appointment_id
  join tenancy.businesses b on b.id=a.business_id
  where p_digest ~ '^[0-9a-f]{64}$' and l.digest=p_digest
    and a.status in ('booked','confirmed') and a.ends_at>pg_catalog.statement_timestamp()
    and b.status='active'
$$;
revoke execute on function private.appointment_scope(text) from public;
grant execute on function private.appointment_scope(text) to crm_app;

-- 2. The appointment a transactional message is about (an appointment reminder). Quiet
--    hours do not hold a message about the contact's own appointment while it is ahead
--    (outbound-policy.ts): the dispatch reads the appointment again each time it decides.
--    Only a transactional message may name one. Deleting the appointment leaves the
--    message, which is then held like any other.
alter table messaging.outbound_dispatch add column appointment_id uuid;
alter table messaging.outbound_dispatch
  add constraint outbound_dispatch_appointment_transactional
    check (appointment_id is null or purpose = 'transactional'),
  add constraint outbound_dispatch_appointment foreign key (business_id, appointment_id)
    references calendar.appointments (business_id, id) on delete set null (appointment_id);
create index outbound_dispatch_appointment_idx on messaging.outbound_dispatch (business_id, appointment_id)
  where appointment_id is not null;
