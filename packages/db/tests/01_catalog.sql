-- Structural rules that every table must follow, checked against the system catalog.
-- They hold for tables added later too, so a migration that forgets row-level security,
-- an index or a grant fails here.

\set ON_ERROR_STOP on
set client_min_messages = notice;

create temporary table checked_schemas (name text primary key);
insert into checked_schemas values
  ('app'), ('util'), ('private'), ('tenancy'), ('auth'), ('vault'), ('files'), ('events'),
  ('crm'), ('messaging'), ('calendar'), ('forms'), ('automation'), ('ai'), ('audit'),
  ('intake'), ('imports'), ('reporting'), ('notifications'), ('sites'), ('commerce');

-- Tables with no row-level security, each with a reason where it's created:
--   intake.webhooks          the business isn't known yet when a webhook arrives (0011)
--   util.applied_migrations  the migration runner's record; no tenant data, and only
--                            crm_owner can reach it (src/migrate.ts)
-- Listed by name: the runner's table doesn't exist when validate.sh applies the
-- migrations with psql.
create temporary table rls_exempt (name text primary key);
insert into rls_exempt values ('intake.webhooks'), ('util.applied_migrations');

create temporary view checked_tables as
select c.oid, c.oid::regclass as name, n.nspname as schema_name, c.relname,
       format('%s.%s', n.nspname, c.relname) as qualified_name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and not c.relispartition
  and n.nspname in (select name from checked_schemas);

do $$
declare
  v_offenders text;
begin
  select string_agg(t.name::text, ', ') into v_offenders
  from checked_tables t
  where not exists (select 1 from pg_constraint k where k.conrelid = t.oid and k.contype = 'p');
  if v_offenders is not null then
    raise exception 'tables without a primary key: %', v_offenders;
  end if;
  raise notice 'ok: every table has a primary key';
end $$;

do $$
declare
  v_offenders text;
begin
  select string_agg(format('%s (%s)', c.oid::regclass, pg_get_userbyid(c.relowner)), ', ') into v_offenders
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in (select name from checked_schemas)
    and c.relkind in ('r', 'p', 'i', 'I', 'S', 'v', 'm')
    and pg_get_userbyid(c.relowner) <> 'crm_owner';
  if v_offenders is not null then
    raise exception 'objects not owned by crm_owner: %', v_offenders;
  end if;
  raise notice 'ok: crm_owner owns every table, index and view';
end $$;

do $$
declare
  v_offenders text;
begin
  select string_agg(t.name::text, ', ') into v_offenders
  from checked_tables t
  join pg_class c on c.oid = t.oid
  where t.qualified_name not in (select name from rls_exempt)
    and not (c.relrowsecurity and c.relforcerowsecurity
             and exists (select 1 from pg_policy p where p.polrelid = t.oid));
  if v_offenders is not null then
    raise exception 'tables without forced row-level security and a policy: %', v_offenders;
  end if;
  raise notice 'ok: row-level security is enabled, forced and has a policy on every table';
end $$;

-- The policy shape follows from the tenant columns, so one tested expression covers
-- every table of that shape.
do $$
declare
  v_offenders text;
  v_shapes integer;
begin
  with shaped as (
    select t.oid, t.name,
           exists (select 1 from pg_attribute a where a.attrelid = t.oid and a.attname = 'business_id' and not a.attisdropped) as has_business,
           exists (select 1 from pg_attribute a where a.attrelid = t.oid and a.attname = 'agency_id' and not a.attisdropped) as has_agency
    from checked_tables t
    where t.qualified_name not in (select name from rls_exempt)
  )
  select string_agg(format('%s (expected %s)', s.name, s.expected), ', ') into v_offenders
  from (
    select shaped.*,
           case
             when has_business and has_agency then 'scoped_isolation'
             when has_business then 'tenant_isolation'
             when has_agency then 'agency_isolation'
           end as expected
    from shaped
  ) s
  where s.expected is not null
    and not exists (select 1 from pg_policy p where p.polrelid = s.oid and p.polname = s.expected);
  if v_offenders is not null then
    raise exception 'tables with the wrong policy for their tenant columns: %', v_offenders;
  end if;

  select count(distinct pg_get_expr(p.polqual, p.polrelid) || '|' || pg_get_expr(p.polwithcheck, p.polrelid))
    into v_shapes
  from pg_policy p
  where p.polname = 'tenant_isolation';
  if v_shapes <> 1 then
    raise exception 'tenant_isolation policies differ between tables (% variants)', v_shapes;
  end if;

  select count(distinct pg_get_expr(p.polqual, p.polrelid) || '|' || pg_get_expr(p.polwithcheck, p.polrelid))
    into v_shapes
  from pg_policy p
  where p.polname = 'scoped_isolation';
  if v_shapes <> 1 then
    raise exception 'scoped_isolation policies differ between tables (% variants)', v_shapes;
  end if;
  raise notice 'ok: policies match each table''s tenant columns and are identical across tables';
