-- Reporting stage 1 (ADR-088, tasks/reporting-plan.md): where a contact came from, saved
-- reports, and the indexes the report queries read their date ranges from.

-- 1. Attribution ---------------------------------------------------------------------------
--
-- A touch is one recorded interaction of a contact: a form sent, a booking, a chat, or being
-- added by hand, by an import or by an integration. Every contact has at least one. The
-- first never changes; the latest moves with each new touch. Both are flags, so a report
-- joins a contact to one row through a unique index instead of ranking its touches.
--
-- A click id (gclid, fbclid and the like) identifies a visit. It is kept here only, on the
-- contact the visitor chose to become, and goes when the contact is purged.

create table crm.contact_attributions (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  contact_id uuid not null,
  touched_at timestamptz not null default now(),
  -- The kind of interaction that recorded it.
  medium text not null constraint contact_attributions_medium_valid check (medium in (
    'form', 'calendar', 'chat', 'manual', 'api', 'import', 'message', 'automation', 'assistant', 'unknown'
  )),
  -- The channel, decided when the touch is written (crm: attribution/session-source.ts).
  session_source text not null constraint contact_attributions_session_source_valid check (session_source in (
    'paid_search', 'paid_social', 'social_media', 'organic_search', 'referral', 'direct',
    'others', 'crm_ui', 'third_party'
  )),
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  match_type text,
  campaign_id text,
  ad_group_id text,
  ad_id text,
  gclid text,
  gbraid text,
  wbraid text,
  fbclid text,
  msclkid text,
  ctwa_clid text,
  -- The host the visitor came from, and the page without its query.
  referrer_domain text constraint contact_attributions_referrer_length check (length(referrer_domain) between 1 and 255),
  landing_url text constraint contact_attributions_landing_length check (length(landing_url) between 1 and 2000),
  -- What recorded it: a form submission, an appointment, a web chat session, or the contact
  -- itself for the touch written when it was made.
  subject_kind text not null constraint contact_attributions_subject_kind_valid
    check (subject_kind in ('contact', 'form_submission', 'appointment', 'webchat_session')),
  subject_id uuid not null,
  is_first boolean not null default false,
  is_latest boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade,
  -- Labels and ids from an address: bounded, as forms.submissions.utm is (0049).
  constraint contact_attributions_values_bounded check (
    coalesce(length(utm_source), 1) between 1 and 200 and coalesce(length(utm_medium), 1) between 1 and 200
    and coalesce(length(utm_campaign), 1) between 1 and 200 and coalesce(length(utm_content), 1) between 1 and 200
    and coalesce(length(utm_term), 1) between 1 and 200 and coalesce(length(match_type), 1) between 1 and 200
    and coalesce(length(campaign_id), 1) between 1 and 200 and coalesce(length(ad_group_id), 1) between 1 and 200
    and coalesce(length(ad_id), 1) between 1 and 200 and coalesce(length(gclid), 1) between 1 and 200
    and coalesce(length(gbraid), 1) between 1 and 200 and coalesce(length(wbraid), 1) between 1 and 200
    and coalesce(length(fbclid), 1) between 1 and 200 and coalesce(length(msclkid), 1) between 1 and 200
    and coalesce(length(ctwa_clid), 1) between 1 and 200
  )
);
comment on table crm.contact_attributions is
  'One row for each recorded interaction of a contact (a touch): where it came from. is_first marks the one that never changes, is_latest the newest.';

create index contact_attributions_contact_idx
  on crm.contact_attributions (business_id, contact_id, touched_at);
create index contact_attributions_touched_idx
  on crm.contact_attributions (business_id, touched_at);
create index contact_attributions_campaign_idx
  on crm.contact_attributions (business_id, campaign_id) where campaign_id is not null;
-- One first and one latest touch a contact: what a report joins through.
create unique index contact_attributions_first_idx
  on crm.contact_attributions (business_id, contact_id) where is_first;
create unique index contact_attributions_latest_idx
  on crm.contact_attributions (business_id, contact_id) where is_latest;

call util.enable_tenant_rls('crm.contact_attributions');

-- Written with the contact or the interaction; the latest flag moves, and the touch a
-- contact was made with is filled in by the form, booking or chat that made it, in the same
-- transaction. Nothing deletes one but the purge of its contact.
grant select, insert, update on crm.contact_attributions to crm_app;

-- Backfill, as the owner (no row-level security): one touch for each form submission that
-- reached a contact, with the campaign labels the submission kept. A submission kept no
-- referrer and no click id, so only the rules that read utm_source can decide the channel;
-- the rest are direct (no label at all) or others (labels no rule names).
insert into crm.contact_attributions
  (business_id, contact_id, touched_at, medium, session_source,
   utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_url,
   subject_kind, subject_id)
