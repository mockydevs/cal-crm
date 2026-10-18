-- A mailbox has at most one pending run. queued_at bounds recovery without changing
-- the historical start time; Graphile's mailbox queue serializes recovered copies.
alter table messaging.mailbox_check_runs add column queued_at timestamptz not null default now();
create unique index mailbox_check_runs_one_pending_idx
  on messaging.mailbox_check_runs (business_id, mailbox_id) where finished_at is null;
create index mailboxes_setup_due_idx on messaging.mailboxes (setup_checked_at, business_id, id);

create function private.due_mailbox_checks(p_limit integer)
returns table (agency_id uuid, business_id uuid, mailbox_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, m.business_id, m.id
  from messaging.mailboxes m
  join messaging.channel_accounts c on c.business_id = m.business_id and c.id = m.id
  join tenancy.businesses b on b.id = m.business_id
  where c.status = 'active' and b.status = 'active'
    and (
      ( (m.setup_checked_at is null or m.setup_checked_at <= now() - interval '1 day')
        and not exists (
          select 1 from messaging.mailbox_check_runs r
          where r.business_id=m.business_id and r.mailbox_id=m.id and r.finished_at is null
        ) )
      or exists (
        select 1 from messaging.mailbox_check_runs r
        where r.business_id=m.business_id and r.mailbox_id=m.id and r.finished_at is null
          and r.queued_at <= now() - interval '10 minutes'
      )
    )
  order by m.setup_checked_at nulls first, m.business_id, m.id
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function private.due_mailbox_checks(integer) from public;
grant execute on function private.due_mailbox_checks(integer) to crm_app;

-- The caller supplies only a tenant-visible unfinished run. Scope comes from the
-- transaction; it cannot choose another tenant or place credentials in the payload.
create function private.enqueue_mailbox_check(p_run_id uuid, p_causation_id uuid default null)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_mailbox_id uuid;
  v_job_id bigint;
begin
  select r.mailbox_id into v_mailbox_id
  from messaging.mailbox_check_runs r
  join tenancy.businesses b on b.id=r.business_id
  where r.id=p_run_id and r.business_id=app.business_id() and b.agency_id=app.agency_id()
    and r.finished_at is null;
  if v_mailbox_id is null then
    raise exception 'mailbox check is not available in this context';
  end if;
  select job.id into v_job_id from graphile_worker.add_job(
    'mailboxes.check',
    payload := jsonb_build_object(
      'agencyId', app.agency_id(), 'businessId', app.business_id(),
      'correlationId', app.correlation_id(), 'causationId', p_causation_id,
      'data', jsonb_build_object('runId', p_run_id)
    )::json,
    queue_name := 'mailbox-check:' || v_mailbox_id::text,
    job_key := 'mailbox-check:' || p_run_id::text,
    job_key_mode := 'preserve_run_at'
  ) as job;
  update messaging.mailbox_check_runs set queued_at=now()
    where business_id=app.business_id() and id=p_run_id;
  return v_job_id;
end
$$;
revoke execute on function private.enqueue_mailbox_check(uuid, uuid) from public;
grant execute on function private.enqueue_mailbox_check(uuid, uuid) to crm_app;
