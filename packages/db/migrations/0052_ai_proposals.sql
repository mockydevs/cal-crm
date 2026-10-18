-- Proposals, approvals, undo and autonomy (plan P1.65, ADR-060), and the inbox agent's
-- reply drafts (plan P1.66, ADR-061): what 0010's tables need before anything writes them.
--
-- 0010 made ai.proposals a place for "the exact command that runs on Apply". Applying one
-- safely needs more than the command:
--   * revision: what the proposal was made on, as its command's module fingerprints it.
--     When the record has moved on, Apply refuses rather than act on what is no longer so;
--   * edited: whether a person changed the proposal before applying it;
--   * result: what applying it made, such as the message, so that a second Apply answers
--     with the first one's outcome and runs nothing;
--   * undo: how to reverse it, worked out when it was applied, or the reason it cannot be;
--   * who undid it, and when;
--   * basis: what the agent drew on, for "Why this?". Counts and names the product worked
--     out itself, never the model's own account of its reasons.
-- The audit log and the event log say which proposal a command and its events came from.

-- No release ever wrote a proposal: nothing in the product inserted one. A row that is
-- here was written by hand, in a shape Apply cannot run, so it is closed, never deleted.
update ai.proposals
set command = jsonb_build_object('name', 'unknown.command', 'input', command)
where not (command ? 'name' and command ? 'input');
update ai.proposals
set status = 'expired', decided_at = now(), decided_by_kind = 'system', decided_by_id = null
where status = 'pending';

alter table ai.proposals
  add column revision text not null default ''
    constraint proposals_revision_length check (length(revision) <= 200),
  add column edited boolean not null default false,
  add column result jsonb
    constraint proposals_result_object check (jsonb_typeof(result) = 'object'),
  add column undo jsonb
    constraint proposals_undo_object check (jsonb_typeof(undo) = 'object'),
  add column basis jsonb
    constraint proposals_basis_object check (jsonb_typeof(basis) = 'object'),
  add column undone_by_kind text,
  add column undone_by_id uuid,
  add column undone_at timestamptz,
  -- coalesce: a missing key makes the comparison NULL, which a check would let through.
  add constraint proposals_command_shape check (coalesce(
    jsonb_typeof(command -> 'name') = 'string'
    and (command ->> 'name') ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'
    and jsonb_typeof(command -> 'input') = 'object',
    false
  )),
  add constraint proposals_decided_by_kind_valid check (
    decided_by_kind is null
    or decided_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')
  ),
  add constraint proposals_undone_by_kind_valid check (
    undone_by_kind is null
    or undone_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')
  ),
  -- Somebody decided, or nobody has yet: the kind of actor is kept with the time.
  add constraint proposals_decider_complete check ((decided_at is null) = (decided_by_kind is null)),
  add constraint proposals_undone_complete check (
    (status = 'undone') = (undone_at is not null) and (undone_at is null) = (undone_by_kind is null)
  ),
  -- Only what was applied has an outcome and a way back.
  add constraint proposals_result_only_applied check (
    (result is null and undo is null) or status in ('applied', 'undone')
  ),
  add constraint proposals_applied_has_undo check (status not in ('applied', 'undone') or undo is not null);

-- A new proposal says what it was made on; the default was only for the rows above.
alter table ai.proposals alter column revision drop default;

comment on column ai.proposals.command is
  'The command Apply runs: {"name": its name, "input": its input}. Run through the command layer, with the approving person''s permissions.';
comment on column ai.proposals.revision is
  'What the proposal was made on, as its command''s module fingerprints the record. Apply refuses when it no longer matches.';
comment on column ai.proposals.after is
  'What the proposal would do, as a card shows it: the change as it was proposed, then as it was applied.';
comment on column ai.proposals.undo is
  'How to reverse the applied proposal: {"kind": the kind of proposal whose command undoes it, "input": that command''s input}, or {"impossible": the reason}.';

-- One waiting proposal of a kind for a conversation: a newer draft replaces the older one.
create unique index proposals_one_pending_per_conversation_idx
  on ai.proposals (business_id, conversation_id, kind)
  where status = 'pending' and conversation_id is not null;
