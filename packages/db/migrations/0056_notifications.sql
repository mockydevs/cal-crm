-- Notifications for the top bar's bell (B5.01, F13.03; ADR-065): what a team member is told
-- inside the app, and which kinds they chose to be told of.
--
-- A notification is one person's: who it is for, what kind it is, the thing it is about (a
-- typed reference the dashboard opens, never an address), who caused it, and whether it has
-- been read. It holds no message text and no contact's details: only a short title taken
-- from the thing itself (a task's title, a form's name), and for the automation step
-- `team.notify` the words the automation's author wrote.
--
-- One job turns an event into notifications (the trigger at the end queues it, as 0036
-- queues automation matching). Nothing else writes them: row-level security lets only the
-- worker insert, and only the person read and mark their own.

create schema notifications;
grant usage on schema notifications to crm_app;

create table notifications.notifications (
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  business_id uuid,  -- NULL: about the agency as a whole
  id uuid primary key default uuidv7(),
  -- Who it is for. Users are never deleted (DATABASE.md section 2); the key is for lookups.
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null constraint notifications_kind_valid check (kind in (
    'conversation.assigned', 'message.received', 'message.received_other', 'task.assigned',
    'task.due', 'appointment.booked', 'appointment.rescheduled', 'appointment.cancelled',
    'form.submitted', 'ai.limit_reached', 'automation.notice'
  )),
  -- What produced it, exactly once per person: an event's id, a task's due time, or the
  -- visit to an automation step. A job that runs again finds the key taken.
  source_key text not null
    constraint notifications_source_key_length check (length(source_key) between 1 and 200),
  -- What would otherwise repeat while nobody looks: a conversation's next messages, a
  -- form's next submissions. One unread notification per person and key at a time.
  collapse_key text
    constraint notifications_collapse_key_length check (length(collapse_key) between 1 and 200),
  -- The event behind it, for "Why?". Not a foreign key: nothing references an event (0004).
  event_id uuid,
  -- Who caused it, as events record actors.
  actor_kind text not null constraint notifications_actor_kind_valid
    check (actor_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  actor_id uuid,
  -- What the dashboard opens. The id is NULL only for the business's AI settings.
  subject_kind text not null constraint notifications_subject_kind_valid
    check (subject_kind in ('conversation', 'task', 'form', 'appointment', 'ai_settings', 'automation')),
  subject_id uuid,
  -- The contact, company or deal it is about, when there is one. Purging the record
  -- removes the notification with it.
  record_id uuid,
  -- The subject's own name when the notification was made: a task's title, a form's or an
  -- appointment's or an automation's name. Never a contact's name, which is read live.
  title text constraint notifications_title_length check (length(title) between 1 and 300),
  -- Only for automation.notice: the step's message, with its merge fields filled in.
  body text constraint notifications_body_length check (length(body) between 1 and 1000),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  -- When the cleanup removes it: 90 days after it was made, or 30 days after it was read,
  -- whichever comes first (notification_read below).
  expires_at timestamptz not null default now() + interval '90 days',
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id) on delete cascade,
  foreign key (business_id, record_id) references crm.records (business_id, id) on delete cascade,
  constraint notifications_once unique (user_id, source_key),
  constraint notifications_record_in_business check (record_id is null or business_id is not null),
  constraint notifications_subject_named
    check ((subject_id is null) = (subject_kind = 'ai_settings')),
  constraint notifications_body_only_notice check (body is null or kind = 'automation.notice')
);

comment on table notifications.notifications is
  'What one team member is told inside the app. Written only by the worker; read and marked read only by that person, while they belong to the business.';

-- The bell's list: one person's notifications in a business, newest first.
create index notifications_list_idx
  on notifications.notifications (user_id, business_id, id desc);
-- The bell's number: only what is unread, so reading it never walks what was read.
create index notifications_unread_idx
  on notifications.notifications (user_id, business_id, id desc) where read_at is null;
create unique index notifications_one_unread_per_key_idx
  on notifications.notifications (user_id, collapse_key)
  where read_at is null and collapse_key is not null;
create index notifications_business_idx on notifications.notifications (agency_id, business_id);
create index notifications_record_idx on notifications.notifications (business_id, record_id);
create index notifications_expiry_idx on notifications.notifications (expires_at);

call util.enable_scoped_rls('notifications.notifications');

