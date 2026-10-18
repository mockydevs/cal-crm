-- Tenancy and identity: agencies, businesses (sub-accounts), users, roles, memberships,
-- invitations and API keys.
--
-- A business is what GoHighLevel calls a sub-account; the UI calls it a business.
-- Every business-owned row in every other module carries business_id.

create schema tenancy;
create schema auth;  -- owned by the authentication module; written only by crm_auth

create table tenancy.agencies (
  id uuid primary key default uuidv7(),
  name text not null constraint agencies_name_length check (length(btrim(name)) between 1 and 200),
  slug text not null constraint agencies_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  -- White-label settings. The logo FK is added once files.files exists.
  app_name text constraint agencies_app_name_length check (length(btrim(app_name)) between 1 and 60),
  accent_color text constraint agencies_accent_color_format check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  logo_file_id uuid,
  custom_domain text constraint agencies_custom_domain_lowercase check (custom_domain = lower(custom_domain)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agencies_slug_unique unique (slug),
  constraint agencies_custom_domain_unique unique (custom_domain)
);

create table tenancy.businesses (
  id uuid primary key default uuidv7(),
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  name text not null constraint businesses_name_length check (length(btrim(name)) between 1 and 200),
  slug text not null constraint businesses_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  legal_name text,
  -- IANA time zone and BCP 47 locale; validated by the application.
  timezone text not null default 'UTC',
  locale text not null default 'en',
  currency text not null default 'USD' constraint businesses_currency_format check (currency ~ '^[A-Z]{3}$'),
  phone_e164 text constraint businesses_phone_format check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  website text,
  address jsonb constraint businesses_address_object check (jsonb_typeof(address) = 'object'),
  logo_file_id uuid,
  status text not null default 'active' constraint businesses_status_valid check (status in ('active', 'suspended', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Lets scoped tables reference (agency_id, business_id) so a row can't name a
  -- business from another agency.
  constraint businesses_agency_id_id_unique unique (agency_id, id),
  constraint businesses_slug_unique unique (agency_id, slug)
);

-- The canonical user. The auth library's own tables (sessions, credentials, verification
-- tokens, passkeys, two-factor) also live in this schema and reference auth.users(id);
-- their exact shape is set by the library and confirmed in phase 1.
create table auth.users (
  id uuid primary key default uuidv7(),
  email text not null constraint users_email_format check (email ~ '^[^@\s]+@[^@\s]+$'),
  email_normalized text generated always as (lower(btrim(email))) stored,
  email_verified_at timestamptz,
  name text not null default '',
  image_url text,
  locale text,
  timezone text,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_email_unique unique (email_normalized)
);

-- Built-in roles are seeded per agency, so memberships always point at a row.
-- permissions holds permission keys the application defines and validates.
create table tenancy.roles (
  id uuid primary key default uuidv7(),
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  scope text not null constraint roles_scope_valid check (scope in ('agency', 'business')),
  key text not null constraint roles_key_format check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  name text not null constraint roles_name_length check (length(btrim(name)) between 1 and 80),
  description text not null default '',
  permissions text[] not null default '{}',
  is_builtin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint roles_key_unique unique (agency_id, scope, key),
  constraint roles_agency_id_id_scope_unique unique (agency_id, id, scope)
);

-- One row per person per agency (business_id NULL: agency staff) or per business.
create table tenancy.memberships (
  id uuid primary key default uuidv7(),
  user_id uuid not null references auth.users (id) on delete cascade,
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  business_id uuid,
  scope text not null generated always as (case when business_id is null then 'agency' else 'business' end) stored,
  role_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id) on delete cascade,
  -- An agency role can't be given to a business member, and vice versa.
  foreign key (agency_id, role_id, scope) references tenancy.roles (agency_id, id, scope),
  constraint memberships_one_per_scope unique nulls not distinct (user_id, agency_id, business_id)
);
create index memberships_agency_id_business_id_idx on tenancy.memberships (agency_id, business_id);
create index memberships_role_idx on tenancy.memberships (agency_id, role_id, scope);

create table tenancy.invitations (
  id uuid primary key default uuidv7(),
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  business_id uuid,
  email text not null constraint invitations_email_format check (email ~ '^[^@\s]+@[^@\s]+$'),
  email_normalized text generated always as (lower(btrim(email))) stored,
  scope text not null generated always as (case when business_id is null then 'agency' else 'business' end) stored,
  role_id uuid not null,
  -- SHA-256 of the token in the invitation link; the token itself is never stored.
  token_hash bytea not null constraint invitations_token_hash_length check (length(token_hash) = 32),
  invited_by_user_id uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id) on delete cascade,
  foreign key (agency_id, role_id, scope) references tenancy.roles (agency_id, id, scope),
  constraint invitations_token_hash_unique unique (token_hash),
  constraint invitations_single_outcome check (accepted_at is null or revoked_at is null)
);
create index invitations_agency_id_business_id_idx on tenancy.invitations (agency_id, business_id);
create index invitations_role_idx on tenancy.invitations (agency_id, role_id, scope);
create index invitations_invited_by_idx on tenancy.invitations (invited_by_user_id);
create unique index invitations_one_pending_idx
  on tenancy.invitations (agency_id, business_id, email_normalized) nulls not distinct
  where accepted_at is null and revoked_at is null;

