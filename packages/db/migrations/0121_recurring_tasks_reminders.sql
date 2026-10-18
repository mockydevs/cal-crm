-- Recurring tasks, reminders before a task is due, and the Task Reminder workflow trigger.
--
-- A recurring task is a series: the task's title, description, record and assignee, and a
-- rule. Each occurrence is an ordinary task of crm.tasks, made at its scheduled time (not
-- when the one before it is completed), due a fixed while after it is made. The worker makes
-- them: one waiting job per series, at the time the next one is due to be made, moved
-- whenever that time changes and removed when the series ends.
--
-- Deployed while the app runs: every constraint added to a table that already has rows is
-- NOT VALID, so it is checked for each row written from now on without a scan of the table
-- under its lock (every existing row meets it: the new columns are empty, and the kind lists
-- only grow). crm_owner's lock_timeout (5 s, set at install) bounds how long a statement
-- waits for its lock. The two indexes on crm.tasks are built in the migration's transaction
-- (CONCURRENTLY cannot run in one); a business's tasks number in the hundreds, so the build
-- holds writes to the table for moments.

create table crm.task_series (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  record_id uuid,
  title text not null constraint task_series_title_length check (length(btrim(title)) between 1 and 300),
  body_text text not null default ''
    constraint task_series_body_length check (length(body_text) <= 10000),
  assignee_user_id uuid references auth.users (id),
  -- Hourly moves the instant; the others move the date on the wall clock of time_zone, so a
  -- task due at 09:00 stays due at 09:00 across a clock change.
  frequency text not null constraint task_series_frequency_valid
    check (frequency in ('hourly', 'daily', 'weekly', 'monthly', 'yearly')),
  every integer not null constraint task_series_every_range check (every between 1 and 999),
  -- Occurrence n is due anchor_due_at moved (n - anchor_occurrence) times every frequency.
  -- Editing the series from an occurrence moves the anchor to it.
  anchor_due_at timestamptz not null,
  anchor_occurrence integer not null default 0
    constraint task_series_anchor_occurrence_range check (anchor_occurrence >= 0),
  time_zone text not null constraint task_series_time_zone_length check (length(time_zone) between 1 and 64),
  -- How long before its due time each occurrence is made.
  lead_seconds integer not null constraint task_series_lead_range check (lead_seconds between 0 and 315360000),
  -- The last day an occurrence may be due on, in time_zone; or the most tasks the series
  -- makes; or neither, for a series that never ends.
  ends_on date,
  max_occurrences integer constraint task_series_max_occurrences_range check (max_occurrences between 1 and 1000),
  constraint task_series_one_end check (ends_on is null or max_occurrences is null),
  -- Off: an occurrence is not made while the one before it is still open and overdue.
  create_if_overdue boolean not null default false,
  -- The next occurrence to make, when, and how many tasks the series has made.
  next_occurrence integer not null default 1 constraint task_series_next_occurrence_range check (next_occurrence >= 1),
  next_run_at timestamptz,
  created_count integer not null default 1 constraint task_series_created_count_range check (created_count >= 0),
  ended_at timestamptz,
  constraint task_series_running_or_ended check ((next_run_at is null) = (ended_at is not null)),
  created_by_kind text not null constraint task_series_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, record_id) references crm.records (business_id, id) on delete cascade
);
create index task_series_record_idx on crm.task_series (business_id, record_id);
create index task_series_assignee_idx on crm.task_series (assignee_user_id);

call util.add_updated_at_trigger('crm.task_series');
call util.enable_tenant_rls('crm.task_series');
-- A series is ended, never deleted: its tasks keep pointing at it.
grant select, insert, update on crm.task_series to crm_app;

-- Which series a task is an occurrence of, and which one. One task per occurrence, so a
-- job that runs twice makes it once.
alter table crm.tasks
  add column series_id uuid,
  add column occurrence integer,
  add constraint tasks_occurrence_range check (occurrence >= 0) not valid,
  add constraint tasks_series_occurrence_together
    check ((series_id is null) = (occurrence is null)) not valid,
  add constraint tasks_series_fk foreign key (business_id, series_id)
    references crm.task_series (business_id, id) not valid;