-- The proposals whose time is up, for the hourly sweep.
create index proposals_expiry_idx on ai.proposals (expires_at) where status = 'pending';

-- A decision is made once. Whatever a caller sends, a proposal only ever moves forward:
-- pending to applied, dismissed or expired; applied to undone. Nothing else, and what was
-- proposed (its command, subject and agent) never changes afterwards. The command layer
-- holds the same rules; this is the backstop a bug or a hand-written update meets.
create function private.guard_proposal_change() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.business_id is distinct from old.business_id or new.id is distinct from old.id
    or new.agent is distinct from old.agent or new.kind is distinct from old.kind
    or new.conversation_id is distinct from old.conversation_id
    or new.record_id is distinct from old.record_id
    or new.automation_id is distinct from old.automation_id
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

create trigger proposals_guard_change
  before update on ai.proposals
  for each row execute function private.guard_proposal_change();

-- Which proposal a command and its events came from: "approved by Sam, proposed by the
-- assistant" is then in both logs, beside the person who approved.
alter table audit.commands add column proposal_id uuid;
alter table events.events add column proposal_id uuid;
comment on column audit.commands.proposal_id is
  'The AI proposal this command was applied or undone from. The actor is whoever approved.';
comment on column events.events.proposal_id is
  'The AI proposal behind the command that wrote this event. The actor is whoever approved.';
create index commands_proposal_idx on audit.commands (proposal_id) where proposal_id is not null;
create index events_proposal_idx on events.events (proposal_id) where proposal_id is not null;

-- A reply draft is asked for in the app, or by an arriving message, and written by the
-- worker, which alone can open a provider's key (ADR-019). So a draft is a row: pending
-- while the model is asked, then finished with what happened. The words themselves are in
-- the proposal; this row is how the Inbox says "writing", "paused" or "couldn't".
create table ai.draft_requests (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  conversation_id uuid not null,
  origin text not null constraint draft_requests_origin_valid check (origin in ('person', 'message')),
  status text not null default 'pending' constraint draft_requests_status_valid
    check (status in ('pending', 'finished')),
  -- drafted: a proposal was written. The rest are the reasons none was.
  outcome text constraint draft_requests_outcome_valid check (outcome in (
    'drafted', 'refused', 'failed', 'paused', 'ai_off', 'not_configured', 'nothing_to_answer',
    'cannot_reply', 'superseded', 'expired'
  )),
  -- The category behind the outcome, such as the provider's failure or which limit paused it.
  reason text constraint draft_requests_reason_format check (reason ~ '^[a-z][a-z_]{0,63}$'),
  proposal_id uuid,
  request_id uuid,  -- the call in ai.requests, when a model was called
  requested_by_id uuid,
  -- The job that is writing it. A job takes the request over by writing a claim of its
  -- own; a job that finds another's claim when it comes back leaves its answer unused.
  claim uuid,
  created_at timestamptz not null default now(),
  -- A draft nobody wrote by then is shown as expired: the worker is not running.
  expires_at timestamptz not null default now() + interval '3 minutes',
  finished_at timestamptz,
  primary key (business_id, id),
  foreign key (business_id, conversation_id) references messaging.conversations (business_id, id) on delete cascade,
  foreign key (business_id, proposal_id) references ai.proposals (business_id, id) on delete set null (proposal_id),
  foreign key (business_id, request_id) references ai.requests (business_id, id) on delete set null (request_id),
  constraint draft_requests_finished_together
    check ((status = 'pending') = (finished_at is null) and (status = 'pending') = (outcome is null)),
  constraint draft_requests_drafted_has_proposal check (outcome = 'drafted' or proposal_id is null)
);
create index draft_requests_conversation_idx
  on ai.draft_requests (business_id, conversation_id, created_at desc);
create index draft_requests_proposal_idx on ai.draft_requests (business_id, proposal_id);
create index draft_requests_request_idx on ai.draft_requests (business_id, request_id);
-- One draft being written for a conversation at a time: asking twice asks the model once.
create unique index draft_requests_one_pending_idx
  on ai.draft_requests (business_id, conversation_id) where status = 'pending';

call util.enable_tenant_rls('ai.draft_requests');

