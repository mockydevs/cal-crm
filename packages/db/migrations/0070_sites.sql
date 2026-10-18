-- Sites, phase S1 (ADR-076, ADR-077): funnels and websites with their steps, pages and page
-- versions; folders; saved sections; templates; statistics per day; and the domains and
-- redirects a business connects. Nothing here serves a page: publishing and certificates
-- are a later phase, which reads these tables.
--
-- A page's content is our own versioned document (ADR-076). The application validates it
-- on every save; the database keeps only what it can check cheaply: that it is an object,
-- that it names its format, and that it is not larger than a page should ever be.

create schema sites;
grant usage on schema sites to crm_app;

-- Domains --------------------------------------------------------------------------------
-- A host name a business connected. Verified means its DNS record points at this install,
-- which is also the proof that the business controls the name. One business holds a host
-- name: the public side finds the business by the host alone.
create table sites.domains (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  hostname text not null constraint domains_hostname_valid check (
    length(hostname) between 4 and 253
    and hostname = lower(hostname)
    and hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
  verification_status text not null default 'pending' constraint domains_verification_status_valid
    check (verification_status in ('pending', 'verified', 'failed')),
  -- Why the last check failed, in words a person can act on.
  verification_error text constraint domains_verification_error_length
    check (length(verification_error) between 1 and 500),
  checked_at timestamptz,
  verified_at timestamptz,
  -- Written by the publishing phase; nothing in S1 issues a certificate.
  certificate_status text not null default 'none' constraint domains_certificate_status_valid
    check (certificate_status in ('none', 'pending', 'issued', 'failed')),
  -- For a root domain: www answers too, with a permanent redirect to the root.
  www_redirect boolean not null default false,
  default_step_id uuid,
  not_found_step_id uuid,
  revision integer not null default 1 constraint domains_revision_positive check (revision > 0),
  created_by_kind text not null constraint domains_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint domains_verified_has_time check ((verification_status = 'verified') = (verified_at is not null)),
  constraint domains_error_when_failed check ((verification_status = 'failed') = (verification_error is not null))
);
create unique index domains_hostname_unique on sites.domains (hostname);
call util.enable_tenant_rls('sites.domains');
call util.add_updated_at_trigger('sites.domains');
grant select, insert, update, delete on sites.domains to crm_app;

-- Folders --------------------------------------------------------------------------------
-- Funnels and websites are listed apart, so each kind has its own folders.
create table sites.folders (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  kind text not null constraint folders_kind_valid check (kind in ('funnel', 'website')),
  name text not null constraint folders_name_length check (length(btrim(name)) between 1 and 120),
  name_normalized text generated always as (lower(btrim(name))) stored,
  revision integer not null default 1 constraint folders_revision_positive check (revision > 0),
  created_by_kind text not null constraint folders_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  -- A site names its folder with its kind, so a funnel is never filed among websites.
  constraint folders_id_kind_unique unique (business_id, id, kind)
);
create unique index folders_name_unique on sites.folders (business_id, kind, name_normalized);
call util.enable_tenant_rls('sites.folders');
call util.add_updated_at_trigger('sites.folders');
grant select, insert, update, delete on sites.folders to crm_app;

-- Sites ----------------------------------------------------------------------------------
create table sites.sites (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  kind text not null constraint sites_kind_valid check (kind in ('funnel', 'website')),
  name text not null constraint sites_name_length check (length(btrim(name)) between 1 and 120),
  -- Kept by the database: the list's order and search read it, and plain text comparisons
  -- are leakproof where lower() is not (ADR-028).
  name_normalized text generated always as (lower(btrim(name))) stored,
  folder_id uuid,
  domain_id uuid,
  -- Where the site answers under its domain: empty for the domain itself.
  path text not null default '' constraint sites_path_valid check (
    length(path) <= 200
    and path ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?(/[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)?$'),
  favicon_url text constraint sites_favicon_url_valid
    check (length(favicon_url) between 1 and 2000 and favicon_url ~ '^https?://[^[:space:][:cntrl:]]+$'),
  head_code text not null default '' constraint sites_head_code_length check (length(head_code) <= 50000),
  body_code text not null default '' constraint sites_body_code_length check (length(body_code) <= 50000),
  chat_widget_id uuid,
  -- Kept for the Stores phase: nothing reads them yet.
  payment_live boolean not null default false,
  require_card boolean not null default false,
  optimize_images boolean not null default true,
  lazy_custom_code boolean not null default false,
  privacy_fonts boolean not null default false,
  auto_schema boolean not null default false,
  -- What this site was copied from, when it was: a plain id, since the source may be a
  -- built-in template (which has no row), another business's site, or gone.
  origin_site_id uuid,
  origin_template_id uuid,
  revision integer not null default 1 constraint sites_revision_positive check (revision > 0),
  created_by_kind text not null constraint sites_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint sites_id_kind_unique unique (business_id, id, kind),
  foreign key (business_id, folder_id, kind) references sites.folders (business_id, id, kind)
    on delete set null (folder_id),
  foreign key (business_id, domain_id) references sites.domains (business_id, id)
    on delete set null (domain_id),
  -- Named: the application tells a widget that is not this business's by this constraint.
  constraint sites_chat_widget foreign key (business_id, chat_widget_id)
    references messaging.webchat_widgets (business_id, id) on delete set null (chat_widget_id)
);
-- Two sites cannot answer at the same address.
create unique index sites_domain_path_unique on sites.sites (business_id, domain_id, path)
  where domain_id is not null;
-- The lists: by name, and newest change first, each within a kind.
create index sites_name_idx on sites.sites (business_id, kind, name_normalized, id);
create index sites_updated_idx on sites.sites (business_id, kind, updated_at desc, id desc);
create index sites_folder_idx on sites.sites (business_id, folder_id, kind);
create index sites_chat_widget_idx on sites.sites (business_id, chat_widget_id);
call util.enable_tenant_rls('sites.sites');
call util.add_updated_at_trigger('sites.sites');
grant select, insert, update, delete on sites.sites to crm_app;

-- Response headers a site adds to every page (the Security tab), such as a
-- Content-Security-Policy. A header that the server itself must control is refused.
create table sites.security_headers (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  site_id uuid not null,
  name text not null constraint security_headers_name_valid check (
    name ~ '^[A-Za-z0-9!#$%&''*+.^_`|~-]{1,100}$'
    and lower(name) not in ('set-cookie', 'content-length', 'transfer-encoding', 'connection',
                            'host', 'content-encoding', 'location')),
  name_normalized text generated always as (lower(name)) stored,
  value text not null constraint security_headers_value_valid
    check (length(value) between 1 and 4000 and value !~ '[\r\n]'),
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, site_id) references sites.sites (business_id, id) on delete cascade
);
create unique index security_headers_name_unique
  on sites.security_headers (business_id, site_id, name_normalized);
call util.enable_tenant_rls('sites.security_headers');
grant select, insert, update, delete on sites.security_headers to crm_app;

-- Steps ----------------------------------------------------------------------------------
-- A funnel's steps are walked in order of position. A website's pages are steps too; their
-- position is only the order they were added in.
create table sites.steps (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  site_id uuid not null,
  name text not null constraint steps_name_length check (length(btrim(name)) between 1 and 120),
  -- Nested paths are allowed: offers/spring.
  path text not null constraint steps_path_valid check (
    length(path) between 1 and 200
    and path ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(/[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$'),
  position integer not null constraint steps_position_nonnegative check (position >= 0),
  split_test boolean not null default false,
  origin_step_id uuid,
  origin_template_id uuid,
  revision integer not null default 1 constraint steps_revision_positive check (revision > 0),
  created_by_kind text not null constraint steps_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint steps_id_site_unique unique (business_id, id, site_id),
  foreign key (business_id, site_id) references sites.sites (business_id, id) on delete cascade,
  constraint steps_path_unique unique (business_id, site_id, path),
  -- Checked when the command ends, so a reorder may pass through any arrangement.
  constraint steps_position_unique unique (business_id, site_id, position) deferrable initially deferred
);
call util.enable_tenant_rls('sites.steps');
call util.add_updated_at_trigger('sites.steps');
grant select, insert, update, delete on sites.steps to crm_app;

alter table sites.domains
  add constraint domains_default_step foreign key (business_id, default_step_id)
    references sites.steps (business_id, id) on delete set null (default_step_id),
  add constraint domains_not_found_step foreign key (business_id, not_found_step_id)
    references sites.steps (business_id, id) on delete set null (not_found_step_id);
create index domains_default_step_idx on sites.domains (business_id, default_step_id);
create index domains_not_found_step_idx on sites.domains (business_id, not_found_step_id);

-- Pages ----------------------------------------------------------------------------------
-- A step has its Control page and, in a funnel under a split test, a Variation. The site's
-- kind is repeated here and held by a foreign key, so the table itself refuses a variation
-- on a website.
create table sites.pages (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  step_id uuid not null,
  site_id uuid not null,
  site_kind text not null,
  role text not null default 'control' constraint pages_role_valid check (role in ('control', 'variation')),
  -- The share of a step's visitors this page gets while the split test runs, in percent.
  weight integer not null default 100 constraint pages_weight_valid check (weight between 0 and 100),
  -- The newest saved version, and the one that is live, by their numbers in page_versions.
  current_version integer not null default 1 constraint pages_current_version_positive check (current_version > 0),
  published_version integer constraint pages_published_version_valid
    check (published_version between 1 and current_version),
  published_at timestamptz,
  revision integer not null default 1 constraint pages_revision_positive check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, step_id, site_id) references sites.steps (business_id, id, site_id) on delete cascade,
  foreign key (business_id, site_id, site_kind) references sites.sites (business_id, id, kind) on delete cascade,
  constraint pages_role_unique unique (business_id, step_id, role),
  constraint pages_variation_in_funnel_only check (site_kind = 'funnel' or role = 'control'),
  constraint pages_published_complete check ((published_version is null) = (published_at is null))
);
create index pages_site_idx on sites.pages (business_id, site_id, site_kind);
create index pages_step_site_idx on sites.pages (business_id, step_id, site_id);
call util.enable_tenant_rls('sites.pages');
call util.add_updated_at_trigger('sites.pages');
grant select, insert, update, delete on sites.pages to crm_app;

-- Every save of a page is a version, and a version never changes. The application keeps
-- the newest thirty of a page and never drops the live one.
create table sites.page_versions (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  page_id uuid not null,
  number integer not null constraint page_versions_number_positive check (number > 0),
  -- The document format this version was written in (ADR-076). A reader upgrades it.
  format integer not null constraint page_versions_format_positive check (format > 0),
  document jsonb not null constraint page_versions_document_valid check (
    jsonb_typeof(document) = 'object'
    and jsonb_typeof(document -> 'format') = 'number'
    and octet_length(document::text) <= 2097152),
  -- The version this one was copied from, when it is a restore.
  restored_from integer constraint page_versions_restored_from_valid check (restored_from between 1 and number - 1),
  created_by_kind text not null constraint page_versions_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, page_id) references sites.pages (business_id, id) on delete cascade,
  constraint page_versions_number_unique unique (business_id, page_id, number),
  constraint page_versions_format_matches check ((document ->> 'format')::integer = format)
);
call util.enable_tenant_rls('sites.page_versions');
-- Written and removed, never rewritten.
grant select, insert, delete on sites.page_versions to crm_app;

-- Statistics -----------------------------------------------------------------------------
-- One row per page per day. The publishing phase counts into it; this phase reads it and
-- clears it ("Reset"). The sales columns wait for the Stores phase.
create table sites.step_stats_daily (
  business_id uuid not null,
  page_id uuid not null,
  day date not null,
  step_id uuid not null,
  site_id uuid not null,
  views integer not null default 0 constraint step_stats_views_nonnegative check (views >= 0),
  unique_views integer not null default 0 constraint step_stats_unique_valid
    check (unique_views between 0 and views),
  opt_ins integer not null default 0 constraint step_stats_opt_ins_nonnegative check (opt_ins >= 0),
  orders integer not null default 0 constraint step_stats_orders_nonnegative check (orders >= 0),
  order_quantity integer not null default 0 constraint step_stats_quantity_nonnegative check (order_quantity >= 0),
  order_amount numeric(14, 2) not null default 0 constraint step_stats_amount_nonnegative check (order_amount >= 0),
  primary key (business_id, page_id, day),
  foreign key (business_id, page_id) references sites.pages (business_id, id) on delete cascade,
  foreign key (business_id, step_id, site_id) references sites.steps (business_id, id, site_id) on delete cascade
);
-- The Stats tab: a site's rows in a range of days, and a step's rows when it is deleted.
create index step_stats_site_idx on sites.step_stats_daily (business_id, site_id, day);
create index step_stats_step_idx on sites.step_stats_daily (business_id, step_id, site_id);
call util.enable_tenant_rls('sites.step_stats_daily');
grant select, insert, update, delete on sites.step_stats_daily to crm_app;

-- Saved sections ---------------------------------------------------------------------------
-- A section pages refer to instead of holding a copy. With no site it is the business's
-- (a header on every funnel and website); with a site it belongs to that site's pages.
create table sites.saved_sections (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  site_id uuid,
  name text not null constraint saved_sections_name_length check (length(btrim(name)) between 1 and 120),
  name_normalized text generated always as (lower(btrim(name))) stored,
  format integer not null constraint saved_sections_format_positive check (format > 0),
  document jsonb not null constraint saved_sections_document_valid check (
    jsonb_typeof(document) = 'object' and octet_length(document::text) <= 524288),
  revision integer not null default 1 constraint saved_sections_revision_positive check (revision > 0),
  created_by_kind text not null constraint saved_sections_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, site_id) references sites.sites (business_id, id) on delete cascade
);
create unique index saved_sections_name_unique
  on sites.saved_sections (business_id, site_id, name_normalized) nulls not distinct;
call util.enable_tenant_rls('sites.saved_sections');
call util.add_updated_at_trigger('sites.saved_sections');
grant select, insert, update, delete on sites.saved_sections to crm_app;

-- Redirects --------------------------------------------------------------------------------
-- An address on a connected domain that sends its visitor to a site of the business or to
-- any web address.
create table sites.redirects (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  domain_id uuid not null,
  path text not null constraint redirects_path_valid check (
    length(path) between 1 and 500 and path ~ '^/[^[:space:][:cntrl:]?#]*$'),
  target_site_id uuid,
  target_url text constraint redirects_target_url_valid
    check (length(target_url) between 1 and 2000 and target_url ~ '^https?://[^[:space:][:cntrl:]]+$'),
  status integer not null default 301 constraint redirects_status_valid check (status in (301, 302)),
  revision integer not null default 1 constraint redirects_revision_positive check (revision > 0),
  created_by_kind text not null constraint redirects_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, domain_id) references sites.domains (business_id, id) on delete cascade,
  foreign key (business_id, target_site_id) references sites.sites (business_id, id) on delete cascade,
  constraint redirects_one_target check ((target_site_id is null) <> (target_url is null))
);
create unique index redirects_path_unique on sites.redirects (business_id, domain_id, path);
create index redirects_target_site_idx on sites.redirects (business_id, target_site_id);
call util.enable_tenant_rls('sites.redirects');
call util.add_updated_at_trigger('sites.redirects');
grant select, insert, update, delete on sites.redirects to crm_app;

-- Templates ----------------------------------------------------------------------------------
-- A copy of a funnel, a website, a step or a section, to start another from. An agency's
-- template has no business and every business of the agency reads it; a business's own is
-- read there only. The templates that ship with the product are code, not rows.
create table sites.templates (
  id uuid primary key default uuidv7(),
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  business_id uuid,
  kind text not null constraint templates_kind_valid check (kind in ('funnel', 'website', 'step', 'section')),
  name text not null constraint templates_name_length check (length(btrim(name)) between 1 and 120),
  name_normalized text generated always as (lower(btrim(name))) stored,
  description text not null default '' constraint templates_description_length check (length(description) <= 2000),
  category text constraint templates_category_length check (length(btrim(category)) between 1 and 60),
  -- The kind of page: About, Checkout, Coming Soon, and so on.
  page_type text constraint templates_page_type_length check (length(btrim(page_type)) between 1 and 60),
  tags text[] not null default '{}' constraint templates_tags_bounded check (
    cardinality(tags) <= 20 and array_position(tags, null) is null and array_position(tags, '') is null),
  colors text[] not null default '{}' constraint templates_colors_bounded check (
    cardinality(colors) <= 12 and array_position(colors, null) is null),
  preview_file_id uuid,
  uses integer not null default 0 constraint templates_uses_nonnegative check (uses >= 0),
  format integer not null constraint templates_format_positive check (format > 0),
  content jsonb not null constraint templates_content_valid check (
    jsonb_typeof(content) = 'object' and octet_length(content::text) <= 8388608),
  revision integer not null default 1 constraint templates_revision_positive check (revision > 0),
  created_by_kind text not null constraint templates_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id) on delete cascade,
  -- Named: the application tells a file that is not this agency's by this constraint.
  constraint templates_preview_file foreign key (agency_id, preview_file_id)
    references files.files (agency_id, id) on delete set null (preview_file_id)
);
create index templates_scope_idx on sites.templates (agency_id, business_id, kind, created_at desc, id desc);
create index templates_popular_idx on sites.templates (agency_id, kind, uses desc, id desc);
create index templates_preview_file_idx on sites.templates (agency_id, preview_file_id);
create index templates_tags_idx on sites.templates using gin (tags);
call util.enable_scoped_rls('sites.templates');
call util.add_updated_at_trigger('sites.templates');
grant select, insert, update, delete on sites.templates to crm_app;

-- A person's favourites in a business. The template is a plain id: it may be one that
-- ships with the product, which has no row.
create table sites.template_favorites (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  template_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (business_id, user_id, template_id)
);
create index template_favorites_user_idx on sites.template_favorites (user_id);
call util.enable_tenant_rls('sites.template_favorites');
grant select, insert, delete on sites.template_favorites to crm_app;
