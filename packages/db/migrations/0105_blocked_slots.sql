-- Blocked slots of their own (B11.04, ADR-105). A blocked slot was one absence inside a
-- team member's whole availability (0045), saved only with the rest of it. GoHighLevel
-- blocks "a Specific user or an entire calendar" with a start and an end, and the calendar
-- adds, edits and removes each one. So the absences become the blocked slots, in place:
-- still the one row slots and bookings keep out of (ADR-067), now with
--   * an id, so one can be changed or removed on its own;
--   * a title, which was the absence's reason (and stays private to calendar managers);
--   * a person, a calendar, or both: a person alone is blocked on every calendar of this
--     business, a calendar alone is closed for everyone on it, and both block the person
--     on that calendar only.
-- A blocked slot no longer belongs to a stored schedule: someone who follows the
-- calendars' hours can be away too, and resetting a schedule leaves their time off.
-- Existing absences keep their times and reasons as person-wide blocked slots.
alter table calendar.user_absences rename to blocked_slots;

alter table calendar.blocked_slots
  drop constraint user_absences_pkey,
  drop constraint user_absences_business_id_user_id_fkey;
alter table calendar.blocked_slots rename column reason to title;
alter table calendar.blocked_slots
  rename constraint user_absences_reason_length to blocked_slots_title_length;
alter table calendar.blocked_slots
  rename constraint user_absences_finite_ordered to blocked_slots_finite_ordered;
alter index calendar.user_absences_window_idx rename to blocked_slots_window_idx;

alter table calendar.blocked_slots
  add column id uuid not null default uuidv7(),
  add column calendar_id uuid,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  alter column user_id drop not null,
  add primary key (business_id, id),
  -- The schedule's key carried the business before; now the block carries it itself.
  add constraint blocked_slots_business_fkey
    foreign key (business_id) references tenancy.businesses (id) on delete cascade,
  add constraint blocked_slots_user_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  add constraint blocked_slots_calendar_fkey
    foreign key (business_id, calendar_id) references calendar.calendars (business_id, id)
    on delete cascade,
  add constraint blocked_slots_whom check (user_id is not null or calendar_id is not null);

-- A person's own list (their Time away) and the slots a booking reads for its members are
-- found by person and end; a calendar's own blocks by calendar and end. The person leads,
-- so the foreign key to auth.users has its index too.
create index blocked_slots_user_idx on calendar.blocked_slots (user_id, business_id, ends_at);
create index blocked_slots_calendar_idx on calendar.blocked_slots (business_id, calendar_id, ends_at)
  where calendar_id is not null;

call util.add_updated_at_trigger('calendar.blocked_slots');

comment on table calendar.blocked_slots is
  'Time nobody can book: a person on every calendar, a whole calendar, or a person on one calendar (ADR-105).';
comment on column calendar.blocked_slots.title is
  'What the calendar shows on the block. Private: answered only to calendar managers.';
