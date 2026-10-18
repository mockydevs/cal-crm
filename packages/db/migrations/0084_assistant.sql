-- The in-app assistant (ADR-084): a person's conversations with it, the turns a worker runs
-- and the messages each turn writes; and what ai.proposals needs to be about a form.
--
-- A message a person sends is a turn. The worker runs it: it asks the model, runs the tools
-- the model asks for as the API's own operations, held to that person's permissions, and
-- writes one message for each step. Nothing is streamed: an open panel is told that the
-- business changed (ADR-025) and reads what is new after a cursor.
--
-- A thread is its person's alone. tenant_isolation keeps businesses apart; a restrictive
-- policy on each table narrows it to the person the thread belongs to, acting themselves
-- (actor kind user, and the actor is the user), as for saved views (0028) and notifications
-- (0056). The worker (the system) reads and writes them to run a turn. Nothing else does:
-- not a colleague, not agency staff, not an API key, and not an assistant carrying the
-- person's id, so no tool the assistant runs can read a conversation.

create table ai.assistant_threads (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  -- Whose it is. Users are never deleted (DATABASE.md section 2); the key is for lookups.
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The first message, cut short: what the list of conversations shows.
  title text not null constraint assistant_threads_title_length check (length(title) between 1 and 120),
  -- The seq of the newest message. A message takes the next one under this row's lock, so
  -- the messages of a thread are numbered 1, 2, 3 in the order they were written.
  message_seq integer not null default 0 constraint assistant_threads_seq_nonnegative check (message_seq >= 0),
  created_at timestamptz not null default now(),
  -- To the millisecond, as the application's clock gives it: the list is paged by it.
  last_activity_at timestamptz not null default date_trunc('milliseconds', now()),
  -- When the cleanup removes it: so many days after it was last used (ADR-084).
  expires_at timestamptz not null default now() + interval '30 days',
  primary key (business_id, id)
);
comment on table ai.assistant_threads is
  'A person''s conversation with the in-app assistant. Read and written only by that person, acting themselves, and by the worker that runs its turns.';

-- A person's conversations in a business, newest activity first.
create index assistant_threads_list_idx
  on ai.assistant_threads (business_id, user_id, last_activity_at desc, id desc);
create index assistant_threads_user_idx on ai.assistant_threads (user_id);
create index assistant_threads_expiry_idx on ai.assistant_threads (expires_at);

create table ai.assistant_turns (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  thread_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'queued' constraint assistant_turns_status_valid
    check (status in ('queued', 'running', 'finished')),
  -- answered: the assistant said what it meant to. The rest are the reasons it stopped.
  outcome text constraint assistant_turns_outcome_valid check (outcome in (
    'answered', 'cancelled', 'step_limit', 'time_limit', 'paused', 'ai_off', 'not_configured',
    'refused', 'failed', 'no_access', 'interrupted'
  )),
  -- The category behind the outcome, such as the provider's failure or which limit paused it.
  reason text constraint assistant_turns_reason_format check (reason ~ '^[a-z][a-z_]{0,63}$'),
  -- The page the message was sent from: its route, the record it is about and what was
  -- selected, as ids. Never the page's text.
  page jsonb not null constraint assistant_turns_page_object check (jsonb_typeof(page) = 'object'),
  -- Asked to stop. A running turn reads this before each step.
  cancel_requested_at timestamptz,
  -- Model calls made, and what those with a known cost came to, in US dollars.
  steps integer not null default 0 constraint assistant_turns_steps_nonnegative check (steps >= 0),
  cost_estimate numeric(19, 6) constraint assistant_turns_cost_nonnegative check (cost_estimate >= 0),
  -- The request that asked: every command a tool runs in this turn is audited under it.
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  primary key (business_id, id),
  foreign key (business_id, thread_id) references ai.assistant_threads (business_id, id) on delete cascade,
  constraint assistant_turns_finished_together
    check ((status = 'finished') = (finished_at is not null) and (status = 'finished') = (outcome is not null)),
  constraint assistant_turns_started_before_finished check (status <> 'running' or started_at is not null)
);
comment on table ai.assistant_turns is
  'One message a person sent the in-app assistant, and how the worker''s run of it ended.';

create index assistant_turns_thread_idx on ai.assistant_turns (business_id, thread_id, id desc);
create index assistant_turns_user_idx on ai.assistant_turns (user_id);
-- How many turns a person started lately: the hourly limit reads it.
create index assistant_turns_rate_idx on ai.assistant_turns (business_id, user_id, created_at desc);
-- One turn of a thread at a time: a second message waits for the first to finish.
create unique index assistant_turns_one_open_idx
  on ai.assistant_turns (business_id, thread_id) where status <> 'finished';

