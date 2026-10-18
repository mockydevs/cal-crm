-- External Tracking (Settings → External Tracking, as GoHighLevel names it): one script a
-- business pastes into any website it runs elsewhere. The script reports page views and the
-- forms its visitors send; a form that gives an email address or a phone number makes or
-- finds the contact, and the visitor's earlier page views are linked to it.
--
-- What is kept, and for how long:
-- - forms.tracking_settings: the business's tracking id (public, like a form key: it names
--   the business to the script and authenticates nothing) and what the script may do.
-- - forms.tracking_events: each page view and form submission as received, with the page's
--   host and path (never its query) and the campaign facts of its address. Thirty days.
-- - forms.tracking_page_days: views and submissions of a page on a day, and when it was last
--   seen. Thirteen months.
-- - forms.tracking_visitors: a visitor's random id (the script's, kept in that website's own
--   storage) known to be a contact, since a form of theirs said so. Thirteen months unseen.
-- - forms.external_submissions: what a form on another website sent, for the contact it made
--   or found. Kept as a form's submissions are, and erased with the contact.
-- private.expire_tracking_data is called by the worker's daily purge.

create table forms.tracking_settings (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  tracking_id text not null
    constraint tracking_settings_tracking_id_format check (tracking_id ~ '^tk_[a-z0-9]{32}$'),
  page_views boolean not null default true,
  form_capture boolean not null default true,
  -- The websites the script answers on, by host; a subdomain of one is the same website.
  -- Empty: any website, as GoHighLevel's script has it.
  allowed_domains text[] not null default '{}'
    constraint tracking_settings_allowed_domains_count check (cardinality(allowed_domains) <= 50),
  -- Whether returning visitors are recognised by a random id the script keeps: always,
  -- unless their browser sends Global Privacy Control, or never. As sites.sites.keep_arrival.
  visitor_ids text not null default 'unless_opted_out'
    constraint tracking_settings_visitor_ids_valid
      check (visitor_ids in ('always', 'unless_opted_out', 'never')),
  revision integer not null default 1 constraint tracking_settings_revision_range check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id),
  constraint tracking_settings_tracking_id_unique unique (tracking_id)
);

call util.add_updated_at_trigger('forms.tracking_settings');
call util.enable_tenant_rls('forms.tracking_settings');
grant select, insert, update on forms.tracking_settings to crm_app;

-- What a form on another website sent. Personal data: it goes with its contact.
create table forms.external_submissions (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  contact_id uuid,
  form_name text not null constraint external_submissions_form_name_length
    check (length(form_name) between 1 and 200),
  page_host text not null constraint external_submissions_page_host_length
    check (length(page_host) between 1 and 255),
  page_path text not null constraint external_submissions_page_path_length
    check (length(page_path) between 1 and 2000),
  -- Each field as the page named it: name, label and value.
  fields jsonb not null constraint external_submissions_fields_array
    check (jsonb_typeof(fields) = 'array'),
  lead_source text constraint external_submissions_lead_source_length
    check (length(lead_source) <= 200),
  -- Chosen by the script for each form sent: a request sent twice is stored once.
  client_submission_id uuid not null,
  -- The digest of the view token the submission came with: one page shown gives a few
  -- submissions at most.
  view_mark text not null constraint external_submissions_view_mark_format
    check (view_mark ~ '^[A-Za-z0-9_-]{43}$'),
  submitted_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade
);
create index external_submissions_contact_idx
  on forms.external_submissions (business_id, contact_id) where contact_id is not null;
create unique index external_submissions_client_idx
  on forms.external_submissions (business_id, client_submission_id);
create index external_submissions_view_idx on forms.external_submissions (business_id, view_mark);
create index external_submissions_time_idx on forms.external_submissions (business_id, submitted_at);

call util.enable_tenant_rls('forms.external_submissions');
grant select, insert on forms.external_submissions to crm_app;
-- A contact merge moves them to the contact kept, and changes nothing else of them.
grant update (contact_id) on forms.external_submissions to crm_app;

create table forms.tracking_events (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  kind text not null constraint tracking_events_kind_valid check (kind in ('page_view', 'form_submission')),
  received_at timestamptz not null default now(),
  page_host text not null constraint tracking_events_page_host_length
    check (length(page_host) between 1 and 255),
  page_path text not null constraint tracking_events_page_path_length
    check (length(page_path) between 1 and 2000),
  page_title text constraint tracking_events_page_title_length check (length(page_title) <= 300),
  referrer_domain text constraint tracking_events_referrer_domain_length
    check (length(referrer_domain) <= 255),
  -- The campaign labels of the page's address (utm_*), and which click ids it carried.
  campaign jsonb not null default '{}' constraint tracking_events_campaign_object
    check (jsonb_typeof(campaign) = 'object'),
  visitor_id uuid,
  session_id uuid,
  device_type text constraint tracking_events_device_type_valid
    check (device_type in ('desktop', 'tablet', 'mobile')),
  form_name text constraint tracking_events_form_name_length check (length(form_name) between 1 and 200),
  contact_id uuid,
  submission_id uuid,
  primary key (business_id, id),
  -- An erased contact leaves its page views behind, belonging to nobody.
  foreign key (business_id, contact_id)
    references crm.contacts (business_id, id) on delete set null (contact_id),
  foreign key (business_id, submission_id)
    references forms.external_submissions (business_id, id) on delete set null (submission_id)
);
create index tracking_events_received_idx on forms.tracking_events (business_id, received_at desc);
create index tracking_events_visitor_idx
  on forms.tracking_events (business_id, visitor_id) where visitor_id is not null;