create unique index tasks_series_occurrence_idx
  on crm.tasks (business_id, series_id, occurrence) where series_id is not null;

-- The series' job, kept in step with next_run_at by whatever writes the row.
create function private.queue_task_series() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- A new install creates its queue after these files run, so there is no job to keep yet.
  if to_regprocedure('graphile_worker.remove_job(text)') is null then
    return null;
  end if;
  if new.next_run_at is null then
    perform graphile_worker.remove_job('task-series:' || new.id::text);
  else
    perform graphile_worker.add_job(
      'tasks.create_occurrence',
      payload := jsonb_build_object(
        'agencyId', (select b.agency_id from tenancy.businesses b where b.id = new.business_id),
        'businessId', new.business_id,
        'correlationId', coalesce(app.correlation_id(), uuidv7()),
        'causationId', null,
        'data', jsonb_build_object('seriesId', new.id)
      )::json,
      run_at := new.next_run_at,
      max_attempts := 10,
      job_key := 'task-series:' || new.id::text,
      job_key_mode := 'replace'
    );
  end if;
  return null;
end
$$;
revoke execute on function private.queue_task_series() from public;
create trigger task_series_queue
  after insert or update of next_run_at on crm.task_series
  for each row execute function private.queue_task_series();

-- Reminders before a task is due ------------------------------------------------------------
--
-- Each person chooses, in their notification preferences, how long before a task assigned to
-- them is due they are reminded. No row, or no time, means no reminder; the notice at the
-- due time (task.due) is separate and stays as it was.

alter table notifications.notifications
  drop constraint notifications_kind_valid,
  add constraint notifications_kind_valid check (kind in (
    'conversation.assigned', 'message.received', 'message.received_other',
    'message.received_following', 'task.assigned', 'task.reminder', 'task.due',
    'appointment.booked', 'appointment.rescheduled', 'appointment.cancelled', 'form.submitted',
    'ai.limit_reached', 'automation.notice', 'calendar.google_disconnected'
  )) not valid;

alter table notifications.preferences
  drop constraint preferences_kind_valid,
  add constraint preferences_kind_valid check (kind in (
    'conversation.assigned', 'message.received', 'message.received_other',
    'message.received_following', 'task.assigned', 'task.reminder', 'task.due',
    'appointment.booked', 'appointment.rescheduled', 'appointment.cancelled', 'form.submitted',
    'ai.limit_reached', 'automation.notice', 'calendar.google_disconnected'
  )) not valid;

-- Minutes before the due time, up to 30 days; only the task.reminder row holds one.
alter table notifications.preferences
  add column remind_minutes integer,
  add constraint preferences_remind_minutes_range
    check (remind_minutes between 1 and 43200) not valid,
  add constraint preferences_remind_only_reminders
    check (remind_minutes is null or kind = 'task.reminder') not valid;
grant update (remind_minutes) on notifications.preferences to crm_app;

