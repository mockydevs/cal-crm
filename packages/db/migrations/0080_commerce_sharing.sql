-- Commerce, stage 2 (ADR-085): a quote, an invoice or a receipt is printed, shared by a
-- public address and emailed to its contact. Printing reads what 0079 stores and needs
-- nothing here. This adds when a document and a receipt were sent, and the public address
-- of an issued document.

-- Sent ----------------------------------------------------------------------------------------
-- Issuing sends nothing (0079): these say when the document really went to the customer by
-- email, first and last, and how often. They change after the document is frozen, like its
-- status and the team's note; the guard of 0079 keeps only its kind and its number.
alter table commerce.documents
  add column sent_at timestamptz,
  add column last_sent_at timestamptz,
  add column send_count integer not null default 0
    constraint documents_send_count_nonnegative check (send_count >= 0),
  add constraint documents_sent_together check (
    (send_count = 0) = (sent_at is null) and (send_count = 0) = (last_sent_at is null)),
  add constraint documents_sent_in_order check (last_sent_at >= sent_at),
  -- Only a document with a number is sent: a draft that was never issued has nothing to say.
  add constraint documents_sent_has_number check (send_count = 0 or number is not null);

-- A receipt is its payment (0079). The guard there keeps what a payment says; when its
-- receipt was sent is not part of that, so these two can be written afterwards.
alter table commerce.payments
  add column last_sent_at timestamptz,
  add column send_count integer not null default 0
    constraint payments_send_count_nonnegative check (send_count >= 0),
  add constraint payments_sent_together check ((send_count = 0) = (last_sent_at is null));

-- Public addresses ----------------------------------------------------------------------------
-- One address a document: /d/<token>, a read-only page with the PDF, where a sent quote can
-- be accepted or declined. The token is never stored. It is a keyed digest of this row's id
-- (HMAC-SHA-256 under the install's public intake secret), so the server can write the
-- address again for every email it sends, and a copy of the database alone opens nothing.
-- What is kept is the SHA-256 of the token, which finds the row when the address is opened.
-- A new address is a new row: the old row is deleted, and its address stops at once.
create table commerce.document_links (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  document_id uuid not null,
  digest text not null constraint document_links_digest_valid check (digest ~ '^[0-9a-f]{64}$'),
  created_by_kind text not null constraint document_links_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  -- One address a document; a draft deleted for good takes its address with it.
  constraint document_links_document_unique unique (business_id, document_id),
  constraint document_links_document foreign key (business_id, document_id)
    references commerce.documents (business_id, id) on delete cascade
);
-- The lookup of an opened address, before any tenant is known.
create unique index document_links_digest_unique on commerce.document_links (digest);
call util.enable_tenant_rls('commerce.document_links');
-- An address is made, read and replaced (deleted and made again), never changed.
grant select, insert, delete on commerce.document_links to crm_app;

-- An opened address locates its tenant before any session exists, as a trigger link's and
-- an appointment's do (0065, 0040). It answers only for an active business, gives three ids
-- and nothing a document says, and grants no write: the tenant transaction reads the row
-- again under row-level security, by the same digest.
create function private.commerce_document_link_scope(p_digest text)
returns table (agency_id uuid, business_id uuid, document_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, l.business_id, l.document_id
  from commerce.document_links l
  join tenancy.businesses b on b.id = l.business_id
  where l.digest = p_digest
    and p_digest ~ '^[0-9a-f]{64}$'
    and b.status = 'active'
$$;
revoke execute on function private.commerce_document_link_scope(text) from public;
grant execute on function private.commerce_document_link_scope(text) to crm_app;
