-- Public forms and booking, fixed after the edge-case hunt of 2026-10-14
-- (tasks/edge-cases/public-intake.md: C1, C4, H2, H3, H5).

-- C1: a form's render token is good for one submission. The token's digest is kept with
-- the submission it was spent on; a second submission with it is refused (forms public.ts).
-- What a form refuses is counted per source (an IPv4 address, or an IPv6 /64), read by
-- the address the submission came from.
alter table forms.submissions
  add column render_mark text
    constraint submissions_render_mark_shape check (render_mark ~ '^[A-Za-z0-9_-]{43}$');
create unique index submissions_render_mark_unique
  on forms.submissions (business_id, form_id, render_mark) where render_mark is not null;
create index submissions_form_source_idx
  on forms.submissions (business_id, form_id, ip, submitted_at) where ip is not null;

-- C4: one person has one diary, whichever business they are booked in. Each booked or
-- confirmed appointment with a host has a row here, kept by the trigger below, and the
-- exclusion constraint refuses two that overlap for the same person, across every business.
-- Postgres checks a constraint against every row whatever row-level security shows, so the
-- guarantee holds across tenants. Only the trigger (security definer) writes here; the app
-- role reads no row of it, and private.host_busy below answers only busy or free.
create table calendar.host_bookings (
  business_id uuid not null,
  appointment_id uuid not null,
  user_id uuid not null,
  occupied tstzrange not null constraint host_bookings_occupied_bounded
    check (not isempty(occupied) and lower_inc(occupied) and not upper_inc(occupied)),
  primary key (business_id, appointment_id),
  foreign key (business_id, appointment_id)
    references calendar.appointments (business_id, id) on delete cascade,
  constraint host_bookings_no_overlap exclude using gist (
    user_id with =,
    occupied with &&
  )
);
call util.enable_tenant_rls('calendar.host_bookings');

create function private.sync_host_booking()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.assigned_user_id is not distinct from old.assigned_user_id
      and new.occupied_starts_at = old.occupied_starts_at
      and new.occupied_ends_at = old.occupied_ends_at
      and new.status = old.status then
      return null;
    end if;
    delete from calendar.host_bookings
      where business_id = old.business_id and appointment_id = old.id;
  end if;
  if new.status in ('booked', 'confirmed') and new.assigned_user_id is not null then
    insert into calendar.host_bookings (business_id, appointment_id, user_id, occupied)
    values (new.business_id, new.id, new.assigned_user_id,
      pg_catalog.tstzrange(new.occupied_starts_at, new.occupied_ends_at, '[)'));
  end if;
  return null;
end;
$$;
revoke execute on function private.sync_host_booking() from public;
create trigger sync_host_booking
after insert or update on calendar.appointments
for each row execute function private.sync_host_booking();

-- What is booked already. Two appointments of one person in two businesses that overlap
-- were possible before this; the earlier booking is kept here and the later one is left
-- out, so this migration never fails on them. The later one still blocks its own business
-- (appointments_no_double_booking), and is checked again the moment it is moved.
insert into calendar.host_bookings (business_id, appointment_id, user_id, occupied)
select business_id, id, assigned_user_id, tstzrange(occupied_starts_at, occupied_ends_at, '[)')
from calendar.appointments
where status in ('booked', 'confirmed') and assigned_user_id is not null
order by created_at, id
on conflict do nothing;

