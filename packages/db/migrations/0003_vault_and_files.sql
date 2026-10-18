-- Encrypted secrets and stored files. Both can belong to an agency as a whole
-- (business_id NULL) or to one of its businesses.

create schema vault;
create schema files;

-- Provider passwords, OAuth refresh tokens and API keys. The application encrypts with
-- AES-256-GCM using the install key (kept outside the database), so a database dump
-- alone reveals nothing. key_version names the install key generation, for rotation.
create table vault.secrets (
  id uuid primary key default uuidv7(),
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  business_id uuid,
  purpose text not null constraint secrets_purpose_format check (purpose ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  key_version smallint not null constraint secrets_key_version_positive check (key_version > 0),
  nonce bytea not null constraint secrets_nonce_length check (length(nonce) = 12),
  ciphertext bytea not null constraint secrets_ciphertext_present check (length(ciphertext) > 16),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id) on delete cascade,
  -- Referencing rows include their own agency or business id, so a mailbox can only use
  -- its own business's secret and an agency setting only its own agency's.
  constraint secrets_agency_id_id_unique unique (agency_id, id),
  constraint secrets_business_id_id_unique unique (business_id, id)
);
create index secrets_agency_id_business_id_idx on vault.secrets (agency_id, business_id);

create table files.files (
  id uuid primary key default uuidv7(),
  agency_id uuid not null references tenancy.agencies (id) on delete cascade,
  business_id uuid,
  storage text not null constraint files_storage_valid check (storage in ('local', 's3')),
  storage_key text not null,
  filename text not null constraint files_filename_length check (length(filename) between 1 and 255),
  content_type text not null,
  size_bytes bigint not null constraint files_size_nonnegative check (size_bytes >= 0),
  sha256 bytea not null constraint files_sha256_length check (length(sha256) = 32),
  uploaded_by_kind text not null,
  uploaded_by_id uuid,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id) on delete cascade,
  constraint files_storage_key_unique unique (storage, storage_key),
  constraint files_agency_id_id_unique unique (agency_id, id),
  constraint files_business_id_id_unique unique (business_id, id)
);
create index files_agency_id_business_id_idx on files.files (agency_id, business_id);

-- Logos must be the agency's or the business's own files.
alter table tenancy.agencies
  add foreign key (id, logo_file_id) references files.files (agency_id, id) on delete set null (logo_file_id);
alter table tenancy.businesses
  add foreign key (id, logo_file_id) references files.files (business_id, id) on delete set null (logo_file_id);

call util.enable_scoped_rls('vault.secrets');
call util.enable_scoped_rls('files.files');
