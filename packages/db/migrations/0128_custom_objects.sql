-- Custom objects and associations, as GoHighLevel's Settings → Objects has them: a business
-- defines its own kinds of record (Property, Pet, Event), each with an icon, a primary display
-- field that names its records, searchable and unique fields, and associations, named links
-- between any two objects with a label on each side and a limit on each side.
--
-- 0005 already has the shape: an object is a crm.object_types row, a record of a custom object
-- a crm.records row of kind custom with its crm.custom_records row, its data crm.field_values,
-- an association a crm.link_types row and a relation a crm.record_links row. This adds what
-- those rows lack. The built-in links keep their keys, rows and meaning.
--
-- Constraints added to tables that already have rows are added NOT VALID and validated
-- after. The migration runs in one transaction, so the tables it alters (crm.object_types,
-- crm.field_definitions, crm.records, crm.custom_records, crm.link_types) stay locked
-- against reads and writes until it commits, and crm.record_links and crm.field_values
-- against writes while their new indexes build. The longest steps are the unique index on
-- crm.records and the trigram index on crm.field_values.

-- Objects ---------------------------------------------------------------------------------------
-- An icon (a name from the dashboard's icon set, which the application lists), who made the
-- object, and its primary field: the field whose value is each record's name. The primary
-- field is made with its object, in the same transaction, so the reference waits for the end
-- of it; it must be a field of the same object.

alter table crm.object_types
  add column icon text,
  add column primary_field_id uuid,
  add column created_by_kind text not null default 'system',
  add column created_by_id uuid;
alter table crm.object_types
  add constraint object_types_icon_format check (icon ~ '^[a-z0-9-]{1,40}$') not valid,
  add constraint object_types_custom_has_primary
    check (kind <> 'custom' or primary_field_id is not null) not valid,
  add constraint object_types_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import'))
    not valid;
alter table crm.object_types validate constraint object_types_icon_format;
alter table crm.object_types validate constraint object_types_custom_has_primary;
alter table crm.object_types validate constraint object_types_created_by_kind_valid;

-- What the primary field's reference points at: a field together with its object.
alter table crm.field_definitions
  add constraint field_definitions_id_object_unique unique (business_id, id, object_type_id);
alter table crm.object_types
  add constraint object_types_primary_field_fkey
    foreign key (business_id, primary_field_id, id)
    references crm.field_definitions (business_id, id, object_type_id)
    deferrable initially deferred not valid;
alter table crm.object_types validate constraint object_types_primary_field_fkey;
create index object_types_primary_field_idx on crm.object_types (business_id, primary_field_id)
  where primary_field_id is not null;
comment on column crm.object_types.primary_field_id is
  'The field whose value names each record of a custom object. Chosen when the object is made; it never changes.';

-- GoHighLevel: "Can I change the Internal Name or Primary Display Field later? No". Nor does
-- an object change kind or business. The application says so in words first.
create function private.guard_object_type() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.business_id is distinct from old.business_id
     or new.key is distinct from old.key
     or new.kind is distinct from old.kind
     or new.primary_field_id is distinct from old.primary_field_id then
    raise exception 'An object keeps its key, its kind and its primary field.'
      using errcode = 'check_violation', constraint = 'object_types_identity_fixed';
  end if;
  return new;
end
$$;
revoke execute on function private.guard_object_type() from public;
create trigger object_types_guard before update on crm.object_types
  for each row execute function private.guard_object_type();

-- Searchable and unique fields --------------------------------------------------------------------
-- A searchable field is searched with its object's records (GoHighLevel's searchable
-- properties); only text is searched. A unique field's value belongs to one record of its
-- object (GoHighLevel: single line, multi line, number and phone fields), and a field that
-- stops being unique stays so: GoHighLevel's downgrade is irreversible.

alter table crm.field_definitions
  add column is_searchable boolean not null default false,
  add column is_unique boolean not null default false;
alter table crm.field_definitions
  add constraint field_definitions_searchable_type
    check (not is_searchable or value_type in ('text', 'long_text', 'email', 'phone', 'url')) not valid,
  add constraint field_definitions_unique_type
    check (not is_unique or value_type in ('text', 'long_text', 'number', 'phone')) not valid;
alter table crm.field_definitions validate constraint field_definitions_searchable_type;
alter table crm.field_definitions validate constraint field_definitions_unique_type;

