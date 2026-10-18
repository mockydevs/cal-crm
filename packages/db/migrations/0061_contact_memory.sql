-- Field extraction and contact memory (plan P1.67, ADR-069): what 0010's memory tables
-- need before anything writes them, the assistant that fills them, and the job an arriving
-- message queues.
--
-- Everything a contact writes is untrusted. So nothing here lets a model's answer reach a
-- contact's record by itself: what the extraction job finds is stored as proposals
-- (ai.proposals), and a fact enters ai.contact_facts only through a command, run by a
-- person who approved it or by the assistant where the business said it may act. This
-- migration adds the limits the database holds whatever the code does: how long a fact
-- is, that it is one line, what kind it is, and that a fact that came from a proposal
-- names the events it came from.

-- The assistant that reads what a contact wrote: it proposes field values and facts.
alter table ai.proposals
  drop constraint proposals_agent_valid,
  add constraint proposals_agent_valid
    check (agent in ('inbox', 'copilot', 'automation_author', 'analyst', 'cleanup', 'extraction'));
alter table ai.autonomy_rules
  drop constraint autonomy_rules_agent_valid,
  add constraint autonomy_rules_agent_valid
    check (agent in ('inbox', 'copilot', 'automation_author', 'analyst', 'cleanup', 'extraction'));

-- The proposals waiting about one record, newest first: a contact's page reads them.
create index proposals_record_pending_idx
  on ai.proposals (business_id, record_id, created_at desc)
  where status = 'pending' and record_id is not null;

alter table ai.contact_facts
  -- What the fact is about. `other` is a fact written before kinds existed.
  add column kind text not null default 'other' constraint contact_facts_kind_valid
    check (kind in ('preference', 'need', 'circumstance', 'relationship', 'history', 'other')),
  -- The contact's own words the fact was read from, exactly as they wrote them.
  add column quote text constraint contact_facts_quote_length check (length(quote) between 1 and 300),
  add column conversation_id uuid,
  add column proposal_id uuid,
  -- Who wrote the row: the assistant acting on its own, or the person who approved it.
  add column created_by_kind text not null default 'system' constraint contact_facts_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  add column created_by_id uuid,
  -- Set when a person rewrote the statement: the words are then theirs.
  add column corrected_at timestamptz,
  add foreign key (business_id, conversation_id)
    references messaging.conversations (business_id, id) on delete set null (conversation_id),
  add foreign key (business_id, proposal_id)
    references ai.proposals (business_id, id) on delete set null (proposal_id),
  add constraint contact_facts_sources_bounded check (cardinality(source_event_ids) <= 20),
  -- "Every fact links to its events": what a proposal made says where it came from.
  add constraint contact_facts_proposed_has_source
    check (proposal_id is null or cardinality(source_event_ids) >= 1);

-- A fact is one short line. Later prompts are given facts as data, and a short single line
-- has no room for a paragraph of instructions or a second "message". Not validated against
-- rows already there: no release wrote one, and a row put in by hand is left as it is
-- (readers cut what they give a model to the same length).
alter table ai.contact_facts
  add constraint contact_facts_statement_short check (length(statement) <= 240) not valid,
  add constraint contact_facts_statement_one_line check (statement !~ '[[:cntrl:]]') not valid;

create index contact_facts_conversation_idx on ai.contact_facts (business_id, conversation_id);
create index contact_facts_proposal_idx on ai.contact_facts (business_id, proposal_id);

comment on column ai.contact_facts.statement is
  'One short line about the contact. Data, never an instruction: it is shown to people and given to models between data markers.';
comment on column ai.contact_facts.status is
  'proposed: the assistant wrote it on its own and no person has confirmed it. confirmed: a person approved or wrote it. rejected and superseded are no longer known.';
comment on column ai.contact_facts.source_event_ids is
  'The events the fact came from, such as the message.received of the message it was read in. Plain ids: events are partitioned and archived.';

-- A person removes a wrong or sensitive fact for good.
grant delete on ai.contact_facts to crm_app;