-- scoped_isolation keeps agencies and businesses apart; these narrow it to the person.
-- "The person" is a signed-in person acting themselves (as for saved views, 0028), who
-- still belongs where the notification is: to its business, or to the agency's staff.
-- Losing the membership hides the notification at once, and gaining it back shows it again.
-- The worker (the system) reads them to keep one per source and one unread per key.
--
-- Whether the person acts themselves, and where they belong, are each asked once per
-- statement, not once per row: whether they are on the agency's staff, and the businesses
-- they are a member of. A notification about the agency as a whole (no business) is then
-- only for staff, since NULL equals no business. Asked as single yes-or-no questions, they
-- also leave the planner a fair guess of how many rows pass, so a list reads its index.
create policy own_or_worker on notifications.notifications
  as restrictive
  for select
  using (
    (select app.actor_kind()) = 'system'
    or (user_id = (select app.user_id())
        and (select app.actor_kind() = 'user' and app.actor_id() = app.user_id())
        and ((select exists (
                select 1 from tenancy.memberships m
                where m.user_id = app.user_id() and m.agency_id = app.agency_id()
                  and m.business_id is null))
             or business_id = any ((
                select array_agg(m.business_id) from tenancy.memberships m
                where m.user_id = app.user_id() and m.agency_id = app.agency_id()
                  and m.business_id is not null)::uuid[]))));

-- Marking read is the person's alone. A write that reads no column skips the select
-- policies, so this one states the same rule for itself.
create policy own_mark on notifications.notifications
  as restrictive
  for update
  using (
    user_id = (select app.user_id())
    and (select app.actor_kind() = 'user' and app.actor_id() = app.user_id())
    and ((select exists (
            select 1 from tenancy.memberships m
            where m.user_id = app.user_id() and m.agency_id = app.agency_id()
              and m.business_id is null))
         or business_id = any ((
            select array_agg(m.business_id) from tenancy.memberships m
            where m.user_id = app.user_id() and m.agency_id = app.agency_id()
              and m.business_id is not null)::uuid[])))
  with check (
    user_id = (select app.user_id())
    and (select app.actor_kind()) = 'user'
    and (select app.actor_id()) = (select app.user_id()));

-- Only the worker writes one, and only for someone who belongs there: no request can
-- plant a notification on a person.
create policy worker_writes on notifications.notifications
  as restrictive
  for insert
  with check (
    (select app.actor_kind()) = 'system'
    and exists (
      select 1 from tenancy.memberships m
      where m.user_id = notifications.user_id and m.agency_id = notifications.agency_id
        and (m.business_id is null or m.business_id = notifications.business_id)));

-- crm_app never deletes one (the cleanup below does) and changes nothing but read_at.
grant select, insert on notifications.notifications to crm_app;
grant update (read_at) on notifications.notifications to crm_app;

-- Read once: the first time stays, whatever a later write sends, and the notification is
-- then kept 30 more days at most.
create function private.notification_read() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.read_at is not null then
    new.read_at := old.read_at;
  elsif new.read_at is not null then
    new.expires_at := least(old.expires_at, new.read_at + interval '30 days');
  end if;
  return new;
end
$$;
revoke execute on function private.notification_read() from public;
create trigger notification_read
  before update of read_at on notifications.notifications
  for each row execute function private.notification_read();

-- A new notification, and one read in another tab, tell open dashboards to refetch, as a
-- stored message does (0046, ADR-025). The hint carries the business id and no row data;
-- PostgreSQL sends it only after commit and folds repeats in one transaction into one.
-- A notification about the agency as a whole has no business channel to tell.
create function private.notification_changed() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.business_id is not null then
    perform pg_notify('crm_business_changed', new.business_id::text);
  end if;
  return null;
end
$$;
revoke execute on function private.notification_changed() from public;
create trigger notification_changed
  after insert or update of read_at on notifications.notifications
  for each row execute function private.notification_changed();

-- Which kinds a person turned off, in a business. No row means the default: on.
create table notifications.preferences (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null constraint preferences_kind_valid check (kind in (
    'conversation.assigned', 'message.received', 'message.received_other', 'task.assigned',
    'task.due', 'appointment.booked', 'appointment.rescheduled', 'appointment.cancelled',
    'form.submitted', 'ai.limit_reached', 'automation.notice'
  )),
  in_app boolean not null,
  updated_at timestamptz not null default now(),
  primary key (business_id, user_id, kind)
);
create index preferences_user_idx on notifications.preferences (user_id);

call util.add_updated_at_trigger('notifications.preferences');
call util.enable_tenant_rls('notifications.preferences');

-- A person's preferences are theirs: nobody else reads or changes them, an administrator
-- included. The worker reads them to leave out what was turned off.
create policy own_or_worker on notifications.preferences
  as restrictive
  for select
  using (
    (select app.actor_kind()) = 'system'
    or (user_id = (select app.user_id())
        and (select app.actor_kind()) = 'user'
        and (select app.actor_id()) = (select app.user_id())));
create policy own_insert on notifications.preferences
  as restrictive
  for insert
  with check (
    user_id = (select app.user_id())
    and (select app.actor_kind()) = 'user'
    and (select app.actor_id()) = (select app.user_id()));
