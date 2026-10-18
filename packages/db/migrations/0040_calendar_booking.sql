-- Snapshot elapsed appointment buffers; legacy rows retain their original occupied slot.
alter table calendar.appointments
  add column buffer_before_minutes smallint not null default 0
    constraint appointments_buffer_before_range check (buffer_before_minutes between 0 and 240),
  add column buffer_after_minutes smallint not null default 0
    constraint appointments_buffer_after_range check (buffer_after_minutes between 0 and 240),
  add column occupied_starts_at timestamptz,
  add column occupied_ends_at timestamptz;

update calendar.appointments set occupied_starts_at=starts_at, occupied_ends_at=ends_at;
alter table calendar.appointments
  alter column occupied_starts_at set not null,
  alter column occupied_ends_at set not null;

create function util.derive_appointment_occupancy()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.occupied_starts_at := new.starts_at - new.buffer_before_minutes * interval '1 minute';
  new.occupied_ends_at := new.ends_at + new.buffer_after_minutes * interval '1 minute';
  return new;
end;
$$;
create trigger derive_appointment_occupancy
before insert or update on calendar.appointments
for each row execute function util.derive_appointment_occupancy();

alter table calendar.appointments
  add constraint appointments_occupied_consistent check (
    occupied_starts_at=starts_at-buffer_before_minutes*interval '1 minute'
    and occupied_ends_at=ends_at+buffer_after_minutes*interval '1 minute'
    and occupied_ends_at>occupied_starts_at
  );

alter table calendar.appointments drop constraint appointments_no_double_booking;
alter table calendar.appointments
  add constraint appointments_no_double_booking exclude using gist (
    business_id with =,
    assigned_user_id with =,
    tstzrange(occupied_starts_at, occupied_ends_at, '[)') with &&
  ) where (status in ('booked', 'confirmed') and assigned_user_id is not null);

-- Capabilities are irreversible digests on appointments; queued confirmation bodies
-- contain the raw management link under the messaging module's existing access controls.
alter table calendar.appointments
  add column management_digest text
    constraint appointments_management_digest_valid check (management_digest ~ '^[0-9a-f]{64}$')
    constraint appointments_management_digest_unique unique,
  add column management_expires_at timestamptz,
  add column booking_request_id uuid,
  add column booking_request_digest text
    constraint appointments_booking_request_digest_valid check (booking_request_digest ~ '^[0-9a-f]{64}$'),
  add constraint appointments_management_together check (
    (management_digest is null)=(management_expires_at is null)
  ),
  add constraint appointments_booking_request_together check (
    (booking_request_id is null)=(booking_request_digest is null)
  ),
  add constraint appointments_booking_request_unique unique (business_id, calendar_id, booking_request_id);

-- Validate the stored minimal replay receipt before casting either instant. The PG18
-- timestamp input function supports the soft errors used by pg_input_is_valid.
create function util.valid_appointment_receipt(p_receipt jsonb)
returns boolean language plpgsql stable set search_path = ''
as $$
declare
  starts text;
  ends text;
  instant_pattern constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$';
begin
  if p_receipt is null or pg_catalog.jsonb_typeof(p_receipt)<>'object'
    or pg_catalog.octet_length(p_receipt::text)>1024 then return false; end if;
  if not (p_receipt ?& array['status','startsAt','endsAt'])
    or p_receipt-array['status','startsAt','endsAt']<>'{}'::jsonb then return false; end if;
  if pg_catalog.jsonb_typeof(p_receipt->'status')<>'string'
    or pg_catalog.jsonb_typeof(p_receipt->'startsAt')<>'string'
    or pg_catalog.jsonb_typeof(p_receipt->'endsAt')<>'string' then return false; end if;
  if p_receipt->>'status' not in ('booked','confirmed','cancelled','completed','no_show') then return false; end if;
  starts := p_receipt->>'startsAt';
  ends := p_receipt->>'endsAt';
  if starts !~ instant_pattern or ends !~ instant_pattern
    or pg_catalog.left(starts,5)='0000-' or pg_catalog.left(ends,5)='0000-' then return false; end if;
  if not pg_catalog.pg_input_is_valid(starts,'timestamp with time zone')
    or not pg_catalog.pg_input_is_valid(ends,'timestamp with time zone') then return false; end if;
  return ends::timestamptz>starts::timestamptz;
