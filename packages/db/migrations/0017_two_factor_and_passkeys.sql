-- Two-factor sign-in and passkeys (task P1.03, ADR-008): the tables of Better Auth's
-- two-factor and passkey plugins, beside the other sign-in tables and, like them, for
-- crm_auth alone. And an agency's rule that its staff sign in with two factors.

-- Whether the person also signs in with a code from an authenticator app. The two-factor
-- plugin sets it once their first code checks out.
alter table auth.users add column two_factor_enabled boolean not null default false;

-- A person's authenticator app: its secret and their recovery codes, which Better Auth
-- encrypts with AUTH_SECRET. verified is false between setting it up and the first code
-- that checks out. Ten wrong codes in a row lock it for 15 minutes (locked_until).
create table auth.two_factors (
  id uuid primary key default uuidv7(),
  user_id uuid not null references auth.users (id) on delete cascade,
  secret text not null,
  backup_codes text not null,
  verified boolean not null default true,
  failed_verification_count integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  constraint two_factors_user_unique unique (user_id)
);

-- A person's passkeys: one row per WebAuthn credential, with its public key (base64) and
-- signature counter. An authenticator names each credential it makes, uniquely.
create table auth.passkeys (
  id uuid primary key default uuidv7(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text,
  public_key text not null,
  credential_id text not null constraint passkeys_credential_id_unique unique,
  -- A WebAuthn counter is an unsigned 32-bit number, which outgrows integer.
  counter bigint not null,
  device_type text not null,
  backed_up boolean not null,
  transports text,
  aaguid text,
  created_at timestamptz not null default now()
);
create index passkeys_user_id_idx on auth.passkeys (user_id);

do $$
declare
  v_table text;
begin
  foreach v_table in array array['auth.two_factors', 'auth.passkeys'] loop
    execute format('alter table %s enable row level security', v_table);
    execute format('alter table %s force row level security', v_table);
    execute format('create policy authentication_module_only on %s using (false) with check (false)', v_table);
    execute format('grant select, insert, update, delete on %s to crm_auth', v_table);
  end loop;
end $$;

-- Proving an address removes the authenticator app and passkeys set up before it was
-- proven: someone else who knew the password the person was given could have added them.
-- Better Auth's first sign-in link to an unproven address (revokeUnprovenAccountAccess)
-- removes that password and the sessions, but not these, so the owner would inherit them.
create function auth.end_unproven_factors() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.email_verified and not old.email_verified then
    new.two_factor_enabled := false;
    delete from auth.two_factors where user_id = new.id;
    delete from auth.passkeys where user_id = new.id;
  end if;
  return new;
end $$;
revoke execute on function auth.end_unproven_factors() from public;

create trigger users_end_unproven_factors
  before update of email_verified on auth.users
  for each row execute function auth.end_unproven_factors();

-- The agency can require its staff (members of the agency itself, not of one of its
-- businesses) to sign in with two factors. Until they've set it up, they reach only the
-- page that sets it up.
alter table tenancy.agencies add column two_factor_required boolean not null default false;
