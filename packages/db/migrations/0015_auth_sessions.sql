-- Sign-in: Better Auth's tables, beside auth.users (ADR-008). Better Auth reaches them as
-- crm_auth through its schemaName option, with snake_case columns mapped in its config
-- (@repo/module-auth). Ids come from these defaults: Better Auth leaves id out of inserts
-- (generateId: false). Only crm_auth, which bypasses row-level security, uses these
-- tables; their policies let no other role see a row.

-- auth.users fits Better Auth's user model: a boolean email_verified, with
-- email_verified_at kept beside it, and email in lower case, since sign-in looks users up
-- by the lowercased address.
alter table auth.users
  add column email_verified boolean not null default false,
  add constraint users_email_lower_case check (email = lower(btrim(email)));
update auth.users set email_verified = true where email_verified_at is not null;

create function auth.keep_email_verified_at() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if not new.email_verified then
    new.email_verified_at := null;
  elsif tg_op = 'INSERT' or not old.email_verified then
    new.email_verified_at := coalesce(new.email_verified_at, now());
  end if;
  return new;
end $$;
revoke execute on function auth.keep_email_verified_at() from public;

create trigger users_keep_email_verified_at
  before insert or update of email_verified on auth.users
  for each row execute function auth.keep_email_verified_at();

-- One row per signed-in browser. The token is the session cookie's value, so only
-- crm_auth may read it.
create table auth.sessions (
  id uuid primary key default uuidv7(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token text not null constraint sessions_token_unique unique,
  expires_at timestamptz not null,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sessions_user_id_idx on auth.sessions (user_id);

-- How a user signs in: the "credential" account holds the password hash; other providers
-- (single sign-on, later) hold their tokens.
create table auth.accounts (
  id uuid primary key default uuidv7(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id text not null,
  provider_id text not null,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounts_provider_account_unique unique (provider_id, account_id)
);
create index accounts_user_id_idx on auth.accounts (user_id);

-- Short-lived values: email verification, password reset and magic-link tokens.
create table auth.verifications (
  id uuid primary key default uuidv7(),
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index verifications_identifier_idx on auth.verifications (identifier);

-- Better Auth's rate limits, shared by every app container. last_request is milliseconds
-- since the epoch, which Better Auth does arithmetic on: the crm_auth pool reads bigint as
-- a JavaScript number (@repo/db's bigintAsNumber), where node-postgres would give a string.
create table auth.rate_limits (
  id uuid primary key default uuidv7(),
  key text not null constraint rate_limits_key_unique unique,
  count integer not null,
  last_request bigint not null
);

call util.add_updated_at_trigger('auth.sessions');
call util.add_updated_at_trigger('auth.accounts');
call util.add_updated_at_trigger('auth.verifications');

do $$
declare
  v_table text;
begin
  foreach v_table in array array['auth.sessions', 'auth.accounts', 'auth.verifications', 'auth.rate_limits'] loop
    execute format('alter table %s enable row level security', v_table);
    execute format('alter table %s force row level security', v_table);
    execute format('create policy authentication_module_only on %s using (false) with check (false)', v_table);
    execute format('grant select, insert, update, delete on %s to crm_auth', v_table);
  end loop;
end $$;
