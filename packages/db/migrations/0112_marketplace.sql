-- The App Marketplace (ADR-111, tasks/marketplace-build.md). An app is a listing the agency
-- publishes and a grant a business gives it; its code runs outside the CRM. The agency owns
-- the app, so every business of the agency sees it once it is listed; a business owns its
-- installs, and the agency sees how many there are.

create table tenancy.marketplace_apps (
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  id uuid not null default uuidv7(),
  name text not null constraint marketplace_apps_name_length
    check (length(btrim(name)) between 1 and 80),
  -- One line on the card.
  tagline text not null default '' constraint marketplace_apps_tagline_length
    check (length(tagline) <= 140),
  -- Plain text on the app's page.
  description text not null default '' constraint marketplace_apps_description_length
    check (length(description) <= 5000),
  developer text not null constraint marketplace_apps_developer_length
    check (length(btrim(developer)) between 1 and 80),
  -- PostgreSQL's regular expressions repeat at most 255 times, so the length is checked on its own.
  website_url text constraint marketplace_apps_website_https
    check (length(website_url) <= 2048 and website_url ~ '^https://[^\s]+$'),
  support_email text constraint marketplace_apps_support_email
    check (support_email ~ '^[^@\s]{1,64}@[^@\s]{1,255}$'),
  icon_url text constraint marketplace_apps_icon_https
    check (length(icon_url) <= 2048 and icon_url ~ '^https://[^\s]+$'),
  -- Categories and scopes are the contracts' vocabularies (marketplace.ts, permissions.ts);
  -- the commands check each value, the table only their shape.
  categories text[] not null default '{}' constraint marketplace_apps_categories_shape
    check (cardinality(categories) <= 5 and array_position(categories, null) is null),
  scopes text[] not null default '{}' constraint marketplace_apps_scopes_shape
    check (cardinality(scopes) <= 200 and array_position(scopes, null) is null),
  -- draft: seen at agency level only. listed: every business of the agency sees it and may
  -- install it. delisted: no new installs; installs keep working until uninstalled.
  status text not null default 'draft' constraint marketplace_apps_status
    check (status in ('draft', 'listed', 'delisted')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (agency_id, id)
);
create index marketplace_apps_listed_idx on tenancy.marketplace_apps (agency_id, status, name);
call util.add_updated_at_trigger('tenancy.marketplace_apps');
call util.enable_agency_rls('tenancy.marketplace_apps');
grant select, insert, update on tenancy.marketplace_apps to crm_app;

create table tenancy.marketplace_installs (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  agency_id uuid not null,
  app_id uuid not null,
  -- The app's requested scopes the installer held at install, and no others (ADR-111).
  granted_scopes text[] not null constraint marketplace_installs_granted_shape
    check (cardinality(granted_scopes) <= 200 and array_position(granted_scopes, null) is null),
  installed_by uuid not null,
  installed_at timestamptz not null default now(),
  uninstalled_by uuid,
  uninstalled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id)
    on delete cascade,
  -- The app is the business's own agency's: the install carries that agency.
  constraint marketplace_installs_app_owner foreign key (agency_id, app_id)
    references tenancy.marketplace_apps (agency_id, id) on delete cascade,
  constraint marketplace_installs_uninstall_pair
    check ((uninstalled_at is null) = (uninstalled_by is null)),
  constraint marketplace_installs_uninstall_after
    check (uninstalled_at is null or uninstalled_at >= installed_at)
);
-- One live install of an app in a business; uninstalled ones stay as history.
create unique index marketplace_installs_live_unique
  on tenancy.marketplace_installs (business_id, app_id) where uninstalled_at is null;
create index marketplace_installs_agency_business_idx
  on tenancy.marketplace_installs (agency_id, business_id);
create index marketplace_installs_app_idx on tenancy.marketplace_installs (agency_id, app_id);
call util.add_updated_at_trigger('tenancy.marketplace_installs');
-- Scoped: a business sees its own installs; the agency, at agency level, counts them.
call util.enable_scoped_rls('tenancy.marketplace_installs');
grant select, insert, update on tenancy.marketplace_installs to crm_app;