create function private.guard_field_uniqueness() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.is_unique and not old.is_unique then
    raise exception 'A field becomes unique only when it is made.'
      using errcode = 'check_violation', constraint = 'field_definitions_unique_one_way';
  end if;
  return new;
end
$$;
revoke execute on function private.guard_field_uniqueness() from public;
create trigger field_definitions_uniqueness before update of is_unique on crm.field_definitions
  for each row execute function private.guard_field_uniqueness();

-- Nor is a unique field ever deleted, whatever the application asks: it is made not unique
-- first. It still goes with its object type, since referential actions are not subject to
-- row-level security.
alter policy field_definitions_delete_own_only on crm.field_definitions
  using (not is_system and not is_unique);

-- The ledger of unique values: one row for each value of a unique field, keyed by the value
-- as it is compared (without case or surrounding spaces; a phone number as E.164; a number
-- without trailing zeros), hashed so that a long text fits the index. Two records with one
-- value clash on its primary key, whoever writes them: GoHighLevel enforces uniqueness
-- "across all record creation methods".
create table crm.field_unique_values (
  business_id uuid not null,
  field_id uuid not null,
  value_key text not null constraint field_unique_values_key_format check (value_key ~ '^[0-9a-f]{64}$'),
  record_id uuid not null,
  constraint field_unique_values_pkey primary key (business_id, field_id, value_key),
  constraint field_unique_values_one_per_record unique (business_id, record_id, field_id),
  foreign key (business_id, record_id, field_id)
    references crm.field_values (business_id, record_id, field_id) on delete cascade
);
comment on table crm.field_unique_values is
  'One row per value of a unique field, kept by the database from crm.field_values.';
call util.enable_tenant_rls('crm.field_unique_values');
grant select, insert, update, delete on crm.field_unique_values to crm_app;

create function private.keep_unique_value() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not exists (
    select 1 from crm.field_definitions f
    where f.business_id = new.business_id and f.id = new.field_id and f.is_unique) then
    return null;
  end if;
  insert into crm.field_unique_values (business_id, field_id, value_key, record_id)
  values (
    new.business_id, new.field_id,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(case new.value_type
      when 'number' then pg_catalog.trim_scale(new.value_number)::text
      when 'phone' then new.value_text
      else pg_catalog.lower(pg_catalog.btrim(new.value_text))
    end, 'UTF8')), 'hex'),
    new.record_id)
  on conflict (business_id, record_id, field_id) do update set value_key = excluded.value_key;
  return null;
end
$$;
revoke execute on function private.keep_unique_value() from public;
create trigger field_values_unique_value
  after insert or update of value_text, value_number on crm.field_values
  for each row when (new.value_type in ('text', 'long_text', 'number', 'phone'))
  execute function private.keep_unique_value();

-- A field that stops being unique leaves the ledger.
create function private.release_unique_values() returns trigger
language plpgsql set search_path = ''
as $$
begin
  delete from crm.field_unique_values
  where business_id = new.business_id and field_id = new.id;
  return null;
end
$$;
revoke execute on function private.release_unique_values() from public;
create trigger field_definitions_release_unique_values
  after update of is_unique on crm.field_definitions
  for each row when (old.is_unique and not new.is_unique)
  execute function private.release_unique_values();

-- Records of custom objects ----------------------------------------------------------------------------
-- A custom record carries its object, so its object's records list from one index; the
-- object is the registry row's, filled in whoever writes the record, and must be a custom one.
-- Nothing has written custom records yet, so the column is filled and made required at once.

alter table crm.records
  add constraint records_id_object_type_unique unique (business_id, id, object_type_id);

alter table crm.custom_records add column object_type_id uuid;
update crm.custom_records c
set object_type_id = r.object_type_id
from crm.records r
where r.business_id = c.business_id and r.id = c.id;
alter table crm.custom_records alter column object_type_id set not null;
alter table crm.custom_records
  add constraint custom_records_object_type_fkey
    foreign key (business_id, object_type_id, kind)
    references crm.object_types (business_id, id, kind) not valid,
  add constraint custom_records_registry_object_fkey
    foreign key (business_id, id, object_type_id)
    references crm.records (business_id, id, object_type_id) on delete cascade not valid;
alter table crm.custom_records validate constraint custom_records_object_type_fkey;
alter table crm.custom_records validate constraint custom_records_registry_object_fkey;
create index custom_records_object_type_idx on crm.custom_records (business_id, object_type_id, kind);
-- An object's records, most recently changed first, and their names in any part.
create index custom_records_list_idx
  on crm.custom_records (business_id, object_type_id, updated_at desc, id desc)
  where deleted_at is null;