end $$;

-- Saved views narrow tenant isolation with restrictive owner policies. They must
-- stay restrictive: a permissive one would widen access instead. 02 proves what they do.
do $$
begin
  if (select array_agg(format('%s %s %s', policyname, permissive, cmd) order by policyname)
      from pg_policies
      where schemaname = 'crm' and tablename = 'saved_views')
     is distinct from array['changeable_views RESTRICTIVE UPDATE',
                            'deletable_views RESTRICTIVE DELETE',
                            'own_new_views RESTRICTIVE INSERT',
                            'tenant_isolation PERMISSIVE ALL',
                            'visible_views RESTRICTIVE SELECT'] then
    raise exception 'crm.saved_views should have tenant_isolation and its restrictive owner and sharing policies';
  end if;
  -- Who a view is shared with by name is seen by those who see the view and written only
  -- by those who may change its sharing, one restrictive policy for each.
  if (select array_agg(format('%s %s %s', policyname, permissive, cmd) order by policyname)
      from pg_policies
      where schemaname = 'crm' and tablename = 'saved_view_shares')
     is distinct from array['added_by_view_editors RESTRICTIVE INSERT',
                            'changed_by_view_editors RESTRICTIVE UPDATE',
                            'of_visible_views RESTRICTIVE SELECT',
                            'removed_by_view_editors RESTRICTIVE DELETE',
                            'tenant_isolation PERMISSIVE ALL'] then
    raise exception 'crm.saved_view_shares should have tenant_isolation and its four restrictive policies';
  end if;
  raise notice 'ok: saved views keep tenant isolation and their restrictive owner policies';
end $$;

-- Notifications and a person's preferences for them narrow their isolation to that person
-- (0056), each with restrictive policies: a permissive one would widen access to
-- everyone in the business. crm_app may write one column of each and delete from neither.
do $$
declare
  v_offenders text;
begin
  if (select array_agg(format('%s %s %s', policyname, permissive, cmd) order by policyname)
      from pg_policies
      where schemaname = 'notifications' and tablename = 'notifications')
     is distinct from array['own_mark RESTRICTIVE UPDATE', 'own_or_worker RESTRICTIVE SELECT',
                            'scoped_isolation PERMISSIVE ALL', 'worker_writes RESTRICTIVE INSERT'] then
    raise exception 'notifications.notifications should have scoped_isolation and its three restrictive policies';
  end if;
  if (select array_agg(format('%s %s %s', policyname, permissive, cmd) order by policyname)
      from pg_policies
      where schemaname = 'notifications' and tablename = 'preferences')
     is distinct from array['own_insert RESTRICTIVE INSERT', 'own_or_worker RESTRICTIVE SELECT',
                            'own_update RESTRICTIVE UPDATE', 'tenant_isolation PERMISSIVE ALL'] then
    raise exception 'notifications.preferences should have tenant_isolation and its three restrictive policies';
  end if;
  select string_agg(format('%s.%s', c.table_name, c.column_name), ', '
                    order by c.table_name, c.column_name) into v_offenders
  from information_schema.columns c
  where c.table_schema = 'notifications'
    and has_column_privilege('crm_app', format('%I.%I', c.table_schema, c.table_name)::regclass,
                             c.column_name, 'update');
  if v_offenders is distinct from 'notifications.read_at, preferences.in_app, preferences.remind_minutes' then
    raise exception 'crm_app should update only read_at, in_app and remind_minutes in notifications, not: %', v_offenders;
  end if;
  if has_table_privilege('crm_app', 'notifications.notifications', 'delete')
     or has_table_privilege('crm_app', 'notifications.preferences', 'delete') then
    raise exception 'crm_app should not delete notifications or preferences';
  end if;
  raise notice 'ok: notifications and their preferences keep their restrictive owner policies and narrow grants';
