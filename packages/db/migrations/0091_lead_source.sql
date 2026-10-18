-- Lead source, stage 1 (ADR-091, tasks/lead-source-plan.md): the same form on the same page
-- gives two leads two different sources when one came from a Google ad and the other from a
-- Facebook ad.
--
-- 1. A touch carries its lead source: a short name ("Google Ads") and the rule that decided
--    it, worked out by the CRM module when the touch is written
--    (packages/modules/crm/src/attribution/lead-source.ts). Plus the page the interaction
--    happened on, and two more click ids.
-- 2. A tag and a tag group can be the system's own: the "Source: …" tags a form adds by
--    itself, in the "Lead source" group.
-- 3. A form submission keeps the lead source of its visit, also when it reached no contact.
-- 4. Touches recorded before this are given their lead source, by the same rules.
-- 5. Forms that still give "the name of this form" as the Source are switched to "from how
--    they arrived", with the tag (the owner's decision of 2026-10-13).

-- 1. The touch ------------------------------------------------------------------------------

alter table crm.contact_attributions
  -- The name, as a contact's Source and a tag show it. One line.
  add column source_label text constraint contact_attributions_source_label_valid
    check (length(source_label) between 1 and 200 and source_label !~ '[[:cntrl:]]'),
  -- What decided it: the key of a built-in rule (packages/contracts: leadSourceKeys), which
  -- stays when a name is reworded. A rule of the business's own will be named here by its id.
  add column source_rule text constraint contact_attributions_source_rule_valid
    check (length(source_rule) between 1 and 100),
  -- Where the interaction happened, without its query. landing_url is where the visit began;
  -- the two are the same page until a visit is followed from page to page.
  add column page_url text constraint contact_attributions_page_length
    check (length(page_url) between 1 and 2000),
  -- TikTok's and LinkedIn's click ids, by the names each appends to a landing address
  -- (tasks/lead-source-vendor-facts.md). Kept as the other click ids are: only here.
  add column ttclid text,
  add column li_fat_id text,
  add constraint contact_attributions_click_ids_bounded check (
    coalesce(length(ttclid), 1) between 1 and 200 and coalesce(length(li_fat_id), 1) between 1 and 200
  ),
  -- A name always comes with what decided it.
  add constraint contact_attributions_source_paired
    check ((source_label is null) = (source_rule is null));

comment on column crm.contact_attributions.source_label is
  'The lead source: one name for how the lead arrived, such as Google Ads. Null for a touch that was not a visit to a page.';
comment on column crm.contact_attributions.source_rule is
  'What decided source_label: the key of a built-in rule, such as google_ads.';

-- "Leads from Google Ads this month": by name, then by time.
create index contact_attributions_source_label_idx
  on crm.contact_attributions (business_id, source_label, touched_at)
  where source_label is not null;

-- 2. The system's own tags --------------------------------------------------------------------
--
-- Only people make tags (crm: tags/access.ts). The one exception is the tag a form adds for
-- a lead source, which must exist before the first such lead can carry it. Such a tag is
-- known by a key, not by its name, so renaming it does not make a second one. The key can
-- only be a lead source's: nothing else may mark a tag as the system's.

alter table crm.tags
  add column system_key text constraint tags_system_key_valid
    check (system_key ~ '^lead_source:[a-z][a-z_]{0,39}$');
create unique index tags_system_key_idx
  on crm.tags (business_id, system_key) where system_key is not null;
comment on column crm.tags.system_key is
  'Set on a tag the system keeps by itself: lead_source:<key> for the tag of a built-in lead source. Null for every tag a person made.';

alter table crm.tag_groups
  add column system_key text constraint tag_groups_system_key_valid
    check (system_key = 'lead_source');
create unique index tag_groups_system_key_idx
  on crm.tag_groups (business_id, system_key) where system_key is not null;
comment on column crm.tag_groups.system_key is
  'Set on the group the system keeps its lead source tags in. Null for every other group.';

-- 3. The submission ---------------------------------------------------------------------------

alter table forms.submissions
  add column lead_source text constraint submissions_lead_source_valid
    check (length(lead_source) between 1 and 200 and lead_source !~ '[[:cntrl:]]'),
  add column lead_source_rule text constraint submissions_lead_source_rule_valid
    check (length(lead_source_rule) between 1 and 100),
  add constraint submissions_lead_source_paired
    check ((lead_source is null) = (lead_source_rule is null));

