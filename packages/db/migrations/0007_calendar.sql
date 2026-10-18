-- Calendars, availability and appointments.

create schema calendar;

create table calendar.calendars (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  name text not null constraint calendars_name_length check (length(btrim(name)) between 1 and 120),
  description text not null default '',
  kind text not null constraint calendars_kind_valid check (kind in ('personal', 'round_robin', 'collective')),
  timezone text not null,
  slot_minutes integer not null default 30 constraint calendars_slot_range check (slot_minutes between 5 and 480),
  buffer_before_minutes integer not null default 0 constraint calendars_buffer_before_range check (buffer_before_minutes between 0 and 240),
  buffer_after_minutes integer not null default 0 constraint calendars_buffer_after_range check (buffer_after_minutes between 0 and 240),
  min_notice_minutes integer not null default 60 constraint calendars_min_notice_nonnegative check (min_notice_minutes >= 0),
  max_days_ahead integer not null default 60 constraint calendars_max_days_range check (max_days_ahead between 1 and 730),
  booking_slug text not null constraint calendars_booking_slug_format check (booking_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint calendars_booking_slug_unique unique (business_id, booking_slug)
);

create table calendar.calendar_members (
  business_id uuid not null,
  calendar_id uuid not null,
  user_id uuid not null references auth.users (id),
  -- Share of round-robin bookings relative to other members.
  weight smallint not null default 1 constraint calendar_members_weight_range check (weight between 1 and 100),
  primary key (business_id, calendar_id, user_id),
  foreign key (business_id, calendar_id) references calendar.calendars (business_id, id) on delete cascade
);
create index calendar_members_user_idx on calendar.calendar_members (user_id, business_id);

-- Weekly opening hours, in the calendar's time zone. weekday: 0 = Sunday … 6 = Saturday.
create table calendar.weekly_hours (
  business_id uuid not null,
  calendar_id uuid not null,
  weekday smallint not null constraint weekly_hours_weekday_range check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  primary key (business_id, calendar_id, weekday, start_time),
  foreign key (business_id, calendar_id) references calendar.calendars (business_id, id) on delete cascade,
  constraint weekly_hours_end_after_start check (end_time > start_time)
);

-- Exceptions for one date: different hours, or closed all day (no times).
create table calendar.date_overrides (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  calendar_id uuid not null,
  on_date date not null,
  start_time time,
  end_time time,
  primary key (business_id, id),
  foreign key (business_id, calendar_id) references calendar.calendars (business_id, id) on delete cascade,
  constraint date_overrides_times_together check ((start_time is null) = (end_time is null)),
  constraint date_overrides_end_after_start check (start_time is null or end_time > start_time)
);
create index date_overrides_calendar_idx on calendar.date_overrides (business_id, calendar_id, on_date);

create table calendar.appointments (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  calendar_id uuid not null,
  contact_id uuid not null,
  assigned_user_id uuid references auth.users (id),
  title text not null constraint appointments_title_length check (length(btrim(title)) between 1 and 200),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'booked' constraint appointments_status_valid
    check (status in ('booked', 'confirmed', 'cancelled', 'no_show', 'completed')),
  location text,
  notes text not null default '',
  source text not null constraint appointments_source_valid
    check (source in ('booking_page', 'user', 'ai_agent', 'automation', 'api', 'import')),
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, calendar_id) references calendar.calendars (business_id, id),
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade,
  constraint appointments_end_after_start check (ends_at > starts_at),
  constraint appointments_cancellation_complete check ((status = 'cancelled') = (cancelled_at is not null)),
  -- Nobody can be booked twice at the same time, however the booking arrives.
  constraint appointments_no_double_booking exclude using gist (
    business_id with =,
    assigned_user_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('booked', 'confirmed') and assigned_user_id is not null)
);
create index appointments_calendar_idx on calendar.appointments (business_id, calendar_id, starts_at);
create index appointments_contact_idx on calendar.appointments (business_id, contact_id, starts_at desc);
create index appointments_assignee_idx on calendar.appointments (assigned_user_id, business_id, starts_at);

call util.add_updated_at_trigger('calendar.calendars');
call util.add_updated_at_trigger('calendar.appointments');

call util.enable_tenant_rls('calendar.calendars');
call util.enable_tenant_rls('calendar.calendar_members');
call util.enable_tenant_rls('calendar.weekly_hours');
call util.enable_tenant_rls('calendar.date_overrides');
call util.enable_tenant_rls('calendar.appointments');
