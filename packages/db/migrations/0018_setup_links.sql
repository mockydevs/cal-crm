-- The first admin's setup links (task P1.04, ADR-013): while nobody runs the agency yet,
-- the app prints a link at each start that creates the first admin. A link works once,
-- within 24 hours, and creating the admin ends every other one. Only each token's SHA-256
-- is kept, so a copy of the table opens nothing. For crm_auth alone, like the other
-- sign-in tables.
create table auth.setup_links (
  id uuid primary key default uuidv7(),
  token_hash text not null constraint setup_links_token_hash_unique unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table auth.setup_links enable row level security;
alter table auth.setup_links force row level security;
create policy authentication_module_only on auth.setup_links using (false) with check (false);
grant select, insert, update, delete on auth.setup_links to crm_auth;