-- Keys for the public API and the MCP server. The full key is shown once; only its
-- SHA-256 is stored. key_prefix identifies the key in lists ("crm_live_8f3k").
create table tenancy.api_keys (
  id uuid primary key default uuidv7(),
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  business_id uuid,
  name text not null constraint api_keys_name_length check (length(btrim(name)) between 1 and 80),
  key_prefix text not null constraint api_keys_prefix_format check (key_prefix ~ '^[a-z0-9_]{8,32}$'),
  key_hash bytea not null constraint api_keys_key_hash_length check (length(key_hash) = 32),
  scopes text[] not null constraint api_keys_scopes_present check (cardinality(scopes) > 0),
  created_by_user_id uuid references auth.users (id) on delete set null,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id) on delete cascade,
  constraint api_keys_prefix_unique unique (key_prefix),
  constraint api_keys_key_hash_unique unique (key_hash)
);
create index api_keys_agency_id_business_id_idx on tenancy.api_keys (agency_id, business_id);
create index api_keys_created_by_idx on tenancy.api_keys (created_by_user_id);

call util.add_updated_at_trigger('tenancy.agencies');
call util.add_updated_at_trigger('tenancy.businesses');
call util.add_updated_at_trigger('auth.users');
call util.add_updated_at_trigger('tenancy.roles');
call util.add_updated_at_trigger('tenancy.memberships');

-- Row-level security ----------------------------------------------------------------

alter table tenancy.agencies enable row level security;
alter table tenancy.agencies force row level security;
create policy agency_isolation on tenancy.agencies
  using (id = (select app.agency_id()))
  with check (id = (select app.agency_id()));

-- Agency staff (no business selected) see every business in their agency; inside a
-- business, only that business is visible.
alter table tenancy.businesses enable row level security;
alter table tenancy.businesses force row level security;
create policy agency_isolation on tenancy.businesses
  using (
    agency_id = (select app.agency_id())
    and ((select app.business_id()) is null or id = (select app.business_id())))
  with check (agency_id = (select app.agency_id()));

-- crm_app sees the signed-in user plus people who share a membership it can see
-- (memberships are themselves limited to the current agency). crm_auth bypasses this.
alter table auth.users enable row level security;
alter table auth.users force row level security;
create policy visible_people on auth.users
  for select
  using (
    id = (select app.user_id())
    or exists (select 1 from tenancy.memberships m where m.user_id = users.id));

call util.enable_agency_rls('tenancy.roles');
call util.enable_scoped_rls('tenancy.memberships');
call util.enable_scoped_rls('tenancy.invitations');
call util.enable_scoped_rls('tenancy.api_keys');
