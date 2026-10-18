-- ADR-093: key-bound accounts, selected reads and read-only credentials. Existing keys
-- retain null (legacy unrestricted) reads; the HTTP boundary still checks native grants.
-- CHECK accepts NULL, so the empty-scope test must coalesce a missing read policy.
-- Sources: PostgreSQL 18 ddl-constraints.html and functions-array.html.
alter table tenancy.api_keys
  add column read_only boolean not null default false,
  add column read_groups text[],
  drop constraint api_keys_scopes_present;

alter table tenancy.api_keys
  add constraint api_keys_scopes_present check (
    cardinality(scopes) > 0 or coalesce(cardinality(read_groups), 0) > 0
  ),
  add constraint api_keys_read_groups_valid check (
    read_groups is null or (
      cardinality(read_groups) <= 64
      and coalesce(array_ndims(read_groups), 1) = 1
      and array_position(read_groups, null) is null
    )
  ),
  add constraint api_keys_read_only_scopes check (
    not read_only or scopes <@ array['payments.read','reports.view']::text[]
  );
