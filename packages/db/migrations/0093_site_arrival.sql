-- The arrival survives the funnel (tasks/lead-source-plan.md, stage 2; ADR-091, addendum
-- of 2026-10-13). Three small things, no new table and no tenant data rewritten:
--
-- 1. sites.sites.keep_arrival: whether the pages of a site keep how a visitor arrived, in
--    the visitor's own browser tab, from one page to the next (the owner's decision 4: on
--    unless switched off).
-- 2. private.site_page_state with that setting in it, so a page already rendered is
--    rendered again when the setting changes.
-- 3. crm.contact_attributions.arrival_carried: whether a touch's facts were handed on from
--    the page the visit began on, rather than read from the page the lead was taken on.

-- 'unless_opted_out' (what a site starts with): kept, except for a visitor whose browser
-- sends the Global Privacy Control signal. 'always': kept for every visitor. 'never': the
-- site's pages name no script for it.
alter table sites.sites
  add column keep_arrival text not null default 'unless_opted_out'
    constraint sites_keep_arrival_valid
      check (keep_arrival in ('always', 'unless_opted_out', 'never'));
comment on column sites.sites.keep_arrival is
  'Whether the site''s pages keep how a visitor arrived between pages, in the browser tab only: always, unless_opted_out (not for a visitor who sends the Global Privacy Control signal) or never.';

-- What a site's pages are rendered from (0089, 0090), with one more part: the setting
-- above, last in the array. Everything else is exactly as 0090 builds it. The same name
-- and arguments, replaced in place: a server of the release before this one, running
-- beside the new one while an install is upgraded, reads a different text once and renders
-- its pages again, which is all the text is for.
create or replace function private.site_page_state(
  p_public_key text,
  p_section_ids uuid[],
  p_form_ids uuid[],
  p_calendar_ids uuid[]
)
returns table (agency_id uuid, business_id uuid, site_id uuid, state text)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, s.business_id, s.id,
    jsonb_build_array(
      jsonb_build_array(
        s.kind,
        s.favicon_url,
        (select coalesce(jsonb_agg(
                  jsonb_build_array(t.id, t.name, t.path, t.position, p.id, p.published_version)
                  order by t.position, t.id), '[]'::jsonb)
         from sites.steps t
         join sites.pages p
           on p.business_id = t.business_id and p.step_id = t.id and p.role = 'control'
         where t.business_id = s.business_id and t.site_id = s.id),
        (select coalesce(jsonb_agg(
                  jsonb_build_array(c.id, c.revision, c.updated_at) order by c.id), '[]'::jsonb)
         from sites.saved_sections c
         where c.business_id = s.business_id
           and c.id = any (p_section_ids)
           and (c.site_id is null or c.site_id = s.id)),
        (select coalesce(jsonb_agg(
                  jsonb_build_array(f.id, f.public_key, f.status = 'published') order by f.id),
                  '[]'::jsonb)
         from forms.forms f
         where f.business_id = s.business_id
           and f.id = any (p_form_ids)
           and f.status <> 'archived'),
        (select coalesce(jsonb_agg(
                  jsonb_build_array(h.name_normalized, h.value) order by h.name_normalized),
                  '[]'::jsonb)
         from sites.security_headers h
         where h.business_id = s.business_id and h.site_id = s.id)
      ),
      case when coalesce(cardinality(p_calendar_ids), 0) = 0 then '[]'::jsonb else
        (select coalesce(jsonb_agg(
                  jsonb_build_array(c.id, g.slug, b.slug, c.booking_slug,
                    exists (select from private.resolve_calendar(g.slug, b.slug, c.booking_slug)))
                  order by c.id), '[]'::jsonb)
         from calendar.calendars c
         join tenancy.agencies g on g.id = b.agency_id
         where c.business_id = s.business_id and c.id = any (p_calendar_ids))
      end,
      (select coalesce(jsonb_agg(jsonb_build_array(v.key, v.updated_at) order by v.key), '[]'::jsonb)
       from crm.custom_values v
       where v.business_id = s.business_id and btrim(v.value) <> ''),
      s.keep_arrival
    )::text
  from sites.sites s
  join tenancy.businesses b on b.id = s.business_id
  where s.public_key = p_public_key
    and p_public_key ~ '^[a-z0-9]{24,64}$'
    and b.status = 'active'
$$;

-- A touch whose facts were carried: the lead was taken on one page (page_url) and how the
-- visitor arrived was read from the page their visit began on (landing_url), handed over by
-- the browser. False for every touch from before this, which knew only its own page.
alter table crm.contact_attributions
  add column arrival_carried boolean not null default false;
comment on column crm.contact_attributions.arrival_carried is
  'Whether the facts of the visit were handed on from the page the visit began on (landing_url), rather than read from the page the lead was taken on (page_url).';