create index custom_records_title_trgm_idx on crm.custom_records using gin (title gin_trgm_ops);
-- The trash's order, as 0024 reads it for the other kinds.
create index custom_records_trash_idx
  on crm.custom_records (business_id, deleted_at desc, id desc) where deleted_at is not null;

create function private.assign_custom_record_object() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.object_type_id is null then
    select r.object_type_id into new.object_type_id
    from crm.records r
    where r.business_id = new.business_id and r.id = new.id;
  end if;
  return new;
end
$$;
revoke execute on function private.assign_custom_record_object() from public;
create trigger custom_records_object_type before insert on crm.custom_records
  for each row execute function private.assign_custom_record_object();

-- A record's title is its primary field's value, so trash, audit, search and pickers keep
-- reading a name column while the value lives with the other fields. The application
-- requires the value and keeps it within the title's 200 characters.
create function private.keep_custom_record_title() returns trigger
language plpgsql set search_path = ''
as $$
begin
  update crm.custom_records c
  set title = case new.value_type
    when 'number' then pg_catalog.trim_scale(new.value_number)::text
    else new.value_text
  end
  from crm.object_types o
  where o.business_id = new.business_id
    and o.primary_field_id = new.field_id
    and c.business_id = new.business_id
    and c.id = new.record_id
    and c.object_type_id = o.id;
  return null;
end
$$;
revoke execute on function private.keep_custom_record_title() from public;
create trigger field_values_custom_record_title
  after insert or update of value_text, value_number on crm.field_values
  for each row when (new.value_type in ('text', 'number'))
  execute function private.keep_custom_record_title();

-- Associations -------------------------------------------------------------------------------------------
-- A link type is one of GoHighLevel's association labels. A system one is the product's:
-- every link type there is now is one of the three every business is given (deal↔contact,
-- contact↔company, deal↔company). Each side may limit how many records it links: to_limit is
-- how many "to" records one "from" record may have, from_limit the reverse, null no limit.
-- GoHighLevel allows "up to 1,000 linked records per side".

alter table crm.link_types
  add column is_system boolean not null default false,
  add column from_limit integer,
  add column to_limit integer,
  add column created_by_kind text not null default 'system',
  add column created_by_id uuid;
alter table crm.link_types
  add constraint link_types_from_limit_range check (from_limit between 1 and 1000) not valid,
  add constraint link_types_to_limit_range check (to_limit between 1 and 1000) not valid,
  add constraint link_types_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import'))
    not valid;
alter table crm.link_types validate constraint link_types_from_limit_range;
alter table crm.link_types validate constraint link_types_to_limit_range;
alter table crm.link_types validate constraint link_types_created_by_kind_valid;

-- Marking the seeds is not an edit of them.
alter table crm.link_types disable trigger touch_updated_at;
update crm.link_types set is_system = true;
alter table crm.link_types enable trigger touch_updated_at;

-- Every link type keeps its key and the objects it joins, which code reads them by; a system
-- one also keeps whether it has a primary. Labels and limits stay editable, as GoHighLevel's
-- Configure Relationship is.
create function private.guard_link_type() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.business_id is distinct from old.business_id
     or new.key is distinct from old.key
     or new.from_object_type_id is distinct from old.from_object_type_id
     or new.to_object_type_id is distinct from old.to_object_type_id then
    raise exception 'An association keeps its key and the objects it joins.'
      using errcode = 'check_violation', constraint = 'link_types_identity_fixed';
  end if;
  if new.is_system is distinct from old.is_system
     or (old.is_system and new.allows_primary is distinct from old.allows_primary) then
    raise exception 'A system association keeps its place; only its labels change.'
      using errcode = 'check_violation', constraint = 'link_types_system_fixed';
  end if;
  return new;
end
$$;
revoke execute on function private.guard_link_type() from public;
create trigger link_types_guard before update on crm.link_types
  for each row execute function private.guard_link_type();

-- The application never deletes a system link type. It still goes with its object type.
create policy link_types_delete_not_system on crm.link_types
  as restrictive for delete
  using (not is_system);

