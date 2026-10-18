-- B4.01 to B4.05 (tasks/b4-automation-backend.md, ADR-063): what the workflow screens ask
-- of the database. Folders for automations; a Deleted list that is purged after its days;
-- enrolment and step statistics kept as counters, so a list of fifty automations reads
-- fifty counter rows and not every run there ever was; and the columns the enrollment
-- history and the execution logs filter and page by. Existing rows keep their meaning:
-- every automation starts in no folder, and the counters start equal to the rows.

-- Folders -----------------------------------------------------------------------------------
-- A folder holds automations and other folders. A deleted folder's contents move up one
-- level (the command does that; the foreign keys below only say what holds if it didn't).

create table automation.folders (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  parent_id uuid,
  name text not null constraint folders_name_trimmed
    check (name = btrim(name) and length(name) between 1 and 120),
  -- Two people can rename or move one folder: each change names the revision it started from.
  revision integer not null default 1 constraint folders_revision_positive check (revision > 0),
  created_by_kind text not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, parent_id) references automation.folders (business_id, id),
  constraint folders_not_own_parent check (parent_id is distinct from id)
);
-- One name per place, whatever its capitals; the top level (no parent) is a place too.
create unique index folders_sibling_name_idx
  on automation.folders (business_id, parent_id, lower(name)) nulls not distinct;

call util.add_updated_at_trigger('automation.folders');
call util.enable_tenant_rls('automation.folders');
grant select, insert, update, delete on automation.folders to crm_app;

alter table automation.automations
  add column folder_id uuid,
  add constraint automations_folder_fkey foreign key (business_id, folder_id)
    references automation.folders (business_id, id) on delete set null (folder_id),
  -- A deleted automation is in no folder, and comes back at the top level.
  add constraint automations_archived_unfiled check (status <> 'archived' or folder_id is null);
create index automations_folder_idx on automation.automations (business_id, folder_id);

-- The Deleted list -----------------------------------------------------------------------------
-- status 'archived' with archived_at (0009) is the Deleted list. The daily purge finds
-- what has been there past its days with this index, across businesses.
create index automations_archived_idx on automation.automations (archived_at)
  where status = 'archived';

