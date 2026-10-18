-- ADR-094: bounded continuity and durable admission/completion receipts. An unfinished
-- write is uncertain after a crash and is never automatically repeated.
alter table audit.commands add column assistant_tool_call_id text
  constraint audit_assistant_tool_call_id_length check (length(assistant_tool_call_id) between 1 and 500);
create index audit_commands_assistant_tool_idx on audit.commands(business_id, assistant_tool_call_id, command)
  where assistant_tool_call_id is not null;
alter table ai.assistant_threads add column checkpoint jsonb not null default '{}'::jsonb
  constraint assistant_checkpoint_object check (jsonb_typeof(checkpoint) = 'object')
  constraint assistant_checkpoint_size check (octet_length(checkpoint::text) <= 100000);

-- A checkpoint attests historical activity; the person can write new requests but cannot
-- manufacture the worker's saved receipts by editing the thread directly.
create function private.guard_assistant_checkpoint() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select app.actor_kind()) is distinct from 'system' then
    if tg_op = 'INSERT' then
      if new.checkpoint <> '{}'::jsonb then
        raise exception 'only the worker writes a checkpoint'
          using errcode = 'check_violation', constraint = 'assistant_checkpoint_worker_only';
      end if;
    elsif new.checkpoint is distinct from old.checkpoint then
      raise exception 'only the worker writes a checkpoint'
        using errcode = 'check_violation', constraint = 'assistant_checkpoint_worker_only';
    end if;
  end if;
  return new;
end
$$;
revoke execute on function private.guard_assistant_checkpoint() from public;
create trigger assistant_checkpoint_guard before insert or update on ai.assistant_threads
  for each row execute function private.guard_assistant_checkpoint();

create table ai.assistant_tool_calls (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  thread_id uuid not null,
  turn_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  call_id text not null check (length(call_id) between 1 and 500),
  operation_id text not null check (length(operation_id) between 1 and 120),
  command_name text,
  effect text not null check (effect in ('read', 'draft', 'confirm')),
  state text not null default 'started' check (state in ('started', 'completed', 'failed', 'uncertain')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (business_id, id),
  unique (business_id, turn_id, call_id),
  foreign key (business_id, thread_id) references ai.assistant_threads(business_id, id) on delete cascade,
  foreign key (business_id, turn_id) references ai.assistant_turns(business_id, id) on delete cascade,
  constraint assistant_tool_call_completion check ((state = 'started') = (finished_at is null))
);
comment on table ai.assistant_tool_calls is
  'Private tool execution receipts. No raw inputs or provider credentials. Uncertain calls are not replayed.';
create index assistant_tool_calls_thread_idx on ai.assistant_tool_calls(business_id, thread_id, started_at);
create index assistant_tool_calls_user_idx on ai.assistant_tool_calls(user_id);
call util.enable_tenant_rls('ai.assistant_tool_calls');
create policy own_or_worker on ai.assistant_tool_calls as restrictive for all
  using ((select app.actor_kind()) = 'system' or
    (user_id = (select app.user_id()) and (select app.actor_kind()) = 'user'
     and (select app.actor_id()) = (select app.user_id())))
  with check ((select app.actor_kind()) = 'system' or
    (user_id = (select app.user_id()) and (select app.actor_kind()) = 'user'
     and (select app.actor_id()) = (select app.user_id())));
grant select, insert, update on ai.assistant_tool_calls to crm_app;
create policy worker_inserts on ai.assistant_tool_calls as restrictive for insert
  with check ((select app.actor_kind()) = 'system');
create policy worker_updates on ai.assistant_tool_calls as restrictive for update
  using ((select app.actor_kind()) = 'system')
  with check ((select app.actor_kind()) = 'system');
create trigger assistant_tool_calls_owner before insert on ai.assistant_tool_calls
  for each row execute function private.assistant_message_owner();

create function private.guard_assistant_tool_call() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.business_id is distinct from old.business_id or new.id is distinct from old.id
     or new.thread_id is distinct from old.thread_id or new.turn_id is distinct from old.turn_id
     or new.user_id is distinct from old.user_id or new.call_id is distinct from old.call_id
     or new.operation_id is distinct from old.operation_id or new.effect is distinct from old.effect
     or new.command_name is distinct from old.command_name
     or new.started_at is distinct from old.started_at then
    raise exception 'tool execution identity never changes'
      using errcode = 'check_violation', constraint = 'assistant_tool_call_identity_fixed';
  end if;
  if (old.state in ('completed', 'failed') or (old.state = 'uncertain' and new.state = 'started'))
     and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'a completed tool receipt never changes'
      using errcode = 'check_violation', constraint = 'assistant_tool_call_terminal_fixed';
  end if;
  return new;
end
$$;
revoke execute on function private.guard_assistant_tool_call() from public;
create trigger assistant_tool_call_immutable before update on ai.assistant_tool_calls
  for each row execute function private.guard_assistant_tool_call();