-- One pair of labels per pair of objects, whichever way they read: Pet → Contact labelled
-- Owner (and Pet back) is the same association as Contact → Pet labelled Pet (and Owner
-- back). So the index reads each type from the object with the lower id, and an object
-- joined to itself with its two labels in order. A single label is stored as the same label
-- both ways.
create unique index link_types_label_unique_idx
  on crm.link_types (
    business_id,
    least(from_object_type_id, to_object_type_id),
    greatest(from_object_type_id, to_object_type_id),
    (case
       when from_object_type_id < to_object_type_id then lower(btrim(label))
       when from_object_type_id > to_object_type_id then lower(btrim(reverse_label))
       else least(lower(btrim(label)), lower(btrim(reverse_label)))
     end),
    (case
       when from_object_type_id < to_object_type_id then lower(btrim(reverse_label))
       when from_object_type_id > to_object_type_id then lower(btrim(label))
       else greatest(lower(btrim(label)), lower(btrim(reverse_label)))
     end))
  where archived_at is null;

-- Two records are linked once under a type, whichever is "from": it matters for a type that
-- joins an object to itself (contact↔contact). Every type there is now joins two different
-- objects, so no existing pair can clash.
create unique index record_links_pair_unique_idx
  on crm.record_links (business_id, link_type_id, least(from_record_id, to_record_id),
                       greatest(from_record_id, to_record_id));

-- Search -------------------------------------------------------------------------------------------------
-- Any part of a searchable field, through a trigram index on the text values.
create index field_values_text_trgm_idx
  on crm.field_values using gin (lower(value_text) gin_trgm_ops)
  where value_type in ('text', 'long_text', 'email', 'phone', 'url');

-- The ids of the request's business's records of one custom object, not in the trash, whose
-- title has words starting with p_words (a tsquery of word prefixes), or whose title or a
-- searchable field contains p_part (an ILIKE pattern). Either may be null to skip that
-- lookup. Each lookup stops at p_limit ids, and an id can come more than once. Run as the
-- owner, as private.search_companies is, since Postgres won't use these indexes for @@ or
-- ILIKE under row-level security; it reads only the business the request works in
-- (app.require_business_id() fails closed), and callers read the records themselves under
-- row-level security.
create function private.search_custom_records(
  p_object_type_id uuid, p_words text, p_part text, p_limit integer
)
returns setof uuid
language sql stable security definer set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
  (select c.id from crm.custom_records c
   where p_words is not null
     and c.business_id = (select app.require_business_id())
     and c.object_type_id = p_object_type_id
     and c.deleted_at is null
     and c.search @@ pg_catalog.to_tsquery('pg_catalog.simple', p_words)
   limit p_limit)
  union all
  (select c.id from crm.custom_records c
   where p_part is not null
     and c.business_id = (select app.require_business_id())
     and c.object_type_id = p_object_type_id
     and c.deleted_at is null
     and c.title ilike p_part
   limit p_limit)
  union all
  (select c.id
   from crm.field_definitions f
   join crm.field_values v on v.business_id = f.business_id and v.field_id = f.id
   join crm.custom_records c on c.business_id = v.business_id and c.id = v.record_id
   where p_part is not null
     and f.business_id = (select app.require_business_id())
     and f.object_type_id = p_object_type_id
     and f.is_searchable
     and f.archived_at is null
     and v.value_type in ('text', 'long_text', 'email', 'phone', 'url')
     and pg_catalog.lower(v.value_text) like pg_catalog.lower(p_part)
     and c.deleted_at is null
   limit p_limit)
$$;
revoke execute on function private.search_custom_records(uuid, text, text, integer) from public;
grant execute on function private.search_custom_records(uuid, text, text, integer) to crm_app;

-- Trash ----------------------------------------------------------------------------------------------------
-- The daily purge finds a business by its custom records in the trash too.
create or replace function private.businesses_with_expired_trash(p_limit integer)
returns table (agency_id uuid, business_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, b.id
  from tenancy.businesses b
  cross join lateral (
    select now() - pg_catalog.make_interval(days => coalesce(
      (select s.trash_retention_days from crm.settings s where s.business_id = b.id), 30)) as cutoff
  ) expiry
  where exists (select 1 from crm.contacts c
                where c.business_id = b.id and c.deleted_at < expiry.cutoff)
     or exists (select 1 from crm.companies c
                where c.business_id = b.id and c.deleted_at < expiry.cutoff)
     or exists (select 1 from crm.deals d
                where d.business_id = b.id and d.deleted_at < expiry.cutoff)
     or exists (select 1 from crm.custom_records r
                where r.business_id = b.id and r.deleted_at < expiry.cutoff)
  order by b.id
  limit p_limit
$$;
