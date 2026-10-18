-- The shared rate limiter for the public, unauthenticated booking endpoints
-- (tasks/public-intake-rate-limit.md). Every app instance asks the same database, so a
-- client gets one quota however many instances answer it. A public request has no tenant
-- context, so nothing here is tenant data and row-level security can't scope it: the
-- tables are closed to every runtime role, and one narrow function is the only way in.

-- One row per client, never one per request. The key is an HMAC-SHA256 of the client's
-- address, made by the server with a secret the database never sees: no address, path,
-- token or contact detail is stored, and nothing here can be turned back into an address
-- without that secret. A row counts for the minute in window_start only; older rows mean
-- nothing and are deleted a few at a time by the function.
create table intake.public_rate_limit_clients (
  client_digest bytea primary key
    constraint public_rate_limit_clients_digest_length check (octet_length(client_digest) = 32),
  window_start timestamptz not null,
  reads integer not null constraint public_rate_limit_clients_reads_range check (reads >= 0),
  writes integer not null constraint public_rate_limit_clients_writes_range check (writes >= 0)
);
-- Finds expired rows, oldest first, without reading the rows that still count.
create index public_rate_limit_clients_window_idx
  on intake.public_rate_limit_clients (window_start);

-- The install-wide counts for the current minute, in exactly one row. Its row lock is what
-- orders admissions across app instances. full_window is the minute in which the client
-- table was found full of rows that still count, so new clients can be refused for the
-- rest of that minute without taking the lock.
create table intake.public_rate_limit_totals (
  singleton boolean primary key default true
    constraint public_rate_limit_totals_one_row check (singleton),
  window_start timestamptz not null,
  reads integer not null constraint public_rate_limit_totals_reads_range check (reads >= 0),
  writes integer not null constraint public_rate_limit_totals_writes_range check (writes >= 0),
  full_window timestamptz
);
insert into intake.public_rate_limit_totals (window_start, reads, writes)
values ('epoch', 0, 0);

-- Closed to every runtime role: no grant, and a policy that matches no row. crm_owner
-- bypasses row-level security, which is how the function below reaches them.
alter table intake.public_rate_limit_clients enable row level security;
alter table intake.public_rate_limit_clients force row level security;
create policy limiter_function_only on intake.public_rate_limit_clients
  using (false) with check (false);
alter table intake.public_rate_limit_totals enable row level security;
alter table intake.public_rate_limit_totals force row level security;
create policy limiter_function_only on intake.public_rate_limit_totals
  using (false) with check (false);

-- Decides one public request, and counts it when it is admitted. The caller supplies only
-- which kind of request it is and the client's digest; the limits, the clock and the
-- tables are fixed here, and there is no dynamic SQL.
--
-- Fixed one-minute windows on the database's clock, so every app instance agrees on them.
-- A request is refused, in this order, when its client is at its own quota, when the
-- install is at its global ceiling, or when the client table is full and the client has
-- no row. A request refused by the ceiling or the full table changes no counter, and a
-- client over its own quota never counts toward the ceiling.
--
-- Admission happens only under the totals row's lock, after reading both rows again, so
-- two instances can't both admit the request that crosses a limit: the second waits for
-- the first to commit and then sees its count. The first pass below takes no lock and can
-- only refuse; what it refuses on can't become false before the minute ends, because
-- counts only grow within a minute. So a flood from one address, or against a full
-- ceiling, costs two primary-key reads a request and writes nothing.
--
-- Work per call is bounded whatever the caller does: at most c_cleanup_batch deletes, one
-- count of at most c_max_clients rows (only for a client with no row), and two writes. A
-- lock wait ends after one second, as an error: the caller refuses the request.
create function private.admit_public_intake(
  p_operation text,
  p_client_digest bytea,
  out allowed boolean,
  out retry_after_seconds integer,
  out reason text
)
language plpgsql security definer set search_path = '' set lock_timeout = '1s'
as $$
declare
  -- Per client and minute.
  c_client_reads constant integer := 120;
  c_client_writes constant integer := 10;
  -- All clients together, per minute: fifty times one client's quota.
  c_global_reads constant integer := 6000;
  c_global_writes constant integer := 500;
  -- The most client rows ever stored, and the most expired rows one call deletes.
  c_max_clients constant integer := 4096;
  c_cleanup_batch constant integer := 8;
  v_is_read boolean;
  v_locked boolean;
  v_now timestamptz;
  v_window timestamptz;
  v_has_row boolean;
  v_current boolean;
  v_client_window timestamptz;
  v_client_reads integer;
  v_client_writes integer;
  v_total_window timestamptz;
  v_total_reads integer;
  v_total_writes integer;
  v_full_window timestamptz;
  v_deleted integer;
  v_rows bigint;