end $$;

-- The in-app assistant's conversations are one person's (0084): each of the three
-- tables narrows tenant isolation with one restrictive policy for every command. A message
-- is written once, and a turn is never deleted by itself.
do $$
declare
  v_table text;
begin
  foreach v_table in array array['assistant_threads', 'assistant_turns', 'assistant_messages'] loop
    if (select array_agg(format('%s %s %s', policyname, permissive, cmd) order by policyname)
        from pg_policies
        where schemaname = 'ai' and tablename = v_table)
       is distinct from array['own_or_worker RESTRICTIVE ALL', 'tenant_isolation PERMISSIVE ALL'] then
      raise exception 'ai.% should have tenant_isolation and its restrictive owner policy', v_table;
    end if;
  end loop;
  if (select count(distinct pg_get_expr(p.polqual, p.polrelid) || '|' || pg_get_expr(p.polwithcheck, p.polrelid))
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      where c.relnamespace = 'ai'::regnamespace and c.relname in ('assistant_threads', 'assistant_turns', 'assistant_messages')
        and p.polname = 'own_or_worker') <> 1 then
    raise exception 'the assistant tables'' owner policies should be one rule';
  end if;
  if has_table_privilege('crm_app', 'ai.assistant_messages', 'update')
     or has_table_privilege('crm_app', 'ai.assistant_messages', 'delete')
     or has_table_privilege('crm_app', 'ai.assistant_turns', 'delete')
     or not has_table_privilege('crm_app', 'ai.assistant_threads', 'delete') then
    raise exception 'crm_app should delete a thread, and never rewrite a message or delete a turn';
  end if;
  raise notice 'ok: assistant conversations keep their restrictive owner policy and narrow grants';
end $$;

-- A browser calling token is one person's: tenant isolation narrowed by one restrictive
-- policy for every command, the same rule as the assistant's. Nobody but maintenance deletes.
do $$
begin
  if (select array_agg(format('%s %s %s', policyname, permissive, cmd) order by policyname)
      from pg_policies
      where schemaname = 'messaging' and tablename = 'voice_grants')
     is distinct from array['own_or_worker RESTRICTIVE ALL', 'tenant_isolation PERMISSIVE ALL'] then
    raise exception 'messaging.voice_grants should have tenant_isolation and its restrictive owner policy';
  end if;
  if (select pg_get_expr(polqual, polrelid) || '|' || pg_get_expr(polwithcheck, polrelid)
      from pg_policy
      where polrelid = 'messaging.voice_grants'::regclass and polname = 'own_or_worker')
     is distinct from
     (select pg_get_expr(polqual, polrelid) || '|' || pg_get_expr(polwithcheck, polrelid)
      from pg_policy
      where polrelid = 'ai.assistant_threads'::regclass and polname = 'own_or_worker') then
    raise exception 'the calling token''s owner policy should be the assistant''s rule';
  end if;
  if has_table_privilege('crm_app', 'messaging.voice_grants', 'delete') then
    raise exception 'crm_app should not delete calling tokens; maintenance does';
  end if;
  raise notice 'ok: calling tokens keep their restrictive owner policy and no delete grant';
end $$;

-- A foreign key is covered when an index starts with exactly its columns (in any order),
-- or when a unique index uses only columns of the key (so a lookup is already exact).
do $$
declare
  v_offenders text;
