-- Foundation: request-context functions, shared helpers, partition maintenance.
-- Runs as crm_owner.

create schema app;      -- reads the per-transaction request context
create schema util;     -- helpers used by migrations and triggers
create schema private;  -- SECURITY DEFINER functions; EXECUTE is granted one by one

-- Request context -------------------------------------------------------------------
-- Every transaction from the API or a worker starts with
--   select set_config('app.agency_id', $1, true), set_config('app.business_id', $2, true), ...
-- (is_local = true, so it is safe behind transaction-mode connection pooling).
-- An unset value reads as NULL, and NULL never equals a tenant id, so every
-- row-level security policy fails closed when the context is missing.

create function app.agency_id() returns uuid
language sql stable parallel safe
as $$ select nullif(current_setting('app.agency_id', true), '')::uuid $$;

create function app.business_id() returns uuid
language sql stable parallel safe
as $$ select nullif(current_setting('app.business_id', true), '')::uuid $$;

create function app.user_id() returns uuid
language sql stable parallel safe
as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

-- Who is acting: user, ai_agent, automation, api_key, system, contact, form or import.
create function app.actor_kind() returns text
language sql stable parallel safe
as $$ select nullif(current_setting('app.actor_kind', true), '') $$;

create function app.actor_id() returns uuid
language sql stable parallel safe
as $$ select nullif(current_setting('app.actor_id', true), '')::uuid $$;

create function app.correlation_id() returns uuid
language sql stable parallel safe
as $$ select nullif(current_setting('app.correlation_id', true), '')::uuid $$;

create function app.require_business_id() returns uuid
language plpgsql stable
as $$
declare
  v_business_id uuid := app.business_id();
begin
  if v_business_id is null then
    raise exception 'app.business_id is not set for this transaction'
      using errcode = 'insufficient_privilege';
  end if;
  return v_business_id;
end
$$;

-- Shared trigger: updated_at always reflects the last write -------------------------

create function util.touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create procedure util.add_updated_at_trigger(p_table regclass)
language plpgsql
as $$
begin
  execute format(
    'create trigger touch_updated_at before update on %s
       for each row execute function util.touch_updated_at()', p_table);
end
$$;

-- Row-level security, three shapes --------------------------------------------------
-- Policies wrap the context functions in (select ...) so Postgres evaluates them once
-- per statement, not once per row.

-- Business-owned rows: visible only inside that business.
create procedure util.enable_tenant_rls(p_table regclass)
language plpgsql
as $$
begin
  execute format('alter table %s enable row level security', p_table);
  execute format('alter table %s force row level security', p_table);
  execute format(
    'create policy tenant_isolation on %s
       using (business_id = (select app.business_id()))
       with check (business_id = (select app.business_id()))', p_table);
end
$$;

-- Rows owned by an agency, optionally narrowed to one of its businesses (secrets, files,
-- memberships, AI keys). Inside a business: the agency's shared rows plus that business's
-- own. At agency level (no business selected): all of the agency's rows.
create procedure util.enable_scoped_rls(p_table regclass)
language plpgsql
as $$
begin
  execute format('alter table %s enable row level security', p_table);
  execute format('alter table %s force row level security', p_table);
  execute format(
    'create policy scoped_isolation on %s
       using (
         agency_id = (select app.agency_id())
         and ((select app.business_id()) is null
              or business_id is null
              or business_id = (select app.business_id())))
       with check (
         agency_id = (select app.agency_id())
         and ((select app.business_id()) is null
              or business_id is null
              or business_id = (select app.business_id())))', p_table);
end
$$;

-- Rows that belong to the agency as a whole (roles, agency settings).
create procedure util.enable_agency_rls(p_table regclass)
language plpgsql
as $$
begin
  execute format('alter table %s enable row level security', p_table);
  execute format('alter table %s force row level security', p_table);
  execute format(
    'create policy agency_isolation on %s
       using (agency_id = (select app.agency_id()))
       with check (agency_id = (select app.agency_id()))', p_table);
end
$$;

-- Monthly partitions ------------------------------------------------------------------
-- Append-only logs (events, timeline, automation step runs, audit) are partitioned by
-- the month they were recorded in, so old months can be archived or dropped whole.
-- There is no DEFAULT partition on purpose: a missing partition is a loud error, and the
-- worker creates partitions months ahead (private.maintain_partitions).

create function util.ensure_monthly_partitions(
  p_parent regclass,
  p_months_back integer,
  p_months_ahead integer
) returns integer
language plpgsql
as $$
declare
  v_schema text;
  v_table text;
  v_month date;
  v_name text;
  v_created integer := 0;
begin
  select n.nspname, c.relname
    into strict v_schema, v_table
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.oid = p_parent and c.relkind = 'p';

  for i in -p_months_back .. p_months_ahead loop
    v_month := (date_trunc('month', now() at time zone 'UTC') + make_interval(months => i))::date;
    v_name := v_table || '_p' || to_char(v_month, 'YYYY_MM');
    if to_regclass(format('%I.%I', v_schema, v_name)) is null then
      execute format(
        'create table %I.%I partition of %s for values from (%L) to (%L)',
        v_schema, v_name, p_parent,
        v_month::timestamp at time zone 'UTC',
        (v_month + interval '1 month')::timestamp at time zone 'UTC');
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end
$$;

-- Drops whole months recorded before p_before. Used by retention jobs; the default
-- install keeps everything.
create function util.drop_monthly_partitions_before(p_parent regclass, p_before date)
returns integer
language plpgsql
as $$
declare
  v_partition record;
  v_dropped integer := 0;
begin
  for v_partition in
    select child.oid::regclass as partition,
           to_date(substring(child.relname from '_p(\d{4}_\d{2})$'), 'YYYY_MM') as month
    from pg_catalog.pg_inherits i
    join pg_catalog.pg_class child on child.oid = i.inhrelid
    where i.inhparent = p_parent
  loop
    if v_partition.month is not null and v_partition.month < date_trunc('month', p_before)::date then
      execute format('drop table %s', v_partition.partition);
      v_dropped := v_dropped + 1;
    end if;
  end loop;
  return v_dropped;
end
$$;
