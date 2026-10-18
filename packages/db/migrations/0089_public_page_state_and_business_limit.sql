-- Speed and reliability of what the public reaches (tasks/sites-completion-plan.md, "Speed
-- and reliability standards"). Two functions, no new table and no tenant data:
--
-- 1. private.site_page_state: everything a published page of a site is rendered from, as
--    one value read in one statement, so the server can tell that the page it already
--    rendered is still the page, without reading the page again (ADR-077, addendum of 2026-10-13).
-- 2. private.admit_public_intake with a third argument: a ceiling for each business beside
--    the ones for each address and for the whole install, so a flood on one business's
--    form or funnel is refused there and never uses up what the others share.

-- What a site's pages are rendered from, for the site a public key names, and only for a
-- key of the right shape and an active business (as private.resolve_site, 0085):
--   - the site's kind and favicon;
--   - every step: its name, path and position, its control page and that page's
--     published version (a version's document is written once and never rewritten, 0070,
--     so its number names its content);
--   - of the saved sections asked about, the ones the site may use, each by its revision
--     and the moment of its last change (the trigger of 0001 sets that on every update,
--     whoever writes);
--   - of the forms asked about, the ones not archived, each by its public key and whether
--     it is published;
--   - the site's own response headers.
-- The caller says which saved sections and forms the page it holds refers to; a page it
-- has not rendered yet has none to ask about. The value is text to be compared, nothing
-- more: equal text means the same page would be rendered. Read by the sites module, which
-- reads the page itself under row-level security, in that business, when it has to.
create function private.site_page_state(
  p_public_key text,
  p_section_ids uuid[],
  p_form_ids uuid[]
)
returns table (agency_id uuid, business_id uuid, site_id uuid, state text)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, s.business_id, s.id,
    jsonb_build_array(
      s.kind,
      s.favicon_url,
      (select coalesce(jsonb_agg(
                jsonb_build_array(t.id, t.name, t.path, t.position, p.id, p.published_version)
                order by t.position, t.id), '[]'::jsonb)
       from sites.steps t
       join sites.pages p
         on p.business_id = t.business_id and p.step_id = t.id and p.role = 'control'
       where t.business_id = s.business_id and t.site_id = s.id),
      (select coalesce(jsonb_agg(
                jsonb_build_array(c.id, c.revision, c.updated_at) order by c.id), '[]'::jsonb)
       from sites.saved_sections c
       where c.business_id = s.business_id
         and c.id = any (p_section_ids)
         and (c.site_id is null or c.site_id = s.id)),
      (select coalesce(jsonb_agg(
                jsonb_build_array(f.id, f.public_key, f.status = 'published') order by f.id),
                '[]'::jsonb)
       from forms.forms f
       where f.business_id = s.business_id
         and f.id = any (p_form_ids)
         and f.status <> 'archived'),
      (select coalesce(jsonb_agg(
                jsonb_build_array(h.name_normalized, h.value) order by h.name_normalized),
                '[]'::jsonb)
       from sites.security_headers h
       where h.business_id = s.business_id and h.site_id = s.id)
    )::text
  from sites.sites s
  join tenancy.businesses b on b.id = s.business_id
  where s.public_key = p_public_key
    and p_public_key ~ '^[a-z0-9]{24,64}$'
    and b.status = 'active'
$$;
revoke execute on function private.site_page_state(text, uuid[], uuid[]) from public;
grant execute on function private.site_page_state(text, uuid[], uuid[]) to crm_app;

-- The limiter of 0042, with one more ceiling: the business a request is for.
--
-- The server passes a second keyed digest, of the business, once it knows which business a
-- form key or a site key belongs to (it learns that from the first request it admits for
-- the key, and passes null until then, and for anything that names no business). The
-- database never sees a business here, as it never sees an address: the digest is counted
-- in a row of the same table the clients' digests are, under a different label, so the two
-- cannot meet, and the table's bound and its cleanup cover both.
--
-- A request is refused, in this order, when its client is at its own quota, when its
-- business is at the business's, when the install is at its ceiling, or when the table is
-- full and a row would have to be added. Only an admitted request is counted, so a
-- business at its ceiling adds nothing to the install's count: its flood stops at its own
-- ceiling, a fifth of the install's, and the rest stays for everyone else. Everything else
-- is as in 0042: fixed minutes on the database's clock, a first pass without a lock that
-- can only refuse, admission under the totals row's lock, bounded work, and a lock wait of
-- one second at most.
create function private.admit_public_intake(
  p_operation text,
  p_client_digest bytea,
  p_scope_digest bytea,
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
  -- Per business and minute: ten clients' worth, and a fifth of the install's.
  c_scope_reads constant integer := 1200;
  c_scope_writes constant integer := 100;
  -- All clients together, per minute: fifty times one client's quota.
  c_global_reads constant integer := 6000;
  c_global_writes constant integer := 500;
  -- The most rows ever stored, and the most expired rows one call deletes.
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
  v_scope_has_row boolean := true;
  v_scope_current boolean := true;
  v_scope_window timestamptz;
  v_scope_reads integer := 0;
  v_scope_writes integer := 0;
  v_total_window timestamptz;
  v_total_reads integer;
  v_total_writes integer;
  v_full_window timestamptz;
  v_deleted integer;
  v_rows bigint;
  v_new_rows integer;
begin
  if p_operation is null or p_operation not in ('read', 'write') then
    raise exception 'the operation must be read or write' using errcode = '22023';
  end if;
  if p_client_digest is null or octet_length(p_client_digest) <> 32 then
    raise exception 'the client digest must be 32 bytes' using errcode = '22023';
  end if;
  if p_scope_digest is not null and octet_length(p_scope_digest) <> 32 then
    raise exception 'the scope digest must be 32 bytes' using errcode = '22023';
  end if;
  if p_scope_digest = p_client_digest then
    raise exception 'the scope digest must not be the client digest' using errcode = '22023';
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

    if p_scope_digest is not null then
      select c.window_start, c.reads, c.writes
        into v_scope_window, v_scope_reads, v_scope_writes
      from intake.public_rate_limit_clients c
      where c.client_digest = p_scope_digest;
      v_scope_has_row := found;
      v_scope_current := v_scope_has_row and v_scope_window >= v_window;
      if not v_scope_current then
        v_scope_window := v_window;
        v_scope_reads := 0;
        v_scope_writes := 0;
      end if;
    end if;

    if (v_is_read and v_client_reads >= c_client_reads)
       or (not v_is_read and v_client_writes >= c_client_writes) then
      allowed := false;
      reason := 'client_quota';
      return;
    end if;
    if p_scope_digest is not null
       and ((v_is_read and v_scope_reads >= c_scope_reads)
            or (not v_is_read and v_scope_writes >= c_scope_writes)) then
      allowed := false;
      reason := 'scope_quota';
      return;
    end if;
    if (v_is_read and v_total_reads >= c_global_reads)
       or (not v_is_read and v_total_writes >= c_global_writes) then
      allowed := false;
      reason := 'global_ceiling';
      return;
    end if;
    if (not v_current or not v_scope_current)
       and v_full_window is not null and v_full_window >= v_window then
      allowed := false;
      reason := 'storage_full';
      return;
    end if;
  end loop;

  -- Bounded cleanup, oldest first. The caller's own expired rows are reused below instead.
  delete from intake.public_rate_limit_clients c
  where c.client_digest in (
    select e.client_digest
    from intake.public_rate_limit_clients e
    where e.window_start < v_window
      and e.client_digest <> p_client_digest
      and e.client_digest is distinct from p_scope_digest
    order by e.window_start
    limit c_cleanup_batch
  );
  get diagnostics v_deleted = row_count;

  -- Only a digest with no row would add one. At the cap it is refused, never inserted.
  v_new_rows := (not v_has_row)::integer + (not v_scope_has_row)::integer;
  if v_new_rows > 0 then
    select count(*) into v_rows from intake.public_rate_limit_clients;
    if v_rows + v_new_rows > c_max_clients then
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
    v_scope_reads := v_scope_reads + 1;
    v_total_reads := v_total_reads + 1;
  else
    v_client_writes := v_client_writes + 1;
    v_scope_writes := v_scope_writes + 1;
    v_total_writes := v_total_writes + 1;
  end if;
  insert into intake.public_rate_limit_clients (client_digest, window_start, reads, writes)
  values (p_client_digest, v_client_window, v_client_reads, v_client_writes)
  on conflict (client_digest) do update
    set window_start = excluded.window_start, reads = excluded.reads, writes = excluded.writes;
  if p_scope_digest is not null then
    insert into intake.public_rate_limit_clients (client_digest, window_start, reads, writes)
    values (p_scope_digest, v_scope_window, v_scope_reads, v_scope_writes)
    on conflict (client_digest) do update
      set window_start = excluded.window_start, reads = excluded.reads, writes = excluded.writes;
  end if;
  update intake.public_rate_limit_totals
  set window_start = v_total_window, reads = v_total_reads, writes = v_total_writes;

  allowed := true;
  retry_after_seconds := 0;
  reason := 'admitted';
end
$$;
revoke execute on function private.admit_public_intake(text, bytea, bytea) from public;
grant execute on function private.admit_public_intake(text, bytea, bytea) to crm_app;

-- The two-argument form stays for a server of the release before this one, which runs
-- beside the new one while an install is upgraded. It is the same decision with no
-- business: one body, so the two can never count differently.
create or replace function private.admit_public_intake(
  p_operation text,
  p_client_digest bytea,
  out allowed boolean,
  out retry_after_seconds integer,
  out reason text
)
language sql security definer set search_path = ''
as $$
  select d.allowed, d.retry_after_seconds, d.reason
  from private.admit_public_intake(p_operation, p_client_digest, null::bytea) d
$$;
