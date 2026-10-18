-- Jobs carry their cause (task P1.23, ADR-021): the event behind each job, which the worker
-- passes on to the commands the job runs, so their events point at it and "Why?" can
-- follow the chain through background work. Otherwise as 0013's enqueue_job.
drop function private.enqueue_job(text, jsonb);

create function private.enqueue_job(
  p_task text, p_data jsonb, p_causation_id uuid default null
) returns bigint
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
      'causationId', p_causation_id,
      'data', coalesce(p_data, '{}'::jsonb)
    )::json
  ) as job;
  return v_job_id;
end
$$;

revoke execute on function private.enqueue_job(text, jsonb, uuid) from public;
grant execute on function private.enqueue_job(text, jsonb, uuid) to crm_app;
