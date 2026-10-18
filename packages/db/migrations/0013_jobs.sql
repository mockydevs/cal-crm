-- The job queue: Graphile Worker (ADR-007). Graphile Worker installs and upgrades its own
-- tables and functions in the graphile_worker schema: the migrate command runs its
-- migrations, as crm_owner, after these files (src/migrate-database.ts). The schema is
-- created here first, so that whatever Graphile Worker installs in it is usable by the
-- worker's role through default privileges.

create schema graphile_worker;

-- crm_worker is the worker's connection to the queue: it fetches, locks, completes and
-- retries jobs, and keeps the cron schedule. It reaches this schema and nothing else; the
-- work itself runs as crm_app, inside the job's tenant context.
grant usage on schema graphile_worker to crm_worker;
alter default privileges for role crm_owner in schema graphile_worker
  grant select, insert, update, delete on tables to crm_worker;
alter default privileges for role crm_owner in schema graphile_worker
  grant usage, select on sequences to crm_worker;
alter default privileges for role crm_owner in schema graphile_worker
  grant execute on functions to crm_worker;

-- crm_app adds a job only through this function, from a transaction with a tenant
-- context. The job carries that context, so the worker runs it in the same agency and
-- business, under the same correlation id. graphile_worker.add_job needs the owner's
-- rights, and plpgsql resolves it at run time: it's installed after this migration.
create function private.enqueue_job(p_task text, p_data jsonb) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_agency_id uuid := app.agency_id();
  v_job_id bigint;
begin
  if v_agency_id is null then
    raise exception 'a job needs a tenant context';
  end if;
  if p_task is null or p_task !~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$' then
    raise exception '"%" isn''t a task name: use two or more dotted parts, such as tag.created',
      p_task;
  end if;

  select job.id into v_job_id
  from graphile_worker.add_job(
    p_task,
    payload := jsonb_build_object(
      'agencyId', v_agency_id,
      'businessId', app.business_id(),
      'correlationId', app.correlation_id(),
      'data', coalesce(p_data, '{}'::jsonb)
    )::json
  ) as job;
  return v_job_id;
end
$$;

grant execute on function private.enqueue_job(text, jsonb) to crm_app;