select s.business_id, s.contact_id, s.submitted_at, 'form',
       case
         when lower(coalesce(s.utm ->> 'source', '')) like '%adwords%' then 'paid_search'
         when lower(coalesce(s.utm ->> 'source', '')) ~ '(fb_ad|linkedin_ad|twitter_ad|reddit_ad)' then 'paid_social'
         when s.utm = '{}'::jsonb then 'direct'
         else 'others'
       end,
       nullif(left(s.utm ->> 'source', 200), ''), nullif(left(s.utm ->> 'medium', 200), ''),
       nullif(left(s.utm ->> 'campaign', 200), ''), nullif(left(s.utm ->> 'content', 200), ''),
       nullif(left(s.utm ->> 'term', 200), ''), nullif(left(s.page_url, 2000), ''),
       'form_submission', s.id
from forms.submissions s
join crm.contacts c on c.business_id = s.business_id and c.id = s.contact_id
where s.contact_id is not null;

-- And one for every contact that has none yet, from how it came to be (crm.contacts.created_source).
insert into crm.contact_attributions
  (business_id, contact_id, touched_at, medium, session_source, subject_kind, subject_id)
select c.business_id, c.id, c.created_at,
       case c.created_source
         when 'user' then 'manual' when 'api' then 'api' when 'import' then 'import'
         when 'automation' then 'automation' when 'assistant' then 'assistant'
         when 'email' then 'message' when 'sms' then 'message' when 'webchat' then 'chat'
         when 'form' then 'form' when 'booking' then 'calendar' else 'unknown'
       end,
       case c.created_source
         when 'user' then 'crm_ui'
         when 'api' then 'third_party' when 'import' then 'third_party'
         when 'automation' then 'third_party' when 'assistant' then 'third_party'
         when 'webchat' then 'direct' when 'form' then 'direct' when 'booking' then 'direct'
         else 'others'
       end,
       'contact', c.id
from crm.contacts c
where not exists (
  select 1 from crm.contact_attributions t
  where t.business_id = c.business_id and t.contact_id = c.id
);

-- The first and the latest of each contact: by time, then by id.
update crm.contact_attributions t
set is_first = (ranked.first_rank = 1), is_latest = (ranked.latest_rank = 1)
from (
  select business_id, id,
         row_number() over (partition by business_id, contact_id order by touched_at, id) as first_rank,
         row_number() over (partition by business_id, contact_id order by touched_at desc, id desc) as latest_rank
  from crm.contact_attributions
) ranked
where ranked.business_id = t.business_id and ranked.id = t.id
  and (ranked.first_rank = 1 or ranked.latest_rank = 1);

-- 2. Saved reports ---------------------------------------------------------------------------
--
-- A report is a document of pages and widgets (packages/contracts: reporting.ts). The
-- definition is the document; a widget's query is compiled by the server each time it is
-- run, from the catalogue only. Deleting moves it out of the list (deleted_at).

create table reporting.reports (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  name text not null constraint reports_name_length check (length(name) between 1 and 120),
  definition jsonb not null constraint reports_definition_object check (jsonb_typeof(definition) = 'object'),
  definition_version integer not null constraint reports_definition_version_positive check (definition_version >= 1),
  -- The template it was made from, if any: the list then names the Template Library as its maker.
  template_key text constraint reports_template_key_format check (template_key ~ '^[a-z][a-z0-9_]{0,59}$'),
  created_by_kind text not null,
  created_by_id uuid,
  -- Everyone who may read reports in the business, or its maker alone. Stage 1 writes shared only.
  visibility text not null default 'shared' constraint reports_visibility_valid check (visibility in ('shared', 'private')),
  -- Goes up by one with every save: a save names the one it read.
  revision integer not null default 1 constraint reports_revision_positive check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (business_id, id)
);
comment on table reporting.reports is
  'A saved custom report: its name and its definition, a document of pages and widgets.';

-- The list: newest first, without the deleted ones.
create index reports_list_idx on reporting.reports (business_id, id desc) where deleted_at is null;

call util.add_updated_at_trigger('reporting.reports');

call util.enable_tenant_rls('reporting.reports');
grant select, insert, update on reporting.reports to crm_app;

-- 3. Dates reports read ------------------------------------------------------------------------
--
-- A report counts a business's rows over a range of one date. Contacts by creation
-- (contacts_list_idx, 0021) and appointments by start and by booking (0057, 0066) have an
-- index already. Deals are indexed by pipeline first (0057), and a report reads every
-- pipeline at once.

create index deals_report_created_idx
  on crm.deals (business_id, created_at) where deleted_at is null;
create index deals_report_status_changed_idx
  on crm.deals (business_id, status_changed_at) where deleted_at is null;
create index deals_report_closed_idx
  on crm.deals (business_id, closed_at) where deleted_at is null and closed_at is not null;
create index appointments_cancelled_idx
  on calendar.appointments (business_id, cancelled_at) where cancelled_at is not null;
