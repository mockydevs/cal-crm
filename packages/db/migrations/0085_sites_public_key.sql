-- Sites, stage 1A (tasks/sites-completion-plan.md): a published page answers at the
-- install's own address, /s/<public_key>/<path>, before any domain is connected.
--
-- A site's public key names the site in that address. It is random (122 bits from the
-- system's source, as gen_random_uuid() draws them), made by the database, so every way a
-- site comes to be (new, copied, imported) gets one, and it never changes. It is in the
-- address of every page of the site, so it is public once a page is: it names the site and
-- gives nothing else. An unpublished page answers 404 whoever knows the key.
alter table sites.sites
  add column public_key text not null default replace(gen_random_uuid()::text, '-', '')
    constraint sites_public_key_format check (public_key ~ '^[a-z0-9]{24,64}$'),
  add constraint sites_public_key_unique unique (public_key);

-- The one way from a key to its site across businesses, as for a form (0049): the site,
-- its business and its agency, and only for a key of the right shape and an active
-- business. It says nothing a site holds: the sites module then reads the site, its steps
-- and the published page under row-level security, in that business.
create function private.resolve_site(p_public_key text)
returns table (agency_id uuid, business_id uuid, site_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, s.business_id, s.id
  from sites.sites s
  join tenancy.businesses b on b.id = s.business_id
  where s.public_key = p_public_key
    and p_public_key ~ '^[a-z0-9]{24,64}$'
    and b.status = 'active'
$$;
revoke execute on function private.resolve_site(text) from public;
grant execute on function private.resolve_site(text) to crm_app;
