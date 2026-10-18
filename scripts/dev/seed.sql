-- Development data: one agency, one business and its owner.
-- Runs as crm_owner after the migrations (pnpm dev does both), and again on every start:
-- a row that's already there is left alone. The ids are fixed, so every development
-- database has the same ones. The owner signs in with a link emailed to Mailpit.

\set ON_ERROR_STOP on

begin;

insert into tenancy.agencies (id, name, slug)
values ('0199a000-0000-7000-8000-000000000001', 'Bluebird Digital', 'bluebird')
on conflict do nothing;

insert into tenancy.businesses (id, agency_id, name, slug, timezone, currency)
values ('0199a000-0000-7000-8000-000000000002', '0199a000-0000-7000-8000-000000000001',
        'Harbor Lights Events', 'harbor-lights', 'America/New_York', 'USD')
on conflict do nothing;

-- The built-in objects every business starts with, as @repo/testing's business fixture
-- makes them.
insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
values ('0199a000-0000-7000-8000-000000000002', 'contact', 'contact', 'Contact', 'Contacts'),
       ('0199a000-0000-7000-8000-000000000002', 'company', 'company', 'Company', 'Companies'),
       ('0199a000-0000-7000-8000-000000000002', 'deal', 'deal', 'Deal', 'Deals')
on conflict do nothing;

insert into auth.users (id, email, name)
values ('0199a000-0000-7000-8000-000000000003', 'dana@harborlights.example', 'Dana Brooks')
on conflict do nothing;

insert into tenancy.roles (id, agency_id, scope, key, name, is_builtin)
values ('0199a000-0000-7000-8000-000000000004', '0199a000-0000-7000-8000-000000000001',
        'business', 'owner', 'Owner', true)
on conflict do nothing;

insert into tenancy.memberships (id, user_id, agency_id, business_id, role_id)
values ('0199a000-0000-7000-8000-000000000005', '0199a000-0000-7000-8000-000000000003',
        '0199a000-0000-7000-8000-000000000001', '0199a000-0000-7000-8000-000000000002',
        '0199a000-0000-7000-8000-000000000004')
on conflict do nothing;

-- Someone who runs the agency: agency staff with the built-in owner role, as the first
-- start's setup link makes the first admin. With them here, the app prints
-- no setup link. Sign in as sam@bluebird.example by link, like Dana.
insert into tenancy.roles (id, agency_id, scope, key, name, is_builtin)
values ('0199a000-0000-7000-8000-000000000006', '0199a000-0000-7000-8000-000000000001',
        'agency', 'owner', 'Owner', true)
on conflict do nothing;

insert into auth.users (id, email, name, email_verified)
values ('0199a000-0000-7000-8000-000000000007', 'sam@bluebird.example', 'Sam Rivera', true)
on conflict do nothing;

insert into tenancy.memberships (id, user_id, agency_id, role_id)
values ('0199a000-0000-7000-8000-000000000008', '0199a000-0000-7000-8000-000000000007',
        '0199a000-0000-7000-8000-000000000001', '0199a000-0000-7000-8000-000000000006')
on conflict do nothing;

commit;
