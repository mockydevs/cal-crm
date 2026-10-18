-- OAuth for installed apps (ADR-113, tasks/marketplace-build.md MP2). The app is the OAuth
-- client: the agency lists its redirect URIs and generates its secret. A person consents on
-- the install's behalf and gets a code; the app trades the code for an access token and a
-- refresh token, bound to the install. A request with the access token acts as the
-- install's app key, a row of tenancy.api_keys that has no secret of its own.

-- The client: where codes may be sent, and the secret's hash (SHA-256, as API keys).
alter table tenancy.marketplace_apps
  add column redirect_uris text[] not null default '{}'
    constraint marketplace_apps_redirect_uris_shape
    check (cardinality(redirect_uris) <= 10 and array_position(redirect_uris, null) is null),
  add column client_secret_hash bytea
    constraint marketplace_apps_client_secret_hash_length check (length(client_secret_hash) = 32),
  -- What the settings page shows of it: crm_cs_ and its first 8 hexadecimal digits.
  add column client_secret_prefix text
    constraint marketplace_apps_client_secret_prefix_format
    check (client_secret_prefix ~ '^crm_cs_[0-9a-f]{8}$'),
  add column client_secret_set_at timestamptz,
  add constraint marketplace_apps_client_secret_together check (
    (client_secret_hash is null) = (client_secret_prefix is null)
    and (client_secret_hash is null) = (client_secret_set_at is null)
  );

-- What the app may read, by the API's groups (ADR-093), as a key's read groups; the install
-- grants them with its scopes. An app key always has a list, so it never has the legacy
-- unrestricted reads of a key without one.
alter table tenancy.marketplace_apps
  add column read_groups text[] not null default '{}'
    constraint marketplace_apps_read_groups_shape
    check (cardinality(read_groups) <= 64 and array_position(read_groups, null) is null);
alter table tenancy.marketplace_installs
  add column granted_read_groups text[] not null default '{}'
    constraint marketplace_installs_granted_read_groups_shape
    check (cardinality(granted_read_groups) <= 64
           and array_position(granted_read_groups, null) is null);

-- The install's app key: no secret, so it can't be presented; only an access token reaches
-- it. It belongs to the install's business, and goes when the install's row goes.
alter table tenancy.api_keys
  add column marketplace_install_id uuid,
  alter column key_hash drop not null,
  alter column key_prefix drop not null,
  drop constraint api_keys_scopes_present;
alter table tenancy.api_keys
  add constraint api_keys_app_key_shape check (
    case
      when marketplace_install_id is null then key_hash is not null and key_prefix is not null
      else key_hash is null and key_prefix is null and business_id is not null
        and read_groups is not null
    end
  ),
  -- An app may ask for no permission at all (it reads nothing); its key holds none.
  add constraint api_keys_scopes_present check (
    cardinality(scopes) > 0
    or coalesce(cardinality(read_groups), 0) > 0
    or marketplace_install_id is not null
  ),
  add constraint api_keys_marketplace_install foreign key (business_id, marketplace_install_id)
    references tenancy.marketplace_installs (business_id, id) on delete cascade;
create unique index api_keys_marketplace_install_unique
  on tenancy.api_keys (marketplace_install_id) where marketplace_install_id is not null;

-- Every live install so far gets its app key, made when it was installed. It reads nothing
-- until the app is installed again with the groups its agency lists.
insert into tenancy.api_keys
  (agency_id, business_id, name, scopes, read_groups, created_by_user_id, created_at,
   marketplace_install_id)
select install.agency_id, install.business_id, left(app.name, 80), install.granted_scopes,
       install.granted_read_groups,
       (select u.id from auth.users u where u.id = install.installed_by),
       install.installed_at, install.id
from tenancy.marketplace_installs install
join tenancy.marketplace_apps app
  on app.agency_id = install.agency_id and app.id = install.app_id
where install.uninstalled_at is null;

