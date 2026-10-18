-- Sites: a page's working draft, and what a page's state is made from now that a page can
-- link to a calendar and fill in the business's custom values.
--
-- 1. The working draft. Until now every save of a page was a version, and a version was
--    never rewritten (0070). The editor saves by itself after each pause, so the thirty
--    versions a page keeps covered minutes of work. From here a page may have ONE version
--    that is still open, its working draft, which an autosave rewrites in place; every
--    other version is kept: written once, never again. Which is which is a column, and the
--    rule is the table's own, not only the application's:
--      - a kept version (draft = false) can never be updated, by anyone;
--      - a version that was kept can never be opened again;
--      - the version a page has published can never be a draft, so what visitors are
--        shown is always a kept version, and its number still names its content, which is
--        what private.site_page_state compares (0089).
-- 2. private.site_page_state with two more things a page may be made from: the calendars
--    it links to, and the business's custom values, which fill in its merge fields.

alter table sites.page_versions
  add column draft boolean not null default false,
  add column name text constraint page_versions_name_valid
    check (name is null or (name = btrim(name) and char_length(name) between 1 and 120)),
  add column updated_at timestamptz not null default now(),
  -- A name is given to a version kept on purpose, never to one still being written.
  add constraint page_versions_draft_unnamed check (not draft or name is null);

-- Every version there is was written once, when it was created.
update sites.page_versions set updated_at = created_at;

-- A kept version is never rewritten, and nothing of a version but its content, its name
-- and whether it is still open ever changes.
create function sites.guard_page_version() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not old.draft then
    raise exception 'a kept version of a page is never rewritten'
      using errcode = '55000', constraint = 'page_versions_kept_immutable';
  end if;
  if new.business_id is distinct from old.business_id
     or new.id is distinct from old.id
     or new.page_id is distinct from old.page_id
     or new.number is distinct from old.number
     or new.restored_from is distinct from old.restored_from
     or new.created_by_kind is distinct from old.created_by_kind
     or new.created_by_id is distinct from old.created_by_id
     or new.created_at is distinct from old.created_at then
    raise exception 'only the content of a working draft changes'
      using errcode = '55000', constraint = 'page_versions_identity_immutable';
  end if;
  return new;
end
$$;
create trigger guard_page_version before update on sites.page_versions
  for each row execute function sites.guard_page_version();
-- When a working draft was last written: set on every update, as for every table that
-- has the column. (It fires after the guard above, by name, so only on a draft.)
call util.add_updated_at_trigger('sites.page_versions');

-- Written, removed, and, for a working draft only, rewritten.
grant update (document, format, draft, name) on sites.page_versions to crm_app;

-- What a page has published is a kept version: a draft is kept (draft = false) before it
-- goes live, in the same statement's transaction, or the publish is refused here.
create function sites.guard_published_version() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.published_version is not null and exists (
    select from sites.page_versions v
    where v.business_id = new.business_id
      and v.page_id = new.id
      and v.number = new.published_version
      and v.draft
  ) then
    raise exception 'a working draft cannot be published before it is kept'
      using errcode = '55000', constraint = 'pages_published_version_kept';
  end if;
  return new;
end
$$;
create trigger guard_published_version
  before insert or update of published_version on sites.pages
  for each row execute function sites.guard_published_version();

-- The working draft of a page is its newest version, so a page has at most one: found by
-- the page and the number, which the unique constraint of 0070 already indexes.

-- What a site's pages are rendered from (0089), with two more parts:
--   - of the calendars asked about, each by what its link is made of (the agency's, the
--     business's and its own address names) and whether it can be booked right now, which
--     is exactly what its booking page asks (private.resolve_calendar, 0048);
--   - the business's custom values that have something in them, each by its key and the
--     moment of its last change: they fill in a page's merge fields.
-- The value is an array of three: the state of 0089 exactly as that function builds it
-- (written out again here rather than called, so a visit is still one statement planned
-- once), then the calendars, then the values. A page with no calendar asks about none,
-- and that part is then not read at all.
-- The three-argument form stays for a server of the release before this one, which runs
-- beside the new one while an install is upgraded.
create function private.site_page_state(
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
       where v.business_id = s.business_id and btrim(v.value) <> '')
    )::text
  from sites.sites s
  join tenancy.businesses b on b.id = s.business_id
  where s.public_key = p_public_key
    and p_public_key ~ '^[a-z0-9]{24,64}$'
    and b.status = 'active'
$$;
revoke execute on function private.site_page_state(text, uuid[], uuid[], uuid[]) from public;
grant execute on function private.site_page_state(text, uuid[], uuid[], uuid[]) to crm_app;

-- A calendar a page links to, as the page's checks and its renderer need it: the three
-- names its booking address is made of, and whether it can be booked right now. Read in
-- the business the caller is in (row-level security on calendar.calendars decides which
-- rows are seen); the names of the agency and the business are read here because a
-- member's own role cannot read the agency's row.
create function private.site_calendar_links(p_calendar_ids uuid[])
returns table (calendar_id uuid, agency_slug text, business_slug text, calendar_slug text, bookable boolean)
language sql stable security definer set search_path = ''
as $$
  select c.id, g.slug, b.slug, c.booking_slug,
    exists (select from private.resolve_calendar(g.slug, b.slug, c.booking_slug))
  from calendar.calendars c
  join tenancy.businesses b on b.id = c.business_id
  join tenancy.agencies g on g.id = b.agency_id
  where c.id = any (p_calendar_ids)
    and c.business_id = (select app.business_id())
$$;
revoke execute on function private.site_calendar_links(uuid[]) from public;
grant execute on function private.site_calendar_links(uuid[]) to crm_app;
