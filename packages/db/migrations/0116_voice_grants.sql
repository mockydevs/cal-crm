-- A person's browser asks for a calling token, and only the worker can sign one: the API
-- key's secret opens in the worker alone. A request waits here for the worker, which writes
-- the token, which only the person who asked can read, until it expires and maintenance
-- clears it. A restrictive policy narrows tenant isolation to that person, or the worker.
create table messaging.voice_grants (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The Twilio account the token is for; calling must be set up on it.
  connection_id uuid not null,
  status text not null default 'requested' constraint voice_grants_status_valid
    check (status in ('requested', 'issued', 'failed')),
  token text constraint voice_grants_token_length check (length(token) between 1 and 4096),
  token_expires_at timestamptz,
  failure_code text constraint voice_grants_failure_valid
    check (failure_code in ('expired', 'member_unavailable', 'not_set_up', 'key_unreadable')),
  requested_at timestamptz not null default now(),
  -- A request the worker has not answered by then fails as expired.
  expires_at timestamptz not null default now() + interval '2 minutes',
  issued_at timestamptz,
  primary key (business_id, id),
  constraint voice_grants_setup foreign key (business_id, connection_id)
    references messaging.voice_setups (business_id, connection_id) on delete cascade,
  constraint voice_grants_state_consistent check (
    (status = 'requested' and token is null and token_expires_at is null
      and failure_code is null and issued_at is null)
    -- Maintenance clears an issued token once it expires.
    or (status = 'issued' and token_expires_at is not null and failure_code is null
      and issued_at is not null)
    or (status = 'failed' and token is null and token_expires_at is null
      and failure_code is not null and issued_at is null)
  ),
  constraint voice_grants_expiry_after_request check (expires_at > requested_at)
);
create index voice_grants_user_idx on messaging.voice_grants (user_id);
create index voice_grants_connection_idx on messaging.voice_grants (business_id, connection_id);
create index voice_grants_requested_idx on messaging.voice_grants (requested_at, business_id, id);
call util.enable_tenant_rls('messaging.voice_grants');
grant select, insert, update on messaging.voice_grants to crm_app;

-- The person's own, or the worker's: the same rule for reading and for writing, so nobody
-- reads another person's token or plants a request in their name.
create policy own_or_worker on messaging.voice_grants
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

-- Maintenance, across businesses: clears tokens that have expired, and deletes requests
-- older than a day. Returns how many rows it changed. A row another transaction holds is
-- left for the next run, so this never waits.
create function private.expire_voice_grants(p_limit integer)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_cleared integer;
  v_deleted integer;
begin
  with due as (
    select business_id, id from messaging.voice_grants
    where status = 'issued' and token is not null and token_expires_at <= now()
    order by token_expires_at
    limit least(greatest(p_limit, 1), 10000)
    for update skip locked
  )
  update messaging.voice_grants g set token = null
  from due where g.business_id = due.business_id and g.id = due.id;
  get diagnostics v_cleared = row_count;
  with old as (
    select business_id, id from messaging.voice_grants
    where requested_at <= now() - interval '1 day'
    order by requested_at
    limit least(greatest(p_limit, 1), 10000)
    for update skip locked
  )
  delete from messaging.voice_grants g
  using old where g.business_id = old.business_id and g.id = old.id;
  get diagnostics v_deleted = row_count;
  return v_cleared + v_deleted;
end
$$;
revoke execute on function private.expire_voice_grants(integer) from public;
grant execute on function private.expire_voice_grants(integer) to crm_app;