begin
  with fks as (
    select k.conrelid, k.conname, k.conkey
    from pg_constraint k
    join checked_tables t on t.oid = k.conrelid
    where k.contype = 'f'
  ),
  indexes as (
    select i.indrelid, i.indisunique,
           string_to_array(i.indkey::text, ' ')::int2[] as cols
    from pg_index i
  )
  select string_agg(format('%s.%s', f.conrelid::regclass, f.conname), ', ') into v_offenders
  from fks f
  where not exists (
    select 1
    from indexes i
    where i.indrelid = f.conrelid
      and (
        (select array_agg(c order by c) from unnest(i.cols[1:cardinality(f.conkey)]) c)
          = (select array_agg(c order by c) from unnest(f.conkey) c)
        or (i.indisunique and i.cols <@ f.conkey)
      )
  );
  if v_offenders is not null then
    raise exception 'foreign keys without a supporting index: %', v_offenders;
  end if;
  raise notice 'ok: every foreign key has a supporting index';
end $$;

do $$
declare
  v_offenders text;
begin
  select string_agg(format('%s.%s.%s (%s)', c.table_schema, c.table_name, c.column_name, c.data_type), ', ')
    into v_offenders
  from information_schema.columns c
  where c.table_schema in (select name from checked_schemas)
    and (
      c.data_type in ('timestamp without time zone', 'json', 'character varying', 'character', 'money', 'double precision')
      or (c.data_type = 'real' and c.column_name <> 'confidence')
      or c.column_default like 'nextval(%'
    );
  if v_offenders is not null then
    raise exception 'columns with a disallowed type: %', v_offenders;
  end if;
  raise notice 'ok: timestamps have time zones, text is text, money is numeric, no serials';
end $$;

do $$
declare
  v_offenders text;
begin
  select string_agg(t.name::text, ', ') into v_offenders
  from checked_tables t
  where exists (select 1 from pg_attribute a where a.attrelid = t.oid and a.attname = 'updated_at' and not a.attisdropped)
    and not exists (select 1 from pg_trigger g where g.tgrelid = t.oid and g.tgname = 'touch_updated_at');
  if v_offenders is not null then
    raise exception 'tables with updated_at but no touch_updated_at trigger: %', v_offenders;
  end if;
  raise notice 'ok: every updated_at column is maintained by a trigger';
end $$;

-- Partitions are reached only through their parent, whose policies then apply.
do $$
declare
  v_offenders text;
begin
  select string_agg(c.oid::regclass::text, ', ') into v_offenders
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relispartition
    and n.nspname in (select name from checked_schemas)
    and (has_table_privilege('crm_app', c.oid, 'select') or has_table_privilege('crm_app', c.oid, 'insert'));
  if v_offenders is not null then
    raise exception 'crm_app can reach partitions directly: %', v_offenders;
  end if;
  raise notice 'ok: partitions are only reachable through their parent table';
end $$;