-- One run of the extraction job: a conversation as it stood (its thread's fingerprint), so
-- a thread is read once however often the job runs, and what became of the model's answer.
-- It holds counts and categories, never a word of a message or of an answer.
create table ai.extractions (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  conversation_id uuid not null,
  contact_id uuid not null,
  revision text not null constraint extractions_revision_length check (length(revision) between 1 and 200),
  -- The number, in its conversation, of the newest message this reading covered. The next
  -- reading reads only what came after the last one that read to its end.
  through_seq bigint not null default 0 constraint extractions_through_seq_range check (through_seq >= 0),
  status text not null default 'pending' constraint extractions_status_valid
    check (status in ('pending', 'finished')),
  -- extracted: at least one proposal was stored. The rest are the reasons none was.
  outcome text constraint extractions_outcome_valid check (outcome in (
    'extracted', 'nothing_found', 'nothing_to_read', 'refused', 'failed', 'paused', 'ai_off',
    'not_configured', 'invalid_answer', 'superseded'
  )),
  reason text constraint extractions_reason_format check (reason ~ '^[a-z][a-z_]{0,63}$'),
  request_id uuid,  -- the call in ai.requests, when a model was called
  -- The job that is reading. A job that finds another's claim leaves its answer unused.
  claim uuid,
  proposed_fields integer not null default 0 constraint extractions_proposed_fields_range check (proposed_fields >= 0),
  proposed_facts integer not null default 0 constraint extractions_proposed_facts_range check (proposed_facts >= 0),
  -- What the answer held that was thrown away: not in the schema, not allowed, not grounded.
  discarded integer not null default 0 constraint extractions_discarded_range check (discarded >= 0),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (business_id, id),
  foreign key (business_id, conversation_id) references messaging.conversations (business_id, id) on delete cascade,
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade,
  foreign key (business_id, request_id) references ai.requests (business_id, id) on delete set null (request_id),
  constraint extractions_finished_together
    check ((status = 'pending') = (finished_at is null) and (status = 'pending') = (outcome is null)),
  -- A thread as it stood is read once.
  constraint extractions_once unique (business_id, conversation_id, revision)
);
create index extractions_contact_idx on ai.extractions (business_id, contact_id);
create index extractions_request_idx on ai.extractions (business_id, request_id);
create index extractions_created_idx on ai.extractions (created_at);

call util.enable_tenant_rls('ai.extractions');
grant select, insert, update on ai.extractions to crm_app;

-- Runs older than thirty days say nothing any more: the proposals and facts they led to
-- stand on their own. Swept by the worker's hourly ai.maintain task.
create function private.expire_ai_extractions(p_limit integer default 1000) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  with due as (
    select business_id, id from ai.extractions
    where created_at < now() - interval '30 days'
    order by created_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  delete from ai.extractions e using due
  where e.business_id = due.business_id and e.id = due.id;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;
revoke execute on function private.expire_ai_extractions(integer) from public;
grant execute on function private.expire_ai_extractions(integer) to crm_app;

-- An arriving message asks for its conversation to be read, as it asks for a draft (0052):
-- in the transaction that writes the event, only where AI is on and a key is connected
-- where the business takes its keys from. One waiting job per conversation, half a minute
-- on: a burst of messages is read once, and after the draft those messages asked for.
create function private.queue_contact_extraction() returns trigger
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
  if v_named is null or v_named !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_conversation_id := v_named::uuid;
  select s.enabled, s.key_source = 'own' into v_enabled, v_own
    from ai.settings s where s.business_id = new.business_id;
  if not coalesce(v_enabled, true) then
    return null;
  end if;
  if not exists (
    select 1 from ai.provider_keys k
    where k.agency_id = new.agency_id
      and case when coalesce(v_own, false) then k.business_id = new.business_id
               else k.business_id is null end
  ) then
    return null;
  end if;
  perform graphile_worker.add_job(
    'ai.extract_contact',
    payload := jsonb_build_object(
      'agencyId', new.agency_id,
      'businessId', new.business_id,
      'correlationId', new.correlation_id,
      'causationId', new.id,
      'data', jsonb_build_object('conversationId', v_conversation_id)
    )::json,
    run_at := now() + interval '30 seconds',
    max_attempts := 3,
    job_key := 'ai-extract-contact:' || v_conversation_id::text
  );
  return null;
end
$$;
revoke execute on function private.queue_contact_extraction() from public;

create trigger events_queue_contact_extraction
  after insert on events.events
  for each row execute function private.queue_contact_extraction();