-- The busy times of the given hosts in every other business, as bare ranges: no business,
-- no appointment, no contact. Only people on a calendar of the caller's own business can be
-- asked about, so a business learns nothing of anyone who is not on its own team.
create function private.host_busy(p_user_ids uuid[], p_from timestamptz, p_to timestamptz)
returns table (user_id uuid, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select h.user_id, lower(h.occupied), upper(h.occupied)
  from calendar.host_bookings h
  where h.user_id = any (p_user_ids)
    and h.business_id <> app.require_business_id()
    and h.occupied && pg_catalog.tstzrange(p_from, p_to, '[)')
    and exists (
      select from calendar.calendar_members cm
      where cm.business_id = app.require_business_id() and cm.user_id = h.user_id
    )
$$;
revoke execute on function private.host_busy(uuid[], timestamptz, timestamptz) from public;
grant execute on function private.host_busy(uuid[], timestamptz, timestamptz) to crm_app;

-- H2: an invite's SEQUENCE (RFC 5545 3.8.7.4, RFC 5546 2.1.4) goes up whenever the
-- appointment's time or status changes, whoever changes it. The time zone the booker
-- chose is kept, so every confirmation gives the time in it.
alter table calendar.appointments
  add column sequence integer not null default 0
    constraint appointments_sequence_range check (sequence >= 0),
  add column booker_timezone text
    constraint appointments_booker_timezone_length check (length(booker_timezone) between 1 and 64),
  -- H4: the booking page's render token is spent on the booking it was sent with, as a
  -- form's is (the forms mechanism, reused).
  add column render_mark text
    constraint appointments_render_mark_shape check (render_mark ~ '^[A-Za-z0-9_-]{43}$');
create unique index appointments_render_mark_unique
  on calendar.appointments (business_id, calendar_id, render_mark) where render_mark is not null;

create function util.bump_appointment_sequence()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.starts_at <> old.starts_at or new.ends_at <> old.ends_at or new.status <> old.status then
    new.sequence := old.sequence + 1;
  else
    new.sequence := old.sequence;
  end if;
  return new;
end;
$$;
create trigger bump_appointment_sequence
before update on calendar.appointments
for each row execute function util.bump_appointment_sequence();

-- The calendar invite an email carries (RFC 6047 iMIP): its method and the iCalendar text,
-- sent as the text/calendar part of that message.
create table messaging.message_invites (
  business_id uuid not null,
  message_id uuid not null,
  method text not null constraint message_invites_method_valid check (method in ('REQUEST', 'CANCEL')),
  content text not null constraint message_invites_content_length check (length(content) between 1 and 16384),
  created_at timestamptz not null default now(),
  primary key (business_id, message_id),
  foreign key (business_id, message_id) references messaging.messages (business_id, id) on delete cascade
);
call util.enable_tenant_rls('messaging.message_invites');
grant select, insert on messaging.message_invites to crm_app;

-- H5: a calendar takes public bookings without a connected mailbox. A booking is then
-- recorded and shown on the page with its management link, no email is sent, and the host
-- is told as for every booking. Everything else the resolver checks is unchanged (0048).
create or replace function private.resolve_calendar(p_agency_slug text, p_business_slug text, p_calendar_slug text)
returns table (agency_id uuid, business_id uuid, calendar_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, c.business_id, c.id
  from calendar.calendars c
  join tenancy.businesses b on b.id=c.business_id
  join tenancy.agencies g on g.id=b.agency_id
  cross join lateral (
    select count(*) as stored,
      count(*) filter (where exists (
        select from tenancy.memberships tm join auth.users u on u.id=tm.user_id
        where tm.agency_id=b.agency_id and tm.business_id=c.business_id
          and tm.user_id=cm.user_id and u.disabled_at is null
      )) as present
    from calendar.calendar_members cm
    where cm.business_id=c.business_id and cm.calendar_id=c.id
  ) members
  where g.slug=p_agency_slug and b.slug=p_business_slug and c.booking_slug=p_calendar_slug
    and p_agency_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    and p_business_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    and p_calendar_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    and b.status='active' and c.is_active and c.kind in ('personal','round_robin')
    and case when c.kind='personal'
      then members.stored=1 and members.present=1
      else members.stored between 1 and 100 and members.present>=1 end
$$;
revoke execute on function private.resolve_calendar(text,text,text) from public;
grant execute on function private.resolve_calendar(text,text,text) to crm_app;

-- H3: maxPerSlot now applies (booking.ts). Empty means one booking for each free host, as a
-- round-robin calendar has always taken; 1 was only the default of a setting nothing read,
-- so it becomes empty and no calendar changes how it books. A number caps a start time.
alter table calendar.calendars
  alter column max_per_slot drop not null,
  alter column max_per_slot drop default;
update calendar.calendars set max_per_slot = null where max_per_slot = 1;

-- H3: settings the booking page never applied and that have no clear meaning yet are gone
-- rather than shown and ignored: guests, the form and its order, sticky contacts and
-- recurring meetings. Each returns with its own migration when it is built.
alter table calendar.calendars
  drop column allow_guests,
  drop column form_first,
  drop column sticky_contacts,
  drop column is_recurring,
  drop column form_id;
