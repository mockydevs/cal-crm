-- Engagement scoring: Settings → Manage Scoring, a contact's score, and the score's workflow
-- trigger and action.
--
-- A business has one score profile, "Engagement Score". Its rules are a draft: adding,
-- changing or deleting one changes no score. Publishing copies the draft into the profile as
-- the live rules, with the event types they listen to; only live rules score. A stored event
-- of one of those types queues one job, which scores each contact the event is on once per
-- live rule it passes. Every change to a score is kept in crm.score_changes, keyed by what
-- caused it, so an event or a workflow step that runs twice scores once.
--
-- One save can write several events: a contact's name and three of its fields are four.
-- So each event now names the command that wrote it, and "Contact changed" scores once per
-- command rather than once per event.

-- The command that wrote the event: the id of its audit row in audit.commands. A command
-- run inside another (a workflow step's actions) shares the outer one's. Null for an event
-- written outside a command, and for every event stored before this column was added.
alter table events.events add column command_id uuid;
comment on column events.events.command_id is
  'The command that wrote this event, or ran the one that did: its audit.commands id. Null when no command wrote it.';

create table crm.score_profiles (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  name text not null default 'Engagement Score'
    constraint score_profiles_name_length check (length(btrim(name)) between 1 and 100),
  description text not null default ''
    constraint score_profiles_description_length check (length(description) <= 500),
  -- Raised by every change to the draft; publishing names the revision it saw.
  revision integer not null default 0 constraint score_profiles_revision_range check (revision >= 0),
  published_revision integer
    constraint score_profiles_published_revision_range check (published_revision >= 0),
  -- The rules that score, as they were published, and the event types they listen to.
  live_rules jsonb not null default '[]'
    constraint score_profiles_live_rules_array check (jsonb_typeof(live_rules) = 'array'),
  live_event_types text[] not null default '{}',
  published_at timestamptz,
  published_by_kind text,
  published_by_id uuid,
  constraint score_profiles_published_together
    check ((published_at is null) = (published_revision is null)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id)
);

call util.add_updated_at_trigger('crm.score_profiles');
call util.enable_tenant_rls('crm.score_profiles');
grant select, insert, update on crm.score_profiles to crm_app;

-- The draft's rules. A tag or form a rule names is kept by id without a foreign key: one
-- deleted afterwards leaves the rule scoring nobody, and the page says so.
create table crm.score_rules (
  business_id uuid not null references crm.score_profiles (business_id) on delete cascade,
  id uuid not null default uuidv7(),
  action text not null constraint score_rules_action_valid check (action in (
    'email_event', 'contact_replied', 'form_submitted', 'appointment_booked',
    'appointment_status', 'contact_tag', 'payment_received', 'trigger_link_clicked',
    'contact_changed'
  )),
  -- Which of the action: the email event, the channel, the form, the status, the tag.
  qualifier jsonb not null default '{}'
    constraint score_rules_qualifier_object check (jsonb_typeof(qualifier) = 'object'),
  has_tag_id uuid,
  calculation text not null constraint score_rules_calculation_valid
    check (calculation in ('add', 'subtract')),
  points integer not null constraint score_rules_points_range check (points between 1 and 1000),
  revision integer not null default 1 constraint score_rules_revision_range check (revision >= 1),
  created_by_kind text not null constraint score_rules_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id)
);

call util.add_updated_at_trigger('crm.score_rules');
call util.enable_tenant_rls('crm.score_rules');
grant select, insert, update, delete on crm.score_rules to crm_app;

-- A contact's score. No row: nothing has scored the contact yet.
create table crm.contact_scores (
  business_id uuid not null,
  contact_id uuid not null,
  score integer not null constraint contact_scores_score_range check (score between -1000000 and 1000000),
  updated_at timestamptz not null default now(),
  primary key (business_id, contact_id),
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade
);

call util.add_updated_at_trigger('crm.contact_scores');
call util.enable_tenant_rls('crm.contact_scores');
grant select, insert, update on crm.contact_scores to crm_app;

-- Every change to a score, and what made it: a live rule (the event and the rule), a
-- workflow step (the run's visit of it), or a person. What a rule or a step gives is keyed,
-- so a second run of the same job or step finds its key taken and scores nothing.
create table crm.score_changes (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  contact_id uuid not null,
  source text not null constraint score_changes_source_valid
    check (source in ('rule', 'workflow', 'person')),
  source_key text constraint score_changes_source_key_length check (length(source_key) between 1 and 200),
  constraint score_changes_keyed check ((source = 'person') = (source_key is null)),
  -- The rule that scored; kept after the rule is deleted, as a record of what happened.
  rule_id uuid,
  change integer not null constraint score_changes_change_range check (change between -2000000 and 2000000),
  actor_kind text not null,
  actor_id uuid,
  recorded_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade
);
create index score_changes_contact_idx on crm.score_changes (business_id, contact_id, recorded_at desc);
create unique index score_changes_source_idx
  on crm.score_changes (business_id, contact_id, source_key) where source_key is not null;

call util.enable_tenant_rls('crm.score_changes');
grant select, insert on crm.score_changes to crm_app;

-- An event of a type the business's live rules listen to queues the job that scores it, in
-- the transaction that wrote the event (as 0036 queues automation matching): nothing is
-- scored for a change that rolled back, and nothing that happened is missed. One waiting
-- job per event. An event no live rule listens to costs one primary-key lookup, and only an
-- event that queues a job checks that the queue exists.
create function private.queue_score_event() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.business_id is not null and exists (
    select 1
    from crm.score_profiles p
    where p.business_id = new.business_id and new.type = any (p.live_event_types)
  ) then
    -- A new install creates its queue after these files run, so there is no job to add yet.
    if to_regprocedure('graphile_worker.remove_job(text)') is null then
      return null;
    end if;
    perform graphile_worker.add_job(
      'scoring.from_event',
      payload := jsonb_build_object(
        'agencyId', new.agency_id,
        'businessId', new.business_id,
        'correlationId', new.correlation_id,
        'causationId', new.id,
        'data', jsonb_build_object('eventId', new.id)
      )::json,
      max_attempts := 10,
      job_key := 'score-event:' || new.id::text,
      job_key_mode := 'preserve_run_at'
    );
  end if;
  return null;
end
$$;
revoke execute on function private.queue_score_event() from public;

create trigger events_queue_score_event
  after insert on events.events
  for each row execute function private.queue_score_event();