end;
$$;
revoke execute on function util.valid_appointment_receipt(jsonb) from public;
grant execute on function util.valid_appointment_receipt(jsonb) to crm_app;

-- A replay returns this original receipt; it never reapplies an earlier reschedule.
alter table calendar.calendars
  add column confirmation_account_id uuid,
  add foreign key (business_id, confirmation_account_id)
    references messaging.channel_accounts (business_id, id) on delete set null (confirmation_account_id);
alter table calendar.appointments
  add column confirmation_account_id uuid,
  add foreign key (business_id, confirmation_account_id)
    references messaging.channel_accounts (business_id, id) on delete set null (confirmation_account_id);
create index calendars_confirmation_account_idx
  on calendar.calendars (business_id, confirmation_account_id);
create index appointments_confirmation_account_idx
  on calendar.appointments (business_id, confirmation_account_id);
-- Business deletion cascades through CRM contacts to appointments. Check the retained
-- NO ACTION calendar reference after those cascades, still protecting calendar deletion.
alter table calendar.appointments
  alter constraint appointments_business_id_calendar_id_fkey deferrable initially deferred;

create table calendar.appointment_operations (
  business_id uuid not null,
  appointment_id uuid not null,
  operation_request_id uuid not null,
  operation text not null constraint appointment_operations_operation_valid check (operation in ('cancel','reschedule')),
  request_digest text not null constraint appointment_operations_digest_valid check (request_digest ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null constraint appointment_operations_receipt_valid check (util.valid_appointment_receipt(receipt)),
  confirmation_status text not null constraint appointment_operations_confirmation_valid
    check (confirmation_status in ('queued','refused','unavailable')),
  created_at timestamptz not null default now(),
  primary key (business_id, appointment_id, operation_request_id),
  foreign key (business_id, appointment_id) references calendar.appointments (business_id, id) on delete cascade
);
call util.enable_tenant_rls('calendar.appointment_operations');
grant select, insert on calendar.appointment_operations to crm_app;

-- Public capability resolvers expose only scope; commands validate live scope again
-- under tenant RLS and locks. No anonymous write or direct table privilege is granted.
create function private.resolve_calendar(p_agency_slug text, p_business_slug text, p_calendar_slug text)
returns table (agency_id uuid, business_id uuid, calendar_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, c.business_id, c.id
  from calendar.calendars c
  join tenancy.businesses b on b.id=c.business_id
  join tenancy.agencies g on g.id=b.agency_id
  join messaging.channel_accounts a on a.business_id=c.business_id and a.id=c.confirmation_account_id
  join messaging.mailboxes m on m.business_id=a.business_id and m.id=a.id
  where g.slug=p_agency_slug and b.slug=p_business_slug and c.booking_slug=p_calendar_slug
    and p_agency_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    and p_business_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    and p_calendar_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    and b.status='active' and c.is_active and c.kind in ('personal','round_robin')
    and a.channel='email' and a.status='active' and m.use_for_conversations
    and (select count(*) from calendar.calendar_members cm
      where cm.business_id=c.business_id and cm.calendar_id=c.id)
      between 1 and case when c.kind='personal' then 1 else 100 end
    and not exists (
      select from calendar.calendar_members cm
      where cm.business_id=c.business_id and cm.calendar_id=c.id and not exists (
        select from tenancy.memberships tm join auth.users u on u.id=tm.user_id
        where tm.agency_id=b.agency_id and tm.business_id=c.business_id
          and tm.user_id=cm.user_id and u.disabled_at is null
      )
    )
$$;
revoke execute on function private.resolve_calendar(text,text,text) from public;
grant execute on function private.resolve_calendar(text,text,text) to crm_app;

create function private.appointment_scope(p_digest text)
returns table (agency_id uuid, business_id uuid, appointment_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, a.business_id, a.id
  from calendar.appointments a join tenancy.businesses b on b.id=a.business_id
  where p_digest ~ '^[0-9a-f]{64}$' and a.management_digest=p_digest
    and a.management_expires_at>pg_catalog.statement_timestamp() and b.status='active'
$$;
revoke execute on function private.appointment_scope(text) from public;
grant execute on function private.appointment_scope(text) to crm_app;