grant select, insert, update, delete on ai.draft_requests to crm_app;

-- An arriving message asks for a draft (ADR-061), as an event starts the automations it
-- triggers (0036): whoever writes the event, the same transaction queues the job, so
-- nothing is drafted for a message that rolled back. A business with AI turned off, or
-- with no provider's key it could use, gets no job at all.
--
-- One waiting job per conversation: Graphile Worker's job_key in its default 'replace'
-- mode moves the waiting job to the newest message, so three messages in a burst are
-- answered by one draft (graphile-worker 0.18 `add_job`, sql/000018.sql). The job runs a
-- few seconds on, which is what lets a burst gather. It is tried three times at most: a
-- draft nobody waited for is not worth more.
create function private.queue_reply_draft() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_named text := new.payload ->> 'conversationId';
  v_conversation_id uuid;
  v_enabled boolean;
  v_own boolean;
begin
  if new.business_id is null or new.type <> 'message.received' or new.subject_kind <> 'message' then
    return null;
  end if;
  -- The event says which conversation the message arrived in: every writer of
  -- message.received puts it in the payload. An event that names none asks for nothing.
  if v_named is null or v_named !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_conversation_id := v_named::uuid;
  select s.enabled, s.key_source = 'own' into v_enabled, v_own
    from ai.settings s where s.business_id = new.business_id;
  if not coalesce(v_enabled, true) then
    return null;
  end if;
  -- A key where the business takes its keys from, as the gateway looks for one: its own
  -- once it chose its own, its agency's until then.
  if not exists (
    select 1 from ai.provider_keys k
    where k.agency_id = new.agency_id
      and case when coalesce(v_own, false) then k.business_id = new.business_id
               else k.business_id is null end
  ) then
    return null;
  end if;
  perform graphile_worker.add_job(
    'ai.draft_reply',
    payload := jsonb_build_object(
      'agencyId', new.agency_id,
      'businessId', new.business_id,
      'correlationId', new.correlation_id,
      'causationId', new.id,
      'data', jsonb_build_object('conversationId', v_conversation_id)
    )::json,
    run_at := now() + interval '3 seconds',
    max_attempts := 3,
    job_key := 'ai-draft-reply:' || v_conversation_id::text
  );
  return null;
end
$$;
revoke execute on function private.queue_reply_draft() from public;

create trigger events_queue_reply_draft
  after insert on events.events
  for each row execute function private.queue_reply_draft();

-- A draft being written, a proposal stored and a proposal decided each tell open
-- dashboards to refetch, as a stored message does (0046, ADR-025): the worker writes a
-- draft seconds after the page was read, so without this the Inbox would show it only on
-- a reload. PostgreSQL delivers the notification only after commit and folds the same
-- one sent twice in a transaction into one; it carries the business id and no row data.
create function private.assistant_changed()
returns trigger language plpgsql set search_path = ''
as $$
begin
  perform pg_notify('crm_business_changed', new.business_id::text);
  return null;
end
$$;
revoke execute on function private.assistant_changed() from public;
create trigger proposals_changed
  after insert or update of status on ai.proposals
  for each row execute function private.assistant_changed();
create trigger draft_requests_changed
  after insert or update of status on ai.draft_requests
  for each row execute function private.assistant_changed();

-- Proposals past their time, closed by the worker's hourly ai.maintain task. Apply checks
-- the time itself, so a proposal is refused from the moment it expires, swept or not.
create function private.expire_ai_proposals(p_limit integer default 1000) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  with due as (
    select business_id, id from ai.proposals
    where status = 'pending' and expires_at <= now()
    order by expires_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update ai.proposals p
  set status = 'expired', decided_at = now(), decided_by_kind = 'system', decided_by_id = null
  from due
  where p.business_id = due.business_id and p.id = due.id;
  get diagnostics v_count = row_count;
  -- Draft requests are read while they wait and for a day after: older ones say nothing.
  delete from ai.draft_requests where created_at < now() - interval '7 days';
  return v_count;
end
$$;
revoke execute on function private.expire_ai_proposals(integer) from public;
grant execute on function private.expire_ai_proposals(integer) to crm_app;