create policy own_update on notifications.preferences
  as restrictive
  for update
  using (
    user_id = (select app.user_id())
    and (select app.actor_kind()) = 'user'
    and (select app.actor_id()) = (select app.user_id()))
  with check (
    user_id = (select app.user_id())
    and (select app.actor_kind()) = 'user'
    and (select app.actor_id()) = (select app.user_id()));

grant select, insert on notifications.preferences to crm_app;
grant update (in_app) on notifications.preferences to crm_app;

-- Removes notifications past their time, in every business, a bounded number at a time.
-- It skips rows that are locked, so it never waits for someone marking theirs read.
create function private.expire_notifications(p_limit integer default 5000) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  with due as (
    select n.id from notifications.notifications n
    where n.expires_at <= now()
    order by n.expires_at
    limit least(greatest(p_limit, 1), 50000)
    for update skip locked
  )
  delete from notifications.notifications n using due where n.id = due.id;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;
revoke execute on function private.expire_notifications(integer) from public;
grant execute on function private.expire_notifications(integer) to crm_app;

-- The events the notifications job reads. One list: the trigger below queues a job for
-- exactly these, and the module's sources must name the same ones (its tests compare).
create function private.notification_event_types() returns text[]
language sql immutable parallel safe set search_path = ''
as $$
  select array[
    'conversation.assigned', 'message.received', 'task.created', 'task.updated',
    'form.submitted', 'appointment.booked', 'appointment.rescheduled',
    'appointment.cancelled', 'ai_settings.limit_reached'
  ]
$$;
revoke execute on function private.notification_event_types() from public;
grant execute on function private.notification_event_types() to crm_app;

-- An event queues the job that tells people of it (as 0036 queues automation matching):
-- whoever writes the event, the same transaction queues the job, so nothing is told of a
-- change that rolled back and nothing that happened is missed. One waiting job per event.
--
-- A task that is open, assigned and due later also gets one job at its due time, moved
-- when the task changes and removed when it is completed or deleted: Graphile Worker's
-- job_key in its default 'replace' mode (graphile-worker 0.18, sql/000020.sql). The job
-- reads the task again when it runs, so a job that outlived a change tells nobody.
create function private.queue_notifications() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_due timestamptz;
begin
  if new.type = any (private.notification_event_types()) then
    perform graphile_worker.add_job(
      'notifications.from_event',
      payload := jsonb_build_object(
        'agencyId', new.agency_id,
        'businessId', new.business_id,
        'correlationId', new.correlation_id,
        'causationId', new.id,
        'data', jsonb_build_object('eventId', new.id)
      )::json,
      max_attempts := 10,
      job_key := 'notify:' || new.id::text,
      job_key_mode := 'preserve_run_at'
    );
  end if;
  if new.subject_kind = 'task' and new.business_id is not null
     and new.type in ('task.created', 'task.updated', 'task.completed', 'task.reopened', 'task.deleted') then
    select t.due_at into v_due
      from crm.tasks t
      where t.business_id = new.business_id and t.id = new.subject_id
        and t.completed_at is null and t.assignee_user_id is not null and t.due_at > now();
    if v_due is null then
      perform graphile_worker.remove_job('notify-task-due:' || new.subject_id::text);
    else
      perform graphile_worker.add_job(
        'notifications.task_due',
        payload := jsonb_build_object(
          'agencyId', new.agency_id,
          'businessId', new.business_id,
          'correlationId', new.correlation_id,
          'causationId', new.id,
          'data', jsonb_build_object('taskId', new.subject_id)
        )::json,
        run_at := v_due,
        max_attempts := 10,
        job_key := 'notify-task-due:' || new.subject_id::text
      );
    end if;
  end if;
  return null;
end
$$;
revoke execute on function private.queue_notifications() from public;

create trigger events_queue_notifications
  after insert on events.events
  for each row execute function private.queue_notifications();

-- Tasks that were already open, assigned and due later when this migration ran get their
-- job too. On a new install there are none, and the queue is installed after these files
-- (0013), so there is nothing to do and nothing to call.
do $$
declare
  v_task record;
begin
  if to_regprocedure('graphile_worker.remove_job(text)') is null then
    return;
  end if;
  for v_task in
    select b.agency_id, t.business_id, t.id, t.due_at
    from crm.tasks t
    join tenancy.businesses b on b.id = t.business_id
    where t.completed_at is null and t.assignee_user_id is not null and t.due_at > now()
  loop
    perform graphile_worker.add_job(
      'notifications.task_due',
      payload := jsonb_build_object(
        'agencyId', v_task.agency_id,
        'businessId', v_task.business_id,
        'correlationId', uuidv7(),
        'causationId', null,
        'data', jsonb_build_object('taskId', v_task.id)
      )::json,
      run_at := v_task.due_at,
      max_attempts := 10,
      job_key := 'notify-task-due:' || v_task.id::text
    );
  end loop;
end $$;
