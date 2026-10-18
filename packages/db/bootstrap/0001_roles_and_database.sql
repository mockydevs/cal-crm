-- Install bootstrap. Runs once per install, as a Postgres superuser (the installer
-- does this; it is not a migration). Creates the four login roles and the database.
--
-- Roles:
--   crm_owner   owns every schema and object; runs migrations. BYPASSRLS so the few
--               SECURITY DEFINER maintenance functions it owns can work across tenants.
--   crm_app     the API and worker. Subject to row-level security; DML only.
--   crm_auth    the authentication module only (sign-in, sessions, API-key lookup).
--               BYPASSRLS because it must find users and memberships before any tenant
--               context exists; it is granted nothing outside auth and tenancy.
--   crm_worker  the worker's connection to the job queue (Graphile Worker). It is granted
--               the graphile_worker schema and nothing else; the work itself runs as
--               crm_app. BYPASSRLS because Graphile Worker turns on row-level security
--               for its tables with no policies, leaving them to their owner.
--
-- Passwords arrive as psql variables: -v owner_password=... -v app_password=...
-- -v auth_password=... -v worker_password=...

\set ON_ERROR_STOP on

create role crm_owner login bypassrls password :'owner_password';
create role crm_app login password :'app_password';
create role crm_auth login bypassrls password :'auth_password';
create role crm_worker login bypassrls password :'worker_password';

-- Fail fast instead of piling up: long statements and abandoned transactions are bugs.
alter role crm_app set statement_timeout = '30s';
alter role crm_app set idle_in_transaction_session_timeout = '60s';
alter role crm_auth set statement_timeout = '10s';
alter role crm_auth set idle_in_transaction_session_timeout = '60s';
alter role crm_worker set statement_timeout = '30s';
alter role crm_worker set idle_in_transaction_session_timeout = '60s';
-- Migrations must not queue behind live traffic for long.
alter role crm_owner set lock_timeout = '5s';

create database crm owner crm_owner;

\connect crm

revoke all on database crm from public;
grant connect on database crm to crm_app, crm_auth, crm_worker;
revoke create on schema public from public;

-- Extensions need a superuser. pgvector ("vector") is added by the phase 2 migration
-- that introduces embeddings.
create extension if not exists btree_gist;
create extension if not exists pg_trgm;