create table ai.assistant_messages (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  thread_id uuid not null,
  turn_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  seq integer not null constraint assistant_messages_seq_positive check (seq >= 1),
  -- user: what the person wrote. assistant: what the model wrote. activity: a tool the
  -- server ran, in a sentence the server wrote. proposal: something waiting for the person.
  -- error: why something did not happen.
  kind text not null constraint assistant_messages_kind_valid
    check (kind in ('user', 'assistant', 'activity', 'proposal', 'error')),
  text text not null constraint assistant_messages_text_length check (length(text) <= 20000),
  -- For an activity: the operation, what it does (read, draft or confirm), whether it ran,
  -- and what it made or read, to link to. Ids and names the server read, never a model's words.
  activity jsonb constraint assistant_messages_activity_object check (jsonb_typeof(activity) = 'object'),
  proposal_id uuid,
  -- For an error: its category.
  code text constraint assistant_messages_code_format check (code ~ '^[a-z][a-z_]{0,63}$'),
  -- The model call a message came from, when it came from one.
  request_id uuid,
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, thread_id) references ai.assistant_threads (business_id, id) on delete cascade,
  foreign key (business_id, turn_id) references ai.assistant_turns (business_id, id) on delete cascade,
  foreign key (business_id, proposal_id) references ai.proposals (business_id, id) on delete set null (proposal_id),
  foreign key (business_id, request_id) references ai.requests (business_id, id) on delete set null (request_id),
  constraint assistant_messages_seq_unique unique (business_id, thread_id, seq),
  constraint assistant_messages_activity_only check (activity is null or kind = 'activity'),
  constraint assistant_messages_proposal_only check (proposal_id is null or kind = 'proposal'),
  constraint assistant_messages_code_only check (code is null or kind = 'error')
);
comment on table ai.assistant_messages is
  'What was said and done in a conversation with the in-app assistant, one row a step, numbered within its thread.';

create index assistant_messages_turn_idx on ai.assistant_messages (business_id, turn_id);
create index assistant_messages_proposal_idx on ai.assistant_messages (business_id, proposal_id);
create index assistant_messages_request_idx on ai.assistant_messages (business_id, request_id);
create index assistant_messages_user_idx on ai.assistant_messages (user_id);

call util.enable_tenant_rls('ai.assistant_threads');
call util.enable_tenant_rls('ai.assistant_turns');
call util.enable_tenant_rls('ai.assistant_messages');

-- The person's own, or the worker's. Restrictive: a permissive policy would widen access
-- to everyone in the business. One policy for every command, with the same rule for what
-- is read and for what is written, so nobody can plant a thread or a message on a person.
create policy own_or_worker on ai.assistant_threads
  as restrictive
  for all
  using (
    (select app.actor_kind()) = 'system'
    or (user_id = (select app.user_id())
        and (select app.actor_kind()) = 'user'
        and (select app.actor_id()) = (select app.user_id())))
  with check (
    (select app.actor_kind()) = 'system'
    or (user_id = (select app.user_id())
        and (select app.actor_kind()) = 'user'
        and (select app.actor_id()) = (select app.user_id())));
create policy own_or_worker on ai.assistant_turns
  as restrictive
  for all
  using (
    (select app.actor_kind()) = 'system'
    or (user_id = (select app.user_id())
        and (select app.actor_kind()) = 'user'
        and (select app.actor_id()) = (select app.user_id())))
  with check (
    (select app.actor_kind()) = 'system'
    or (user_id = (select app.user_id())
        and (select app.actor_kind()) = 'user'
        and (select app.actor_id()) = (select app.user_id())));
create policy own_or_worker on ai.assistant_messages
  as restrictive
  for all
  using (
    (select app.actor_kind()) = 'system'
    or (user_id = (select app.user_id())
        and (select app.actor_kind()) = 'user'
        and (select app.actor_id()) = (select app.user_id())))
  with check (
    (select app.actor_kind()) = 'system'
    or (user_id = (select app.user_id())
        and (select app.actor_kind()) = 'user'
        and (select app.actor_id()) = (select app.user_id())));

-- A person deletes a thread of their own, and its turns and messages go with it. A turn is
-- updated as it runs; a message is written once and never changed.
grant select, insert, update, delete on ai.assistant_threads to crm_app;
grant select, insert, update on ai.assistant_turns to crm_app;
grant select, insert on ai.assistant_messages to crm_app;

-- A turn and its thread belong to one person, and a message to its turn's thread: the keys
-- above hold the business, these hold the person and the thread.
create function private.assistant_turn_owner() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not exists (
    select 1 from ai.assistant_threads t
    where t.business_id = new.business_id and t.id = new.thread_id and t.user_id = new.user_id
  ) then
    raise exception 'a turn belongs to its thread''s person'
      using errcode = 'check_violation', constraint = 'assistant_turns_owner';
  end if;
  return new;