begin
  if p_operation is null or p_operation not in ('read', 'write') then
    raise exception 'the operation must be read or write' using errcode = '22023';
  end if;
  if p_client_digest is null or octet_length(p_client_digest) <> 32 then
    raise exception 'the client digest must be 32 bytes' using errcode = '22023';
  end if;
  v_is_read := p_operation = 'read';

  -- Pass 1 reads without a lock and can only refuse. Pass 2 holds the lock, so what it
  -- reads is what it decides on.
  for v_pass in 1..2 loop
    if v_pass = 2 then
      select t.singleton into v_locked from intake.public_rate_limit_totals t for update;
    end if;
    -- Read after the lock: a call that waited across a minute's end belongs to the new one.
    v_now := clock_timestamp();
    v_window := date_trunc('minute', v_now, 'UTC');
    retry_after_seconds := least(60, greatest(1,
      ceil(extract(epoch from (v_window + interval '1 minute' - v_now)))::integer));

    select t.window_start, t.reads, t.writes, t.full_window
      into v_total_window, v_total_reads, v_total_writes, v_full_window
    from intake.public_rate_limit_totals t;
    if not found then
      raise exception 'the public intake totals row is missing';
    end if;
    -- A window later than the clock's (the clock stepped back) keeps counting: stricter.
    if v_total_window < v_window then
      v_total_window := v_window;
      v_total_reads := 0;
      v_total_writes := 0;
    end if;

    select c.window_start, c.reads, c.writes
      into v_client_window, v_client_reads, v_client_writes
    from intake.public_rate_limit_clients c
    where c.client_digest = p_client_digest;
    v_has_row := found;
    v_current := v_has_row and v_client_window >= v_window;
    if not v_current then
      v_client_window := v_window;
      v_client_reads := 0;
      v_client_writes := 0;
    end if;

    if (v_is_read and v_client_reads >= c_client_reads)
       or (not v_is_read and v_client_writes >= c_client_writes) then
      allowed := false;
      reason := 'client_quota';
      return;
    end if;
    if (v_is_read and v_total_reads >= c_global_reads)
       or (not v_is_read and v_total_writes >= c_global_writes) then
      allowed := false;
      reason := 'global_ceiling';
      return;
    end if;
    if not v_current and v_full_window is not null and v_full_window >= v_window then
      allowed := false;
      reason := 'storage_full';
      return;
    end if;
  end loop;

  -- Bounded cleanup, oldest first. The caller's own expired row is reused below instead.
  delete from intake.public_rate_limit_clients c
  where c.client_digest in (
    select e.client_digest
    from intake.public_rate_limit_clients e
    where e.window_start < v_window and e.client_digest <> p_client_digest
    order by e.window_start
    limit c_cleanup_batch
  );
  get diagnostics v_deleted = row_count;

  -- Only a client with no row would add one. At the cap it is refused, never inserted.
  if not v_has_row then
    select count(*) into v_rows from intake.public_rate_limit_clients;
    if v_rows >= c_max_clients then
      -- Nothing was expired, so every row counts until the minute ends: say so once, and
      -- later new clients are refused in pass 1.
      if v_deleted = 0 then
        update intake.public_rate_limit_totals set full_window = v_window;
      end if;
      allowed := false;
      reason := 'storage_full';
      return;
    end if;
  end if;

  if v_is_read then
    v_client_reads := v_client_reads + 1;
    v_total_reads := v_total_reads + 1;
  else
    v_client_writes := v_client_writes + 1;
    v_total_writes := v_total_writes + 1;
  end if;
  insert into intake.public_rate_limit_clients (client_digest, window_start, reads, writes)
  values (p_client_digest, v_client_window, v_client_reads, v_client_writes)
  on conflict (client_digest) do update
    set window_start = excluded.window_start, reads = excluded.reads, writes = excluded.writes;
  update intake.public_rate_limit_totals
  set window_start = v_total_window, reads = v_total_reads, writes = v_total_writes;

  allowed := true;
  retry_after_seconds := 0;
  reason := 'admitted';
end
$$;
revoke execute on function private.admit_public_intake(text, bytea) from public;
grant execute on function private.admit_public_intake(text, bytea) to crm_app;