create index tracking_events_contact_idx
  on forms.tracking_events (business_id, contact_id) where contact_id is not null;
create index tracking_events_submission_idx
  on forms.tracking_events (business_id, submission_id) where submission_id is not null;
create index tracking_events_expiry_idx on forms.tracking_events (received_at);

call util.enable_tenant_rls('forms.tracking_events');
grant select, insert on forms.tracking_events to crm_app;
-- A visitor identified later, or a contact merged, changes whose events they are.
grant update (contact_id) on forms.tracking_events to crm_app;

create table forms.tracking_page_days (
  business_id uuid not null,
  page_host text not null constraint tracking_page_days_page_host_length
    check (length(page_host) between 1 and 255),
  page_path text not null constraint tracking_page_days_page_path_length
    check (length(page_path) between 1 and 2000),
  day date not null,
  page_views integer not null default 0 constraint tracking_page_days_page_views_range check (page_views >= 0),
  form_submissions integer not null default 0
    constraint tracking_page_days_form_submissions_range check (form_submissions >= 0),
  last_seen_at timestamptz not null default now(),
  primary key (business_id, page_host, page_path, day),
  foreign key (business_id) references tenancy.businesses (id) on delete cascade
);
create index tracking_page_days_expiry_idx on forms.tracking_page_days (day);

call util.enable_tenant_rls('forms.tracking_page_days');
grant select, insert, update on forms.tracking_page_days to crm_app;

create table forms.tracking_visitors (
  business_id uuid not null,
  visitor_id uuid not null,
  contact_id uuid not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (business_id, visitor_id),
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade
);
create index tracking_visitors_contact_idx on forms.tracking_visitors (business_id, contact_id);
create index tracking_visitors_expiry_idx on forms.tracking_visitors (last_seen_at);

call util.enable_tenant_rls('forms.tracking_visitors');
grant select, insert, update on forms.tracking_visitors to crm_app;

-- The one way across businesses: a tracking id names its business and agency, while the
-- business is active, and the websites the script answers on. What else the script may do
-- is then read in the business, under row-level security.
create function private.resolve_tracking(p_tracking_id text)
returns table (agency_id uuid, business_id uuid, allowed_domains text[])
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, s.business_id, s.allowed_domains
  from forms.tracking_settings s
  join tenancy.businesses b on b.id = s.business_id
  where s.tracking_id = p_tracking_id
    and p_tracking_id ~ '^tk_[a-z0-9]{32}$'
    and b.status = 'active'
$$;
revoke execute on function private.resolve_tracking(text) from public;
grant execute on function private.resolve_tracking(text) to crm_app;

-- Removes, in every business and a bounded number at a time, raw events past thirty days,
-- a page's days past thirteen months and visitors unseen for thirteen months. Gives how
-- many rows went.
create function private.expire_tracking_data(p_limit integer default 5000)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_limit constant integer := least(greatest(p_limit, 1), 50000);
  v_count integer;
  v_total integer := 0;
begin
  with due as (
    select e.business_id, e.id from forms.tracking_events e
    where e.received_at < now() - interval '30 days'
    order by e.received_at
    limit v_limit
    for update skip locked
  )
  delete from forms.tracking_events e using due
  where e.business_id = due.business_id and e.id = due.id;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  with due as (
    select d.business_id, d.page_host, d.page_path, d.day from forms.tracking_page_days d
    where d.day < (current_date - interval '13 months')::date
    order by d.day
    limit v_limit
    for update skip locked
  )
  delete from forms.tracking_page_days d using due
  where d.business_id = due.business_id and d.page_host = due.page_host
    and d.page_path = due.page_path and d.day = due.day;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  with due as (
    select v.business_id, v.visitor_id from forms.tracking_visitors v
    where v.last_seen_at < now() - interval '13 months'
    order by v.last_seen_at
    limit v_limit
    for update skip locked
  )
  delete from forms.tracking_visitors v using due
  where v.business_id = due.business_id and v.visitor_id = due.visitor_id;
  get diagnostics v_count = row_count;
  return v_total + v_count;
end
$$;
revoke execute on function private.expire_tracking_data(integer) from public;
grant execute on function private.expire_tracking_data(integer) to crm_app;

-- A contact's touch can be a form on another website that reached it.
alter table crm.contact_attributions
  drop constraint contact_attributions_subject_kind_valid,
  add constraint contact_attributions_subject_kind_valid
    check (subject_kind in ('contact', 'form_submission', 'appointment', 'webchat_session',
                            'external_submission')) not valid;
-- Checked apart, so the table is not held against writes while its rows are read.
alter table crm.contact_attributions validate constraint contact_attributions_subject_kind_valid;