do $$
declare
  v_offenders text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_offenders
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in (select name from checked_schemas)
    and (p.proacl is null
         or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_offenders is not null then
    raise exception 'functions executable by PUBLIC: %', v_offenders;
  end if;
  raise notice 'ok: no function is executable by PUBLIC';
end $$;

do $$
declare
  v_offenders text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_offenders
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in (select name from checked_schemas)
    and p.prosecdef
    and (n.nspname <> 'private'
         or not exists (select 1 from unnest(p.proconfig) s where s = 'search_path=""'));
  if v_offenders is not null then
    raise exception 'SECURITY DEFINER functions outside private or without a pinned search_path: %', v_offenders;
  end if;
  raise notice 'ok: SECURITY DEFINER functions live in private and pin search_path';
end $$;

-- The job queue (0013): crm_worker reaches the graphile_worker schema and nothing else of
-- ours, and no other runtime role reaches the queue; crm_app adds jobs only through
-- private.enqueue_job.
do $$
declare
  v_offenders text;
begin
  select string_agg(n.nspname, ', ' order by n.nspname) into v_offenders
  from pg_namespace n
  where has_schema_privilege('crm_worker', n.oid, 'usage')
    and n.nspname not in ('graphile_worker', 'public', 'information_schema')
    and n.nspname !~ '^pg_';
  if v_offenders is not null then
    raise exception 'crm_worker can use schemas outside the job queue: %', v_offenders;
  end if;
  select string_agg(r.rolname, ', ' order by r.rolname) into v_offenders
  from pg_roles r
  where r.rolname in ('crm_app', 'crm_auth')
    and has_schema_privilege(r.oid, 'graphile_worker', 'usage');
  if v_offenders is not null then
    raise exception 'roles other than crm_worker can use the job queue: %', v_offenders;
  end if;
  raise notice 'ok: only crm_worker reaches the job queue, and it reaches nothing else';
end $$;

-- Sign-in (0015): session tokens, password hashes and reset tokens are for crm_auth alone.
-- crm_app reads auth.users (to show people's names) and nothing else in auth.
do $$
declare
  v_offenders text;
begin
  select string_agg(format('%s on %s', r.rolname, c.oid::regclass), ', ') into v_offenders
  from pg_class c
  cross join pg_roles r
  where c.relnamespace = 'auth'::regnamespace and c.relkind in ('r', 'p')
    and c.relname <> 'users'
    and r.rolname in ('crm_app', 'crm_worker')
    and (has_table_privilege(r.oid, c.oid, 'select') or has_table_privilege(r.oid, c.oid, 'insert')
         or has_table_privilege(r.oid, c.oid, 'update') or has_table_privilege(r.oid, c.oid, 'delete'));
  if v_offenders is not null then
    raise exception 'roles other than crm_auth reach the sign-in tables: %', v_offenders;
  end if;
  select string_agg(c.oid::regclass::text, ', ') into v_offenders
  from pg_class c
  where c.relnamespace = 'auth'::regnamespace and c.relkind in ('r', 'p')
    and c.relname <> 'users'
    and not (has_table_privilege('crm_auth', c.oid, 'select') and has_table_privilege('crm_auth', c.oid, 'insert')
             and has_table_privilege('crm_auth', c.oid, 'update') and has_table_privilege('crm_auth', c.oid, 'delete'));
  if v_offenders is not null then
    raise exception 'crm_auth can''t read and write the sign-in tables: %', v_offenders;
  end if;
  raise notice 'ok: only crm_auth reaches the sign-in tables';
end $$;

-- Graphile Worker installs its own tables after the SQL migrations, as crm_owner; default
-- privileges make them usable by crm_worker.
do $$
declare
  v_granted text;
begin
  select string_agg(format('%s:%s', d.defaclobjtype, a.privilege_type), ','
                    order by format('%s:%s', d.defaclobjtype, a.privilege_type) collate "C")
    into v_granted
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace
  cross join aclexplode(d.defaclacl) a
  where n.nspname = 'graphile_worker'
    and d.defaclrole = 'crm_owner'::regrole
    and a.grantee = 'crm_worker'::regrole;
  if v_granted is distinct from 'S:SELECT,S:USAGE,f:EXECUTE,r:DELETE,r:INSERT,r:SELECT,r:UPDATE' then
    raise exception 'crm_worker''s default privileges in graphile_worker: %', coalesce(v_granted, 'none');
  end if;
  raise notice 'ok: what Graphile Worker installs is usable by crm_worker';
end $$;

-- Verification history is a receipt ledger, never editable or deletable by the app.
do $$
begin
  if has_table_privilege('crm_app','messaging.email_verification_checks','update')
     or has_table_privilege('crm_app','messaging.email_verification_checks','delete')
     or has_table_privilege('crm_app','messaging.email_verifications','delete') then
    raise exception 'email verification grants must preserve the ledger and address history';
  end if;
  raise notice 'ok: email verification history has append-only ledger grants';
end $$;

-- A merge moves a contact's files to the contact it keeps (0127): crm_app may change which
-- record a file is on, and which field it fills, and nothing else of it.
do $$
begin
  if has_table_privilege('crm_app', 'crm.record_files', 'update')
     or not has_column_privilege('crm_app', 'crm.record_files', 'record_id', 'update')
     or not has_column_privilege('crm_app', 'crm.record_files', 'field_id', 'update')
     or has_column_privilege('crm_app', 'crm.record_files', 'file_id', 'update') then
    raise exception 'crm_app should update only record_id and field_id of crm.record_files';
  end if;
  raise notice 'ok: a merge can move record files and nothing else of them';
end $$;
