-- Business-scoped user hours. Unset profiles inherit calendar availability.
create table calendar.user_schedules (
  business_id uuid not null references tenancy.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  timezone text not null,
  inherit_calendar_hours boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id,user_id)
);
create index user_schedules_user_idx on calendar.user_schedules(user_id,business_id);

create function util.validate_user_schedule_timezone()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if left(new.timezone,1) in ('+','-') or not exists (
    select 1 from pg_catalog.pg_timezone_names as z
    where lower(z.name) = lower(new.timezone)
  ) then
    raise check_violation using constraint = 'user_schedules_timezone_valid',
      message = 'Choose a recognized timezone name.';
  end if;
  return new;
end;
$$;
create trigger validate_user_schedule_timezone before insert or update
on calendar.user_schedules for each row execute function util.validate_user_schedule_timezone();

create table calendar.user_weekly_hours (
  business_id uuid not null,
  user_id uuid not null,
  weekday smallint not null constraint user_weekly_hours_weekday_range check (weekday between 0 and 6),
  start_minute smallint not null constraint user_weekly_hours_start_range check (start_minute between 0 and 1439),
  end_minute smallint not null constraint user_weekly_hours_end_range check (end_minute between 1 and 1440),
  primary key (business_id,user_id,weekday,start_minute),
  foreign key (business_id,user_id) references calendar.user_schedules(business_id,user_id) on delete cascade,
  constraint user_weekly_hours_ordered check (end_minute > start_minute),
  constraint user_weekly_hours_no_overlap exclude using gist (
    business_id with =, user_id with =, weekday with =,
    int4range(start_minute::integer,end_minute::integer,'[)') with &&
  )
);

create table calendar.user_date_overrides (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  user_id uuid not null,
  on_date date not null constraint user_date_overrides_finite_date
    check (isfinite(on_date) and on_date >= date '0001-01-01'),
  start_minute smallint,
  end_minute smallint,
  primary key (business_id,id),
  foreign key (business_id,user_id) references calendar.user_schedules(business_id,user_id) on delete cascade,
  constraint user_date_overrides_paired check ((start_minute is null) = (end_minute is null)),
  constraint user_date_overrides_range check (start_minute is null or
    (start_minute between 0 and 1439 and end_minute between 1 and 1440 and end_minute > start_minute)),
  constraint user_date_overrides_no_overlap exclude using gist (
    business_id with =, user_id with =, on_date with =,
    int4range(coalesce(start_minute,0)::integer,coalesce(end_minute,1440)::integer,'[)') with &&
  )
);
create index user_date_overrides_user_idx on calendar.user_date_overrides(business_id,user_id,on_date);

create table calendar.user_absences (
  business_id uuid not null,
  user_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null default '' constraint user_absences_reason_length check (length(reason) <= 1000),
  primary key (business_id,user_id,starts_at),
  foreign key (business_id,user_id) references calendar.user_schedules(business_id,user_id) on delete cascade,
  constraint user_absences_finite_ordered check (isfinite(starts_at) and isfinite(ends_at) and ends_at > starts_at)
);

call util.add_updated_at_trigger('calendar.user_schedules');
call util.enable_tenant_rls('calendar.user_schedules');
call util.enable_tenant_rls('calendar.user_weekly_hours');
call util.enable_tenant_rls('calendar.user_date_overrides');
call util.enable_tenant_rls('calendar.user_absences');
grant select,insert,update,delete on calendar.user_schedules,calendar.user_weekly_hours,
  calendar.user_date_overrides,calendar.user_absences to crm_app;