-- 4. Touches recorded before this ----------------------------------------------------------------
--
-- The rules of lead-source.ts, written once more in SQL for the rows that were stored
-- before the rules existed. Such a row has no source= (never kept) and neither of the two
-- new click ids, so those rules have nothing to read here. The function lives for this
-- migration only: from here on, the module names every touch as it writes it.
-- packages/db/src/lead-source-backfill.int.test.ts holds this to the outcomes of the
-- module's own table of cases.

create function pg_temp.lead_source_rule(t crm.contact_attributions) returns text
language plpgsql immutable
as $$
declare
  source text := lower(coalesce(t.utm_source, ''));
  medium text := lower(coalesce(t.utm_medium, ''));
  host text := lower(t.referrer_domain);
  labels text[];
  names text[] := '{}';
  word text;
  platform text;
  site text;
  paid_medium boolean;
  paid boolean;
  email constant text := '^(email|e-mail|e_mail|e mail)$';
begin
  -- Google Analytics' expression for a paid medium.
  paid_medium := medium ~ '^(.*cp.*|ppc|retargeting|paid.*)$';
  paid := paid_medium or right(source, 3) = '_ad' or position('adwords' in source) > 0
          or t.campaign_id is not null or t.ad_id is not null;

  -- The platform: what utm_source names (its first word that names one), then a click id
  -- only one platform writes, then the site the visitor came from.
  foreach word in array regexp_split_to_array(source, '[^a-z0-9]+') loop
    platform := case
      when word in ('google', 'googleads', 'adwords') then 'google'
      when word in ('bing', 'microsoft') then 'microsoft'
      when word in ('yahoo', 'duckduckgo', 'baidu', 'yandex', 'ecosia', 'startpage', 'qwant', 'brave') then 'search'
      when word in ('facebook', 'fb', 'meta', 'messenger') then 'facebook'
      when word in ('instagram', 'ig') then 'instagram'
      when word = 'linkedin' then 'linkedin'
      when word = 'tiktok' then 'tiktok'
      when word = 'youtube' then 'youtube'
      when word in ('twitter', 'x') then 'x'
      when word in ('reddit', 'pinterest', 'snapchat', 'whatsapp', 'threads', 'telegram') then 'social'
    end;
    exit when platform is not null;
  end loop;
  if platform is null and host is not null then
    -- A site is known by a label of its host (never the last one, the top-level domain),
    -- or by a short address matched whole.
    labels := string_to_array(host, '.');
    if cardinality(labels) > 1 then
      names := labels[1 : cardinality(labels) - 1];
    end if;
    site := case
      when names && array['google'] then 'google'
      when names && array['bing'] then 'microsoft'
      when names && array['facebook', 'messenger']
        or host in ('fb.com', 'fb.me') or host like '%.fb.com' or host like '%.fb.me' then 'facebook'
      when names && array['instagram'] then 'instagram'
      when names && array['linkedin'] or host = 'lnkd.in' or host like '%.lnkd.in' then 'linkedin'
      when names && array['tiktok'] then 'tiktok'
      when names && array['youtube'] or host = 'youtu.be' or host like '%.youtu.be' then 'youtube'
      when names && array['twitter']
        or host in ('x.com', 't.co') or host like '%.x.com' or host like '%.t.co' then 'x'
      when names && array['yahoo', 'duckduckgo', 'baidu', 'yandex', 'ecosia', 'startpage', 'qwant']
        or host = 'search.brave.com' or host like '%.search.brave.com' then 'search'
      when names && array['reddit', 'pinterest', 'snapchat', 'whatsapp', 'threads', 'telegram']
        or host in ('wa.me', 't.me') or host like '%.wa.me' or host like '%.t.me' then 'social'
    end;
  end if;
  -- Meta writes fbclid for Facebook and Instagram alike: the site says which it was.
  if platform is null and (t.fbclid is not null or t.ctwa_clid is not null) then
    platform := case when site = 'instagram' then 'instagram' else 'facebook' end;
  end if;
  platform := coalesce(platform, site);

  if t.gclid is not null or t.gbraid is not null or t.wbraid is not null then return 'google_ads'; end if;
  if position('adwords' in source) > 0 or (platform = 'google' and paid) then return 'google_ads'; end if;
  if t.msclkid is not null or (platform = 'microsoft' and paid) then return 'microsoft_ads'; end if;
  if platform = 'instagram' and (paid or t.ctwa_clid is not null) then return 'instagram_ads'; end if;
  if t.ctwa_clid is not null or (platform = 'facebook' and paid) then return 'facebook_ads'; end if;
  if platform = 'tiktok' and paid then return 'tiktok_ads'; end if;
  if platform = 'linkedin' and paid then return 'linkedin_ads'; end if;
  if paid_medium or right(source, 3) = '_ad' then return 'paid_other'; end if;
  if medium ~ email or source ~ email then return 'email'; end if;
  if medium = 'sms' then return 'sms'; end if;
  if platform in ('google', 'microsoft', 'search') then return 'organic_search'; end if;
  if platform is not null then return platform; end if;
  if host is not null then return 'referral'; end if;
  if coalesce(t.utm_source, t.utm_medium, t.utm_campaign, t.utm_content, t.utm_term, t.match_type,
              t.campaign_id, t.ad_group_id, t.ad_id, t.fbclid) is not null then
    return 'other';
  end if;
  return 'direct';
