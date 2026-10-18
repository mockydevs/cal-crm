-- A release's app starts serving only once the schema has every migration it brings
-- (ADR-112): during a rolling deploy the old app keeps serving while the worker migrates.
-- The app asks through this function, which returns the names of the applied migrations and
-- nothing else; crm_app still cannot reach util.applied_migrations itself. PL/pgSQL, so the
-- body is resolved when it is called: the table is the runner's, and validate.sh applies the
-- migrations with psql, where it doesn't exist.
create function private.applied_migration_names()
returns setof text
language plpgsql stable security definer set search_path = ''
as $$
begin
  return query select m.name from util.applied_migrations m order by m.name collate "C";
end
$$;
revoke execute on function private.applied_migration_names() from public;
grant execute on function private.applied_migration_names() to crm_app;