create function private.businesses_with_deleted_automations(p_days integer, p_limit integer)
returns table (agency_id uuid, business_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, b.id
  from tenancy.businesses b
  where exists (
    select 1 from automation.automations a
    where a.business_id = b.id and a.status = 'archived'
      and a.archived_at < now() - pg_catalog.make_interval(days => p_days)
  )
  order by b.id
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function private.businesses_with_deleted_automations(integer, integer) from public;
grant execute on function private.businesses_with_deleted_automations(integer, integer) to crm_app;

-- Enrollment history ---------------------------------------------------------------------------
-- Which trigger enrolled the record, as a column the list can filter and count by. Until
-- now it was kept only inside state.

alter table automation.enrolments add column trigger_key text;
alter table automation.enrolments disable trigger touch_updated_at;
update automation.enrolments set trigger_key = state ->> 'triggerId' where state ? 'triggerId';
alter table automation.enrolments enable trigger touch_updated_at;

-- Newest first by when the run started, for one automation, with a date range.
create index enrolments_automation_started_idx
  on automation.enrolments (business_id, automation_id, started_at desc, id desc);

-- Execution logs -------------------------------------------------------------------------------
-- A step run names its automation and version itself, so an automation's logs are one index
-- range and its statistics need no join. Both always come from the run's own enrolment.

alter table automation.step_runs
  add column automation_id uuid,
  add column version_id uuid,
  -- This row continues the visit an earlier row of the same step began: a wait for an event
  -- that was answered or timed out, a webhook's result, a message held for the sending
  -- window. Such a visit is one entry in the statistics, not two.
  add column resumes boolean not null default false;

create function private.step_run_automation() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  select e.automation_id, e.version_id into new.automation_id, new.version_id
  from automation.enrolments e
  where e.business_id = new.business_id and e.id = new.enrolment_id;
  return new;
end
$$;
revoke execute on function private.step_run_automation() from public;
create trigger step_runs_automation
  before insert or update of enrolment_id, automation_id, version_id on automation.step_runs
  for each row execute function private.step_run_automation();

update automation.step_runs s
set automation_id = e.automation_id, version_id = e.version_id
from automation.enrolments e
where e.business_id = s.business_id and e.id = s.enrolment_id;

alter table automation.step_runs
  alter column automation_id set not null,
  alter column version_id set not null;

create index step_runs_automation_idx
  on automation.step_runs (business_id, automation_id, started_at desc, id desc);

-- A wait's row used to stay 'waiting' for ever, and every row was stamped finished as it
-- was written. From here a row is 'waiting', and unfinished, only while its run waits at
-- it. Rows written before are put right from what followed them: a wait the run went on
-- from succeeded when the next step began; one its run was stopped or cancelled in was
-- skipped; and the second row of a wait for an event or of a webhook continues the first.
with ordered as (
  select s.business_id, s.id, s.started_at, s.step_key, s.status,
         s.input ->> 'type' as step_type,
         lag(s.step_key) over visit as previous_key,
         lag(s.status) over visit as previous_status,
         lead(s.started_at) over visit as next_started_at,
         e.status as run_status, e.finished_at as run_finished_at
  from automation.step_runs s
  join automation.enrolments e on e.business_id = s.business_id and e.id = s.enrolment_id
  window visit as (partition by s.business_id, s.enrolment_id order by s.started_at, s.id)
)
update automation.step_runs s
set resumes = coalesce(
      o.previous_key = o.step_key and o.previous_status = 'waiting'
        and o.step_type in ('wait.event', 'webhook.call'),
      false),
    status = case
      when o.status <> 'waiting' then o.status
      when o.next_started_at is not null then 'succeeded'
      when o.run_status in ('completed', 'failed') then 'succeeded'
      when o.run_status in ('exited', 'cancelled') then 'skipped'
      else 'waiting'
    end,
    finished_at = case
      when o.status <> 'waiting' then s.finished_at
      when o.next_started_at is not null then o.next_started_at
      when o.run_status in ('completed', 'failed', 'exited', 'cancelled') then o.run_finished_at
      else null
    end
from ordered o
where o.business_id = s.business_id and o.id = s.id and o.started_at = s.started_at;

-- Statistics -----------------------------------------------------------------------------------
-- Counters, per published version, of the runs (how many enrolled, how many in each
-- status), of each trigger (how many it enrolled) and of each step (how many visits began,
-- how many rows continued one, how many rows are in each status). They are kept by the
-- triggers below, in the transaction that writes the run or the step, so they are equal to
-- the rows at every commit.
--
-- A change is an inserted row in stat_deltas, never an update of a shared counter: two
-- steps of one automation running at once write two rows and neither waits for the other,
-- so no order of locks exists to get wrong. private.compact_automation_stats folds the
-- rows into stat_counts; a reader adds the two tables in one statement, which sees both at
-- one moment, so a fold in progress never shows a number twice or not at all.
--
-- The only foreign key is to the version, which nothing locks: one to the automation would
-- make every step wait for a draft being saved. Deleting an automation deletes its versions
-- and, through them, its counters.

create table automation.stat_counts (
  business_id uuid not null,
  version_id uuid not null,
  automation_id uuid not null,
  scope text not null constraint stat_counts_scope_valid check (scope in ('run', 'trigger', 'step')),
  -- '' for the run scope, the trigger's id, or the step's key.
  key text not null,
  metric text not null constraint stat_counts_metric_format check (metric ~ '^[a-z_]{1,40}$'),
  n bigint not null,
  primary key (business_id, version_id, scope, key, metric),
  foreign key (business_id, version_id) references automation.versions (business_id, id) on delete cascade
);
create index stat_counts_automation_idx on automation.stat_counts (business_id, automation_id, scope);

create table automation.stat_deltas (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  version_id uuid not null,
  automation_id uuid not null,
  scope text not null constraint stat_deltas_scope_valid check (scope in ('run', 'trigger', 'step')),
  key text not null,
  metric text not null constraint stat_deltas_metric_format check (metric ~ '^[a-z_]{1,40}$'),
  n integer not null constraint stat_deltas_n_nonzero check (n <> 0),
  primary key (business_id, id),
  foreign key (business_id, version_id) references automation.versions (business_id, id) on delete cascade
);
create index stat_deltas_version_idx on automation.stat_deltas (business_id, version_id);
create index stat_deltas_automation_idx on automation.stat_deltas (business_id, automation_id, scope);

call util.enable_tenant_rls('automation.stat_counts');
call util.enable_tenant_rls('automation.stat_deltas');
-- Read only: the triggers and the fold below are the only writers.
grant select on automation.stat_counts, automation.stat_deltas to crm_app;

-- A run: 'enrolled' once, and one in the metric named after its status, which moves as the
-- status does. A run deleted with its record leaves the counters; one deleted with its
-- automation has no counters left to leave, so nothing is written for it.
create function private.record_enrolment_stats() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into automation.stat_deltas (business_id, version_id, automation_id, scope, key, metric, n)
    values (new.business_id, new.version_id, new.automation_id, 'run', '', 'enrolled', 1),
           (new.business_id, new.version_id, new.automation_id, 'run', '', new.status, 1);
    if new.trigger_key is not null then
      insert into automation.stat_deltas (business_id, version_id, automation_id, scope, key, metric, n)
      values (new.business_id, new.version_id, new.automation_id, 'trigger', new.trigger_key, 'enrolled', 1);
    end if;
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      insert into automation.stat_deltas (business_id, version_id, automation_id, scope, key, metric, n)
      values (old.business_id, old.version_id, old.automation_id, 'run', '', old.status, -1),
             (new.business_id, new.version_id, new.automation_id, 'run', '', new.status, 1);
    end if;
    if new.trigger_key is distinct from old.trigger_key then
      if old.trigger_key is not null then
        insert into automation.stat_deltas (business_id, version_id, automation_id, scope, key, metric, n)
        values (old.business_id, old.version_id, old.automation_id, 'trigger', old.trigger_key, 'enrolled', -1);
      end if;
      if new.trigger_key is not null then
        insert into automation.stat_deltas (business_id, version_id, automation_id, scope, key, metric, n)
        values (new.business_id, new.version_id, new.automation_id, 'trigger', new.trigger_key, 'enrolled', 1);
      end if;
    end if;
  elsif exists (select 1 from automation.versions v
                where v.business_id = old.business_id and v.id = old.version_id) then
    insert into automation.stat_deltas (business_id, version_id, automation_id, scope, key, metric, n)
    values (old.business_id, old.version_id, old.automation_id, 'run', '', 'enrolled', -1),
           (old.business_id, old.version_id, old.automation_id, 'run', '', old.status, -1);
    if old.trigger_key is not null then
      insert into automation.stat_deltas (business_id, version_id, automation_id, scope, key, metric, n)
      values (old.business_id, old.version_id, old.automation_id, 'trigger', old.trigger_key, 'enrolled', -1);
    end if;
  end if;
  return null;
end
$$;
revoke execute on function private.record_enrolment_stats() from public;

-- A step row: 'entered' when it begins a visit or 'resumed' when it continues one, and one
-- in the metric named after its status, which moves as the status does.
create function private.record_step_stats() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into automation.stat_deltas (business_id, version_id, automation_id, scope, key, metric, n)
    values (new.business_id, new.version_id, new.automation_id, 'step', new.step_key,
            case when new.resumes then 'resumed' else 'entered' end, 1),
           (new.business_id, new.version_id, new.automation_id, 'step', new.step_key, new.status, 1);
  elsif tg_op = 'UPDATE' then
    insert into automation.stat_deltas (business_id, version_id, automation_id, scope, key, metric, n)
    values (old.business_id, old.version_id, old.automation_id, 'step', old.step_key, old.status, -1),
           (new.business_id, new.version_id, new.automation_id, 'step', new.step_key, new.status, 1);
  elsif exists (select 1 from automation.versions v
                where v.business_id = old.business_id and v.id = old.version_id) then
    insert into automation.stat_deltas (business_id, version_id, automation_id, scope, key, metric, n)
    values (old.business_id, old.version_id, old.automation_id, 'step', old.step_key,
            case when old.resumes then 'resumed' else 'entered' end, -1),
           (old.business_id, old.version_id, old.automation_id, 'step', old.step_key, old.status, -1);
  end if;
  return null;
end
$$;
revoke execute on function private.record_step_stats() from public;

create trigger enrolments_stats_insert after insert on automation.enrolments
  for each row execute function private.record_enrolment_stats();
create trigger enrolments_stats_update after update of status, trigger_key on automation.enrolments
  for each row when (old.status is distinct from new.status
                     or old.trigger_key is distinct from new.trigger_key)
  execute function private.record_enrolment_stats();
create trigger enrolments_stats_delete after delete on automation.enrolments
  for each row execute function private.record_enrolment_stats();

create trigger step_runs_stats_insert after insert on automation.step_runs
  for each row execute function private.record_step_stats();
create trigger step_runs_stats_update after update of status on automation.step_runs
  for each row when (old.status is distinct from new.status)
  execute function private.record_step_stats();
create trigger step_runs_stats_delete after delete on automation.step_runs
  for each row execute function private.record_step_stats();

-- What the counters should say, counted from the rows themselves: the reconciliation the
-- tests hold the counters to, and what an operator runs to check an install. It crosses
-- businesses and names step keys, so the application's role is not given it.
create function private.automation_stat_truth()
returns table (business_id uuid, version_id uuid, automation_id uuid, scope text, key text,
               metric text, n bigint)
language sql stable security definer set search_path = ''
as $$
  select e.business_id, e.version_id, e.automation_id, 'run', '', 'enrolled', count(*)
  from automation.enrolments e group by e.business_id, e.version_id, e.automation_id
  union all
  select e.business_id, e.version_id, e.automation_id, 'run', '', e.status, count(*)
  from automation.enrolments e group by e.business_id, e.version_id, e.automation_id, e.status
  union all
  select e.business_id, e.version_id, e.automation_id, 'trigger', e.trigger_key, 'enrolled', count(*)
  from automation.enrolments e where e.trigger_key is not null
  group by e.business_id, e.version_id, e.automation_id, e.trigger_key
  union all
  select s.business_id, s.version_id, s.automation_id, 'step', s.step_key,
         case when s.resumes then 'resumed' else 'entered' end, count(*)
  from automation.step_runs s
  group by s.business_id, s.version_id, s.automation_id, s.step_key, s.resumes
  union all
  select s.business_id, s.version_id, s.automation_id, 'step', s.step_key, s.status, count(*)
  from automation.step_runs s
  group by s.business_id, s.version_id, s.automation_id, s.step_key, s.status
$$;
revoke execute on function private.automation_stat_truth() from public;

-- Every counter that differs from the rows; none, when the counters are right.
create function private.automation_stat_differences()
returns table (business_id uuid, version_id uuid, scope text, key text, metric text,
               counted bigint, actual bigint)
language sql stable security definer set search_path = ''
as $$
  with counted as (
    select c.business_id, c.version_id, c.scope, c.key, c.metric, sum(c.n)::bigint as n
    from (
      select business_id, version_id, scope, key, metric, n from automation.stat_counts
      union all
      select business_id, version_id, scope, key, metric, n::bigint from automation.stat_deltas
    ) c
    group by c.business_id, c.version_id, c.scope, c.key, c.metric
  )
  select coalesce(c.business_id, t.business_id), coalesce(c.version_id, t.version_id),
         coalesce(c.scope, t.scope), coalesce(c.key, t.key), coalesce(c.metric, t.metric),
         coalesce(c.n, 0), coalesce(t.n, 0)
  from counted c
  full join private.automation_stat_truth() t
    on t.business_id = c.business_id and t.version_id = c.version_id and t.scope = c.scope
   and t.key = c.key and t.metric = c.metric
  where coalesce(c.n, 0) <> coalesce(t.n, 0)
$$;
revoke execute on function private.automation_stat_differences() from public;

-- The counters start equal to the rows. Altering both tables above locked them until this
-- migration commits, so nothing is written between the count and the commit.
insert into automation.stat_counts (business_id, version_id, automation_id, scope, key, metric, n)
select business_id, version_id, automation_id, scope, key, metric, n
from private.automation_stat_truth();

-- Folds what the triggers wrote into the counters, and gives how many rows it folded. It
-- takes a share of each automation's key first and skips one it can't have at once: an
-- automation being deleted is left to its delete, which removes its counters anyway, and
-- one this holds can't be deleted until the fold commits, so neither waits on the other.
create function private.compact_automation_stats(p_limit integer) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_folded integer;
begin
  with pending as (
    select distinct d.business_id, d.automation_id
    from (
      select business_id, automation_id from automation.stat_deltas
      limit least(greatest(p_limit, 1), 100000)
    ) d
  ),
  held as (
    select a.business_id, a.id
    from automation.automations a
    join pending p on p.business_id = a.business_id and p.automation_id = a.id
    order by a.business_id, a.id
    for key share of a skip locked
  ),
  taken as (
    delete from automation.stat_deltas d
    using held h
    where d.business_id = h.business_id and d.automation_id = h.id
    returning d.business_id, d.version_id, d.automation_id, d.scope, d.key, d.metric, d.n
  ),
  summed as (
    select business_id, version_id, automation_id, scope, key, metric,
           sum(n) as n, count(*) as folded
    from taken
    group by business_id, version_id, automation_id, scope, key, metric
  ),
  written as (
    insert into automation.stat_counts (business_id, version_id, automation_id, scope, key, metric, n)
    select business_id, version_id, automation_id, scope, key, metric, n from summed
    on conflict (business_id, version_id, scope, key, metric)
      do update set n = automation.stat_counts.n + excluded.n
    returning 1
  )
  select coalesce(sum(folded), 0)::integer into v_folded from summed;
  return v_folded;
end
$$;
revoke execute on function private.compact_automation_stats(integer) from public;
grant execute on function private.compact_automation_stats(integer) to crm_app;