-- A code, from a person's consent: ten minutes, once (ADR-113 point 3).
create table tenancy.marketplace_oauth_codes (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  agency_id uuid not null,
  install_id uuid not null,
  code_hash bytea not null constraint marketplace_oauth_codes_hash_length
    check (length(code_hash) = 32),
  -- Exactly as the authorization request sent it; the token request must send it again.
  redirect_uri text not null constraint marketplace_oauth_codes_redirect_length
    check (length(redirect_uri) between 1 and 2048),
  -- S256 only: BASE64URL(SHA-256(code_verifier)) without padding (RFC 7636 section 4.2).
  code_challenge text not null constraint marketplace_oauth_codes_challenge_format
    check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  issued_by uuid not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint marketplace_oauth_codes_hash_unique unique (code_hash),
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id)
    on delete cascade,
  foreign key (business_id, install_id) references tenancy.marketplace_installs (business_id, id)
    on delete cascade,
  constraint marketplace_oauth_codes_expiry check (expires_at > created_at)
);
create index marketplace_oauth_codes_install_idx
  on tenancy.marketplace_oauth_codes (business_id, install_id);
create index marketplace_oauth_codes_agency_business_idx
  on tenancy.marketplace_oauth_codes (agency_id, business_id);
call util.enable_scoped_rls('tenancy.marketplace_oauth_codes');
grant select, insert on tenancy.marketplace_oauth_codes to crm_app;

-- A token pair. Each refresh makes the next row of the same code's family and marks this
-- one rotated; a rotated refresh token presented again revokes the family (ADR-113).
create table tenancy.marketplace_oauth_tokens (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  agency_id uuid not null,
  install_id uuid not null,
  -- The family: every pair that came from one code.
  code_id uuid not null,
  access_hash bytea not null constraint marketplace_oauth_tokens_access_length
    check (length(access_hash) = 32),
  access_expires_at timestamptz not null,
  refresh_hash bytea not null constraint marketplace_oauth_tokens_refresh_length
    check (length(refresh_hash) = 32),
  refresh_expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text constraint marketplace_oauth_tokens_revoked_reason
    check (revoked_reason in ('uninstalled', 'revoked', 'refresh_reused', 'code_reused')),
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint marketplace_oauth_tokens_access_unique unique (access_hash),
  constraint marketplace_oauth_tokens_refresh_unique unique (refresh_hash),
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id)
    on delete cascade,
  foreign key (business_id, install_id) references tenancy.marketplace_installs (business_id, id)
    on delete cascade,
  foreign key (business_id, code_id) references tenancy.marketplace_oauth_codes (business_id, id)
    on delete cascade,
  constraint marketplace_oauth_tokens_revoked_pair
    check ((revoked_at is null) = (revoked_reason is null)),
  constraint marketplace_oauth_tokens_expiry
    check (access_expires_at > created_at and refresh_expires_at > created_at)
);
create index marketplace_oauth_tokens_install_idx
  on tenancy.marketplace_oauth_tokens (business_id, install_id);
create index marketplace_oauth_tokens_code_idx
  on tenancy.marketplace_oauth_tokens (business_id, code_id);
create index marketplace_oauth_tokens_agency_business_idx
  on tenancy.marketplace_oauth_tokens (agency_id, business_id);
call util.enable_scoped_rls('tenancy.marketplace_oauth_tokens');
-- Uninstalling revokes the install's tokens, in the uninstall's transaction.
grant select on tenancy.marketplace_oauth_tokens to crm_app;
grant update (revoked_at, revoked_reason) on tenancy.marketplace_oauth_tokens to crm_app;

-- The token endpoint and the access-token lookup run as crm_auth, before any tenant
-- context exists, as the API key lookup does: only what they read and write.
grant select (agency_id, id, name, status, redirect_uris, client_secret_hash)
  on tenancy.marketplace_apps to crm_auth;
grant select (business_id, id, agency_id, app_id, uninstalled_at)
  on tenancy.marketplace_installs to crm_auth;
grant select on tenancy.marketplace_oauth_codes to crm_auth;
grant update (used_at) on tenancy.marketplace_oauth_codes to crm_auth;
grant select, insert on tenancy.marketplace_oauth_tokens to crm_auth;
grant update (rotated_at, revoked_at, revoked_reason)
  on tenancy.marketplace_oauth_tokens to crm_auth;