end
$$;
revoke execute on function private.assistant_turn_owner() from public;
create trigger assistant_turns_owner
  before insert on ai.assistant_turns
  for each row execute function private.assistant_turn_owner();

create function private.assistant_message_owner() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not exists (
    select 1 from ai.assistant_turns t
    where t.business_id = new.business_id and t.id = new.turn_id
      and t.thread_id = new.thread_id and t.user_id = new.user_id
  ) then
    raise exception 'a message belongs to its turn''s thread and person'
      using errcode = 'check_violation', constraint = 'assistant_messages_owner';
  end if;
  return new;
end
$$;
revoke execute on function private.assistant_message_owner() from public;
create trigger assistant_messages_owner
  before insert on ai.assistant_messages
  for each row execute function private.assistant_message_owner();

-- A new message, and a turn that started, finished or was asked to stop, tell open
-- dashboards to refetch (0052's function: the business id and no row data, after commit).
create trigger assistant_messages_changed
  after insert on ai.assistant_messages
  for each row execute function private.assistant_changed();
create trigger assistant_turns_changed
  after insert or update of status, cancel_requested_at on ai.assistant_turns
  for each row execute function private.assistant_changed();

-- Threads past their time, removed by the worker's hourly ai.maintain task with their
-- turns and messages. What the assistant made stays, and so do the proposals it stored.
create function private.expire_assistant_threads(p_limit integer default 1000) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  with due as (
    select business_id, id from ai.assistant_threads
    where expires_at <= now()
    order by expires_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  delete from ai.assistant_threads t
  using due
  where t.business_id = due.business_id and t.id = due.id;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;
revoke execute on function private.expire_assistant_threads(integer) from public;
grant execute on function private.expire_assistant_threads(integer) to crm_app;

-- A proposal about a form (ADR-084): publishing one is the first thing the in-app
-- assistant proposes rather than does. Like the other subjects, a proposal is about at
-- most one thing, what it is about never changes, and deleting the form removes it.
alter table ai.proposals
  add column form_id uuid,
  add foreign key (business_id, form_id) references forms.forms (business_id, id) on delete cascade,
  drop constraint proposals_one_subject,
  add constraint proposals_one_subject
    check (num_nonnulls(record_id, conversation_id, automation_id, form_id) <= 1);
create index proposals_form_idx on ai.proposals (business_id, form_id);
-- One waiting proposal of a kind for a form: a newer one replaces the older one.
create unique index proposals_one_pending_per_form_idx
  on ai.proposals (business_id, form_id, kind)
  where status = 'pending' and form_id is not null;

create or replace function private.guard_proposal_change() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.business_id is distinct from old.business_id or new.id is distinct from old.id
    or new.agent is distinct from old.agent or new.kind is distinct from old.kind
    or new.conversation_id is distinct from old.conversation_id
    or new.record_id is distinct from old.record_id
    or new.automation_id is distinct from old.automation_id
    or new.form_id is distinct from old.form_id
    or new.autonomy is distinct from old.autonomy
    or new.created_at is distinct from old.created_at
  then
    raise exception 'what a proposal is about never changes'
      using errcode = 'check_violation', constraint = 'proposals_subject_fixed';
  end if;
  if old.status = new.status then
    if old.status <> 'pending' and to_jsonb(new) is distinct from to_jsonb(old) then
      raise exception 'a decided proposal is not changed'
        using errcode = 'check_violation', constraint = 'proposals_decided_fixed';
    end if;
    return new;
  end if;
  if not (
    (old.status = 'pending' and new.status in ('applied', 'dismissed', 'expired'))
    or (old.status = 'applied' and new.status = 'undone')
  ) then
    raise exception 'a proposal cannot go from % to %', old.status, new.status
      using errcode = 'check_violation', constraint = 'proposals_status_forward';
  end if;
  -- Undoing changes only who undid it and when: what ran, and how to reverse it, stay.
  if old.status = 'applied' and (
    new.command is distinct from old.command or new.result is distinct from old.result
    or new.undo is distinct from old.undo or new.decided_at is distinct from old.decided_at
    or new.decided_by_kind is distinct from old.decided_by_kind
    or new.decided_by_id is distinct from old.decided_by_id
    or new.applied_event_id is distinct from old.applied_event_id
  ) then
    raise exception 'undoing a proposal does not rewrite how it was applied'
      using errcode = 'check_violation', constraint = 'proposals_applied_fixed';
  end if;
  return new;
end
$$;
revoke execute on function private.guard_proposal_change() from public;
