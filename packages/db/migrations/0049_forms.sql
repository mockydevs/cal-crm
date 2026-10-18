-- P1.46 and P1.47: the form builder, its public embed, and submissions into contacts.
-- 0008 made forms.forms and forms.submissions and 0012 their grants and the key lookup.
-- This adds what the builder and the public surface need, and changes no existing row's
-- meaning: a form that was published keeps serving the definition it had.

-- A form is edited as a draft (definition) and served as what was last published
-- (published_definition), so a half-finished edit never reaches a website. The websites
-- that may show it are listed one by one, each stored origin in its one canonical form
-- (packages/contracts/src/forms.ts); the database refuses a list no request could be
-- matched against sensibly, as it does for web chat widgets (0047).
alter table forms.forms
  add column allowed_origins text[] not null default '{}',
  add column published_definition jsonb,
  add column published_at timestamptz,
  add constraint forms_origins_bounded check (
    cardinality(allowed_origins) <= 20
    and array_position(allowed_origins, null) is null
    and array_position(allowed_origins, '') is null
    and array_position(allowed_origins, 'null') is null
    and array_position(allowed_origins, '*') is null),
  add constraint forms_published_definition_object
    check (published_definition is null or jsonb_typeof(published_definition) = 'object'),
  -- A definition is a document of at most 40 fields; no writer may store an unbounded one.
  add constraint forms_definition_bounded check (octet_length(definition::text) <= 131072),
  add constraint forms_published_definition_bounded
    check (published_definition is null or octet_length(published_definition::text) <= 131072);

-- Forms published before this migration go on serving what they had.
update forms.forms
set published_definition = definition, published_at = updated_at
where status = 'published';

alter table forms.forms
  add constraint forms_published_has_definition
    check ((status = 'published') = (published_definition is not null)),
  add constraint forms_published_at_with_definition
    check ((published_definition is null) = (published_at is null));

-- A submission as the public surface stores it.
-- - client_submission_id is chosen by the embed for each filled-in form, so a request sent
--   twice (a double click, a retry after a lost answer) stores one submission; the digest
--   of what was sent tells a repeat from a different request under the same id.
-- - origin is the stored website the request was admitted from, and page_url the page it
--   says it was on. ip and user_agent (0008) are what the server observed.
-- - contact_outcome says what happened to the contact: made, updated, or not attached
--   because the details matched no single live contact. Only then is contact_id null.
alter table forms.submissions
  add column client_submission_id uuid,
  add column request_digest text
    constraint submissions_digest_valid check (request_digest ~ '^[0-9a-f]{64}$'),
  add column origin text
    constraint submissions_origin_length check (length(origin) between 1 and 255),
  add column page_url text
    constraint submissions_page_url_length check (length(page_url) between 1 and 2000),
  add column contact_outcome text
    constraint submissions_contact_outcome_valid
      check (contact_outcome in ('created', 'updated', 'unresolved')),
  add constraint submissions_request_paired
    check ((client_submission_id is null) = (request_digest is null)),
  add constraint submissions_request_unique unique (business_id, form_id, client_submission_id),
  add constraint submissions_outcome_matches_contact
    check (contact_outcome is null or (contact_outcome = 'unresolved') = (contact_id is null)),
  add constraint submissions_user_agent_length check (length(user_agent) <= 500),
  add constraint submissions_data_bounded check (octet_length(data::text) <= 262144),
  add constraint submissions_consent_bounded check (octet_length(consent::text) <= 16384),
  add constraint submissions_utm_bounded check (octet_length(utm::text) <= 4096);

-- Submissions stay append-only for the application (0012: select and insert), with one
-- exception. A submission attached to a contact is erased with that contact (0008). One
-- that could not be attached has no contact to be erased with, so the team must be able
-- to discard it: the application may delete a submission only while it has no contact.
grant delete on forms.submissions to crm_app;
create policy submissions_delete_unattached_only on forms.submissions
  as restrictive for delete
  using (contact_id is null);

-- The key lookup now also needs the business to be active, as every other public lookup
-- does (0040, 0047): a suspended business takes no submissions. Same arguments, same
-- three ids, same owner and grants.
create or replace function private.resolve_form(p_public_key text)
returns table (agency_id uuid, business_id uuid, form_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, f.business_id, f.id
  from forms.forms f
  join tenancy.businesses b on b.id = f.business_id
  where f.public_key = p_public_key
    and p_public_key ~ '^[A-Za-z0-9_-]{16,64}$'
    and f.status = 'published'
    and b.status = 'active'
$$;
revoke execute on function private.resolve_form(text) from public;
grant execute on function private.resolve_form(text) to crm_app;
