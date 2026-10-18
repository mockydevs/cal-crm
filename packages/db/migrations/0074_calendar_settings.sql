-- Settings → Calendars as GoHighLevel's (tasks/calendar-settings-design.md): groups of
-- calendars, and everything the "New calendar" form and its editor hold beyond what a
-- calendar kept before. A type whose booking is not built can be stored and edited; whether
-- it can be booked stays the server's answer (ADR-044), and private.resolve_calendar is
-- unchanged, so the public page offers personal and round robin only.

create table calendar.calendar_groups (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  name text not null constraint calendar_groups_name_length check (length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id)
);
create unique index calendar_groups_name_unique
  on calendar.calendar_groups (business_id, lower(btrim(name)));
call util.add_updated_at_trigger('calendar.calendar_groups');
call util.enable_tenant_rls('calendar.calendar_groups');
grant select, insert, update, delete on calendar.calendar_groups to crm_app;

alter table calendar.calendars
  drop constraint calendars_kind_valid,
  add constraint calendars_kind_valid
    check (kind in ('personal', 'round_robin', 'collective', 'class', 'service', 'event')),
  -- Basic details.
  add column group_id uuid,
  add column logo_file_id uuid,
  -- What an appointment booked here is called; merge fields are filled in at booking.
  add column invite_title text not null default '{{contact.name}}'
    constraint calendars_invite_title_length check (length(btrim(invite_title)) between 1 and 200),
  -- Booking rules. A slot starts every interval; without one, every duration.
  add column slot_interval_minutes integer
    constraint calendars_interval_range check (slot_interval_minutes between 5 and 480),
  add column extra_duration_minutes integer[] not null default '{}'
    constraint calendars_extra_durations_bounded check (
      cardinality(extra_duration_minutes) <= 5
      and 5 <= all (extra_duration_minutes) and 480 >= all (extra_duration_minutes)),
  add column max_per_day integer
    constraint calendars_max_per_day_range check (max_per_day between 1 and 1000),
  add column max_per_slot integer not null default 1
    constraint calendars_max_per_slot_range check (max_per_slot between 1 and 1000),
  -- The booking window counts only days the calendar is open.
  add column count_available_days_only boolean not null default false,
  -- The share of open slots kept back so the calendar looks busier than it is.
  add column look_busy_percent smallint not null default 0
    constraint calendars_look_busy_range check (look_busy_percent between 0 and 100),
  add column is_recurring boolean not null default false,
  -- Form and confirmation.
  add column form_id uuid,
  add column form_first boolean not null default false,
  add column sticky_contacts boolean not null default false,
  add column consent_enabled boolean not null default true,
  add column consent_text text not null default ''
    constraint calendars_consent_text_length check (length(consent_text) <= 1000),
  add column allow_guests boolean not null default false,
  -- Notifications and policies.
  add column assign_contact_to_member boolean not null default true,
  add column skip_assign_if_owned boolean not null default false,
  add column allow_reschedule boolean not null default true,
  add column reschedule_cutoff_minutes integer
    constraint calendars_reschedule_cutoff_range check (reschedule_cutoff_minutes between 0 and 525600),
  add column allow_cancel boolean not null default true,
  add column cancel_cutoff_minutes integer
    constraint calendars_cancel_cutoff_range check (cancel_cutoff_minutes between 0 and 525600),
  -- Widget appearance.
  add column cover_file_id uuid,
  add column widget_style text not null default 'neo'
    constraint calendars_widget_style_valid check (widget_style in ('neo', 'classic')),
  add column primary_color text not null default '#178af6'
    constraint calendars_primary_color_hex check (primary_color ~ '^#[0-9a-f]{6}([0-9a-f]{2})?$'),
  add column background_color text not null default '#ffffff'
    constraint calendars_background_color_hex check (background_color ~ '^#[0-9a-f]{6}([0-9a-f]{2})?$'),
  add column button_text text not null default ''
    constraint calendars_button_text_length check (length(button_text) <= 40),
  add constraint calendars_group_owner foreign key (business_id, group_id)
    references calendar.calendar_groups (business_id, id) on delete set null (group_id),
  add constraint calendars_logo_owner foreign key (business_id, logo_file_id)
    references files.files (business_id, id) on delete set null (logo_file_id),
  add constraint calendars_cover_owner foreign key (business_id, cover_file_id)
    references files.files (business_id, id) on delete set null (cover_file_id),
  add constraint calendars_form_owner foreign key (business_id, form_id)
    references forms.forms (business_id, id) on delete set null (form_id);
create index calendars_group_idx on calendar.calendars (business_id, group_id);
create index calendars_logo_idx on calendar.calendars (business_id, logo_file_id);
create index calendars_cover_idx on calendar.calendars (business_id, cover_file_id);
create index calendars_form_idx on calendar.calendars (business_id, form_id);

-- Where a member of the calendar meets: a list of { kind, value, label }, the first being
-- the one an appointment of theirs is given.
alter table calendar.calendar_members
  add column locations jsonb not null default '[]'
    constraint calendar_members_locations_array
      check (jsonb_typeof(locations) = 'array' and jsonb_array_length(locations) <= 5);