end
$$;

-- As the owner (no row-level security). Only a visit to a page has a lead source.
with named as (
  select t.business_id, t.id, pg_temp.lead_source_rule(t) as key
  from crm.contact_attributions t
  where t.medium in ('form', 'calendar', 'chat')
)
update crm.contact_attributions t
set source_rule = named.key, source_label = label.name, page_url = t.landing_url
from named
join (values
  ('google_ads', 'Google Ads'), ('microsoft_ads', 'Microsoft Ads'), ('facebook_ads', 'Facebook Ads'),
  ('instagram_ads', 'Instagram Ads'), ('tiktok_ads', 'TikTok Ads'), ('linkedin_ads', 'LinkedIn Ads'),
  ('paid_other', 'Paid (other)'), ('email', 'Email'), ('sms', 'SMS'),
  ('organic_search', 'Organic Search'), ('facebook', 'Facebook'), ('instagram', 'Instagram'),
  ('linkedin', 'LinkedIn'), ('tiktok', 'TikTok'), ('youtube', 'YouTube'), ('x', 'X'),
  ('social', 'Social'), ('referral', 'Referral'), ('other', 'Other'), ('direct', 'Direct')
) as label (key, name) on label.key = named.key
where named.business_id = t.business_id and named.id = t.id;

drop function pg_temp.lead_source_rule(crm.contact_attributions);

-- The session source of those touches stays as it was decided when each was recorded: it is
-- history, and the two rules added to it (paid social and paid search by a paid marker)
-- apply from here on.

-- A submission that reached a contact takes the lead source of the touch it recorded.
update forms.submissions s
set lead_source = t.source_label, lead_source_rule = t.source_rule
from crm.contact_attributions t
where t.business_id = s.business_id and t.subject_kind = 'form_submission' and t.subject_id = s.id
  and t.source_label is not null;

-- 5. Forms on "the name of this form" ---------------------------------------------------------------
--
-- A form's choices are in its document (packages/contracts: formContactActions). "The name
-- of this form" stays a choice a person can make, so a reader could not tell a form that
-- was left on the old default from one set to it on purpose tomorrow: the documents are
-- changed once, here. Only the two keys are written. A document that names another source
-- (a fixed text, or none) keeps it, and is told in so many words that it adds no tag for the
-- lead source, which is what it did; one that has no contactActions at all is left exactly
-- as it is.
-- A form's draft and what it has published are each changed by the same rule, so a
-- published form still serves what its draft says. A document within a few bytes of its
-- size limit is left alone rather than pushed past it.

create function pg_temp.source_from_arrival(document jsonb) returns jsonb
language sql immutable strict
as $$
  select case
    when jsonb_typeof(document -> 'contactActions') = 'object'
      and (not (document -> 'contactActions') ? 'source'
           or document #>> '{contactActions,source,kind}' = 'form_name')
      and octet_length(document::text) <= 131000
    then jsonb_set(
      document, '{contactActions}',
      (document -> 'contactActions') || '{"source": {"kind": "arrived"}, "tagBySource": true}'::jsonb)
    when jsonb_typeof(document -> 'contactActions') = 'object'
      and not (document -> 'contactActions') ? 'tagBySource'
      and octet_length(document::text) <= 131000
    then jsonb_set(document, '{contactActions,tagBySource}', 'false'::jsonb)
    else document
  end
$$;

update forms.forms
set definition = pg_temp.source_from_arrival(definition),
    published_definition = pg_temp.source_from_arrival(published_definition)
where definition is distinct from pg_temp.source_from_arrival(definition)
   or published_definition is distinct from pg_temp.source_from_arrival(published_definition);

drop function pg_temp.source_from_arrival(jsonb);
