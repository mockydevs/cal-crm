-- Duplicate contacts: Settings → Business Profile → "Contact Deduplication Preferences",
-- the near-duplicate finder, and the groups Manage Duplicates was told are not duplicates.
--
-- An email address or a phone number still belongs to one contact in a business
-- (contact_identities_value_unique), so two contacts never share one exactly. The finder
-- looks for near duplicates instead, by a match key on each email address and phone number:
--   * an email address without its +tag, and for gmail.com and googlemail.com (one service,
--     which ignores dots: https://support.google.com/mail/answer/7436150) without dots and
--     under gmail.com. Dots matter at every other provider, so they are kept there;
--   * a phone number's last ten digits, which a number read under the wrong country keeps.
--
-- The key is a plain column the database keeps (a trigger), not a generated one: adding a
-- stored generated column rewrites crm.contact_identities and rebuilds its four indexes,
-- the trigram one too, under an exclusive lock that stops every inbound message matched on
-- it until the rewrite ends. A plain column with no default is added without touching a
-- row. The rows already there get their key from a worker task, a thousand at a time in
-- transactions of their own, queued below for each business that has any.

-- The preferences: GoHighLevel's primary match field (Email by default) and its optional
-- secondary one. As they are here, details are matched as before: by email address, and by
-- phone number only when no email address was given.
alter table crm.settings
  add column duplicate_primary text not null default 'email',
  add column duplicate_secondary text;
alter table crm.settings
  add constraint settings_duplicate_primary_valid
    check (duplicate_primary in ('email', 'phone')) not valid,
  add constraint settings_duplicate_secondary_valid
    check (duplicate_secondary in ('email', 'phone') and duplicate_secondary <> duplicate_primary)
    not valid;

-- The match key of an email address or a phone number as crm.contact_identities stores it
-- (lowercased, or E.164); null for any other kind. A local part that is all +tag or all
-- dots keeps them, so an odd address never shares an empty key.
create function private.contact_match_key(p_kind text, p_value text) returns text
language sql immutable parallel safe set search_path = ''
as $$
  select case
    when p_kind = 'email' then (
      select case
        when parts.domain in ('gmail.com', 'googlemail.com')
          then coalesce(nullif(pg_catalog.replace(parts.local, '.', ''), ''), parts.local)
               || '@gmail.com'
        else parts.local || '@' || parts.domain
      end
      from (
        select case
                 when pg_catalog.strpos(whole.local, '+') > 1
                   then pg_catalog.split_part(whole.local, '+', 1)
                 else whole.local
               end as local,
               whole.domain
        from (select pg_catalog.split_part(p_value, '@', 1) as local,
                     pg_catalog.split_part(p_value, '@', 2) as domain) as whole
      ) as parts)
    when p_kind = 'phone' then pg_catalog.right(pg_catalog.ltrim(p_value, '+'), 10)
  end
$$;
grant execute on function private.contact_match_key(text, text) to crm_app;

alter table crm.contact_identities add column match_key text;
alter table crm.contact_identities
  add constraint contact_identities_match_key_length
    check (match_key is null or length(match_key) between 1 and 320) not valid;
comment on column crm.contact_identities.match_key is
  'What near duplicates share: kept by the database from kind and value_normalized (private.contact_match_key).';

-- Whatever writes an identity, its key follows from its value, and nothing can set another.
create function private.keep_contact_match_key() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.match_key := private.contact_match_key(new.kind, new.value_normalized);
  return new;
end
$$;
create trigger contact_identities_match_key
  before insert or update of kind, value_normalized, match_key on crm.contact_identities
  for each row execute function private.keep_contact_match_key();

create index contact_identities_match_key_idx
  on crm.contact_identities (business_id, kind, match_key) where match_key is not null;

-- Names that may be the same person's: for each of the request's business's live contacts
-- named, the other live contacts (only later ones, by id, when p_later_only, so that a pair
-- is found once from its first contact) whose names are more than 0.6 alike (pg_trgm) and
-- that share a second sign with it: a link to the same company, the same email name (before
-- the @, without a +tag and dots aside, on any domain) or the same last ten phone digits. A
-- name alone puts too many John Smiths together. At most p_per_contact pairs per contact,
-- counted only among those a second sign backs, so namesakes that share nothing never crowd
-- out one that does.
--
-- Run as the owner, outside row-level security, which would not let the look-alikes be
-- found through contacts_display_name_trgm_idx (the trigram operator is not leakproof). It
-- reads only the business the request works in (app.require_business_id() fails closed),
-- and its callers join the ids back under row-level security. The index is used for % at
-- the transaction's pg_trgm.similarity_threshold, which callers set to 0.6 first
-- (set_config, local to the transaction); the explicit 0.6 below holds whatever it is set to.
-- The look-alike step is not ordered, which would make the planner walk the primary key
-- instead of the index. It stops at the first 1,000 look-alikes the index finds for a
-- contact, so a business with thousands of namesakes stays within the statement timeout;
-- a backed pair beyond those is missed until enough of them are merged or renamed.
create function private.similar_contact_names(
  p_contact_ids uuid[], p_later_only boolean, p_per_contact integer
)
returns table (contact_id uuid, similar_id uuid, company boolean, email_name boolean, phone boolean)
language sql stable security definer set search_path = ''
as $$
  with alike as materialized (
    select c.business_id, c.id as a, s.id as o
    from crm.contacts c
    cross join lateral (
      select o.id
      from crm.contacts o
      where o.business_id = c.business_id
        and o.display_name operator(public.%) c.display_name
        and public.similarity(o.display_name, c.display_name) > 0.6
        and o.id <> c.id
        and (not p_later_only or o.id > c.id)
        and o.deleted_at is null
      limit 1000
    ) as s
    where c.business_id = (select app.require_business_id())
      and c.id = any (p_contact_ids)
      and c.deleted_at is null
      and c.display_name is not null
  ), signed as (
    select alike.a, alike.o,
      exists (
        select 1
        from crm.record_links la
        join crm.link_types t
          on t.business_id = la.business_id and t.id = la.link_type_id and t.key = 'contact_company'
        join crm.record_links lo
          on lo.business_id = la.business_id and lo.link_type_id = la.link_type_id
            and lo.to_record_id = la.to_record_id
        where la.business_id = alike.business_id and la.from_record_id = alike.a
          and lo.from_record_id = alike.o
      ) as company,
      exists (
        select 1
        from crm.contact_identities ia
        join crm.contact_identities io
          on io.business_id = ia.business_id and io.kind = 'email'
            and pg_catalog.replace(pg_catalog.split_part(io.match_key, '@', 1), '.', '')
              = pg_catalog.replace(pg_catalog.split_part(ia.match_key, '@', 1), '.', '')
        where ia.business_id = alike.business_id and ia.kind = 'email'
          and ia.contact_id = alike.a and io.contact_id = alike.o
      ) as email_name,
      exists (
        select 1
        from crm.contact_identities ia
        join crm.contact_identities io
          on io.business_id = ia.business_id and io.kind = 'phone' and io.match_key = ia.match_key
        where ia.business_id = alike.business_id and ia.kind = 'phone'
          and ia.contact_id = alike.a and io.contact_id = alike.o
      ) as phone
    from alike
  ), backed as (
    select signed.*, pg_catalog.row_number() over (partition by signed.a order by signed.o) as n
    from signed
    where signed.company or signed.email_name or signed.phone
  )
  select backed.a, backed.o, backed.company, backed.email_name, backed.phone
  from backed
  where backed.n <= p_per_contact
$$;
revoke execute on function private.similar_contact_names(uuid[], boolean, integer) from public;
grant execute on function private.similar_contact_names(uuid[], boolean, integer) to crm_app;

-- A group someone said is not duplicates (GoHighLevel's Reject in Manage Duplicates): how it
-- was found, what its contacts shared, and who they were, sorted. The group is not shown
-- again while every contact in it is one of these. A rejection cannot be undone, so it is
-- never changed or deleted; it goes with its business.
create function private.sorted_uuids(p_ids uuid[]) returns uuid[]
language sql immutable parallel safe set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(distinct id order by id), '{}') from pg_catalog.unnest(p_ids) as id
$$;
-- Checked as each rejection is stored, so whoever stores one runs it.
grant execute on function private.sorted_uuids(uuid[]) to crm_app;

create table crm.duplicate_rejections (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  kind text not null constraint duplicate_rejections_kind_valid
    check (kind in ('email', 'phone', 'name')),
  value_key text not null constraint duplicate_rejections_value_key_length
    check (length(value_key) between 1 and 320),
  contact_ids uuid[] not null,
  -- A whole group, however many share its sign: Reject stores every member, not the 25 shown.
  constraint duplicate_rejections_contacts_count
    check (cardinality(contact_ids) between 2 and 1000 and array_position(contact_ids, null) is null),
  constraint duplicate_rejections_contacts_sorted
    check (contact_ids = private.sorted_uuids(contact_ids)),
  rejected_by_kind text not null constraint duplicate_rejections_rejected_by_kind_valid
    check (rejected_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system')),
  rejected_by_id uuid,
  rejected_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint duplicate_rejections_once unique (business_id, kind, value_key, contact_ids)
);
comment on table crm.duplicate_rejections is
  'Groups of contacts said not to be duplicates: never shown together again by that sign.';

call util.enable_tenant_rls('crm.duplicate_rejections');
grant select, insert on crm.duplicate_rejections to crm_app;

-- The keys of the identities already stored, filled by the worker (contacts.fill_match_keys),
-- one job per business. A new install has none, and creates its queue after these files run.
do $$
begin
  if to_regprocedure('graphile_worker.remove_job(text)') is null then
    return;
  end if;
  perform graphile_worker.add_job(
    'contacts.fill_match_keys',
    payload := jsonb_build_object(
      'agencyId', b.agency_id, 'businessId', b.id,
      'correlationId', uuidv7(), 'causationId', null,
      'data', '{}'::jsonb
    )::json,
    job_key := 'contact-match-keys:' || b.id::text,
    job_key_mode := 'preserve_run_at'
  )
  from tenancy.businesses b
  where exists (
    select 1 from crm.contact_identities i
    where i.business_id = b.id and i.kind in ('email', 'phone') and i.match_key is null);
end
$$;