-- One waiting reminder job per task, at its assignee's chosen time before it is due (now,
-- when that has passed and the task is not due yet). Moved when the due time, the assignee
-- or the completion changes; removed when nothing is to be told. The job reads everything
-- again when it runs, so a job that outlived a change tells nobody.
create function private.queue_task_reminder(
  p_agency_id uuid, p_business_id uuid, p_task_id uuid, p_due_at timestamptz, p_minutes integer
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  -- A new install creates its queue after these files run, so there is no job to keep yet.
  if to_regprocedure('graphile_worker.remove_job(text)') is null then
    return;
  end if;
  if p_due_at is null or p_minutes is null or p_due_at <= now() then
    perform graphile_worker.remove_job('notify-task-reminder:' || p_task_id::text);
  else
    perform graphile_worker.add_job(
      'notifications.task_reminder',
      payload := jsonb_build_object(
        'agencyId', p_agency_id,
        'businessId', p_business_id,
        'correlationId', coalesce(app.correlation_id(), uuidv7()),
        'causationId', null,
        'data', jsonb_build_object('taskId', p_task_id)
      )::json,
      run_at := greatest(p_due_at - make_interval(mins => p_minutes), now()),
      max_attempts := 10,
      job_key := 'notify-task-reminder:' || p_task_id::text,
      job_key_mode := 'replace'
    );
  end if;
end
$$;
revoke execute on function private.queue_task_reminder(uuid, uuid, uuid, timestamptz, integer) from public;

create function private.task_reminder_changed() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_minutes integer;
begin
  -- A new install creates its queue after these files run, so there is no job to keep yet.
  if to_regprocedure('graphile_worker.remove_job(text)') is null then
    return null;
  end if;
  if tg_op = 'DELETE' then
    perform graphile_worker.remove_job('notify-task-reminder:' || old.id::text);
    return null;
  end if;
  if new.completed_at is null and new.assignee_user_id is not null then
    select p.remind_minutes into v_minutes
    from notifications.preferences p
    where p.business_id = new.business_id and p.user_id = new.assignee_user_id
      and p.kind = 'task.reminder' and p.in_app;
  end if;
  perform private.queue_task_reminder(
    (select b.agency_id from tenancy.businesses b where b.id = new.business_id),
    new.business_id, new.id, new.due_at, v_minutes);
  return null;
end
$$;
revoke execute on function private.task_reminder_changed() from public;
create trigger tasks_queue_reminder
  after insert or delete or update of due_at, assignee_user_id, completed_at on crm.tasks
  for each row execute function private.task_reminder_changed();

-- A change of someone's reminder time, or of the switch, moves the reminders of their open
-- tasks due later. A save that changes neither moves nothing.
create function private.task_reminders_rescheduled() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_task record;
  v_agency_id uuid := (select b.agency_id from tenancy.businesses b where b.id = new.business_id);
begin
  for v_task in
    select t.id, t.due_at from crm.tasks t
    where t.assignee_user_id = new.user_id and t.business_id = new.business_id
      and t.completed_at is null and t.due_at > now()
  loop
    perform private.queue_task_reminder(
      v_agency_id, new.business_id, v_task.id, v_task.due_at,
      case when new.in_app then new.remind_minutes end);
  end loop;
  return null;
end
$$;
revoke execute on function private.task_reminders_rescheduled() from public;
create trigger preferences_task_reminders_chosen
  after insert on notifications.preferences
  for each row when (new.kind = 'task.reminder')
  execute function private.task_reminders_rescheduled();
create trigger preferences_task_reminders_changed
  after update of in_app, remind_minutes on notifications.preferences
  for each row when (new.kind = 'task.reminder'
    and (old.in_app is distinct from new.in_app
      or old.remind_minutes is distinct from new.remind_minutes))
  execute function private.task_reminders_rescheduled();

-- The Task Reminder workflow trigger ---------------------------------------------------------
--
-- Like a date trigger it hears no event: the worker's minute sweep asks which tasks' due
-- times, moved by the trigger's days, came round since it last looked. Its cursors and
-- firings are the date triggers' tables (0072); a firing's record_id is then the task's id,
-- and its occurrence the date the reminder fell on.

create index trigger_subscriptions_task_reminder_idx
  on automation.trigger_subscriptions (automation_id)
  where event_type = 'task.reminder';

-- Automations whose published version has a Task Reminder trigger, as
-- private.automations_with_timers lists those with a date trigger.
create function private.automations_with_task_reminders(p_after uuid, p_limit integer)
returns table (agency_id uuid, business_id uuid, automation_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, a.business_id, a.id
  from automation.automations a
  join tenancy.businesses b on b.id = a.business_id
  where a.status in ('active', 'paused') and b.status = 'active'
    and (p_after is null or a.id > p_after)
    and exists (
      select 1 from automation.trigger_subscriptions s
      where s.automation_id = a.id and s.business_id = a.business_id
        and s.version_id = a.published_version_id and s.event_type = 'task.reminder'
    )
  order by a.id
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function private.automations_with_task_reminders(uuid, integer) from public;
grant execute on function private.automations_with_task_reminders(uuid, integer) to crm_app;

-- The sweep finds tasks by due time.
create index tasks_due_idx on crm.tasks (business_id, due_at) where due_at is not null;
