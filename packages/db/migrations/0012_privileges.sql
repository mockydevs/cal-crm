-- The runtime privilege model, in one place for review. Later migrations grant on their
-- own new tables next to the tables they create.
--
-- crm_app gets only the verbs each table needs. Logs are append-only (no UPDATE or
-- DELETE), typed CRM rows are deleted only through crm.records, and nothing outside
-- these grants is reachable at all.

-- Functions are not executable by PUBLIC unless granted below.
alter default privileges for role crm_owner revoke execute on functions from public;
revoke execute on all functions in schema app, util, crm from public;
revoke execute on all procedures in schema util from public;

grant usage on schema app to crm_app, crm_auth;
grant execute on all functions in schema app to crm_app, crm_auth;

-- Cross-tenant work ---------------------------------------------------------------------
-- The only paths across businesses. Each is SECURITY DEFINER (runs as crm_owner, which
-- bypasses row-level security), does one narrow job, and pins search_path.

create function private.maintain_partitions() returns integer
language sql security definer set search_path = ''
as $$
  select util.ensure_monthly_partitions('events.events', 1, 3)
       + util.ensure_monthly_partitions('crm.timeline_entries', 1, 3)
       + util.ensure_monthly_partitions('automation.step_runs', 1, 3)
       + util.ensure_monthly_partitions('audit.commands', 1, 3)
$$;

-- Enrolments whose wait is over; the worker then runs each one inside its business.
create function private.due_enrolments(p_limit integer)
returns table (business_id uuid, enrolment_id uuid, wake_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select e.business_id, e.id, e.wake_at
  from automation.enrolments e
  where e.status = 'waiting' and e.wake_at is not null and e.wake_at <= now()
  order by e.wake_at
  limit least(greatest(p_limit, 1), 1000)
$$;

-- Inbound routing: which business does this number, chat widget or form belong to?
create function private.resolve_phone_number(p_e164 text)
returns table (agency_id uuid, business_id uuid, phone_number_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, p.business_id, p.id
  from messaging.phone_numbers p
  join tenancy.businesses b on b.id = p.business_id
  where p.e164 = p_e164
$$;

create function private.resolve_webchat_widget(p_public_key text)
returns table (agency_id uuid, business_id uuid, widget_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, w.business_id, w.id
  from messaging.webchat_widgets w
  join tenancy.businesses b on b.id = w.business_id
  where w.public_key = p_public_key
$$;

create function private.resolve_form(p_public_key text)
returns table (agency_id uuid, business_id uuid, form_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, f.business_id, f.id
  from forms.forms f
  join tenancy.businesses b on b.id = f.business_id
  where f.public_key = p_public_key and f.status = 'published'
$$;

-- Clears AI request logs past their retention date, in batches.
create function private.expire_ai_request_logs(p_limit integer) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_cleared integer;
begin
  with due as (
    select r.business_id, r.id
    from ai.requests r
    where r.log is not null and r.log_expires_at <= now()
    order by r.log_expires_at
    limit least(greatest(p_limit, 1), 10000)
  )
  update ai.requests r
  set log = null, log_expires_at = null
  from due
  where r.business_id = due.business_id and r.id = due.id;
  get diagnostics v_cleared = row_count;
  return v_cleared;
end
$$;

revoke execute on all functions in schema private from public;
grant usage on schema private to crm_app;
grant execute on all functions in schema private to crm_app;

-- crm_app: table privileges --------------------------------------------------------------

grant usage on schema tenancy, auth, vault, files, events, crm, messaging, calendar, forms,
  automation, ai, audit, intake, imports, reporting to crm_app;

grant select, update on tenancy.agencies to crm_app;
grant select, insert, update on tenancy.businesses to crm_app;
grant select on auth.users to crm_app;
grant select, insert, update, delete on tenancy.roles, tenancy.memberships to crm_app;
grant select, insert, update on tenancy.invitations, tenancy.api_keys to crm_app;

grant select, insert, update, delete on vault.secrets to crm_app;
grant select, insert, update on files.files to crm_app;

grant select, insert on events.events to crm_app;

grant select, insert, update, delete on all tables in schema crm to crm_app;
revoke delete on crm.contacts, crm.companies, crm.deals, crm.custom_records from crm_app;
revoke update, delete on crm.timeline_entries from crm_app;
revoke delete on crm.deal_stage_history from crm_app;

grant select, insert, update, delete on all tables in schema messaging to crm_app;
revoke delete on messaging.messages from crm_app;
revoke update, delete on messaging.consents, messaging.mailbox_check_results from crm_app;
revoke delete on messaging.mailbox_check_runs from crm_app;

grant select, insert, update, delete on all tables in schema calendar to crm_app;

grant select, insert, update, delete on forms.forms to crm_app;
grant select, insert on forms.submissions to crm_app;

grant select, insert, update, delete on automation.automations, automation.trigger_subscriptions,
  automation.event_waits, automation.test_runs to crm_app;
grant select, insert on automation.versions to crm_app;
grant select, insert, update on automation.enrolments, automation.step_runs to crm_app;

grant select, insert, update, delete on ai.provider_keys, ai.job_models, ai.autonomy_rules,
  ai.contact_summaries to crm_app;
grant select, insert, update on ai.settings, ai.requests, ai.proposals, ai.contact_facts to crm_app;

grant select, insert on audit.commands to crm_app;
grant select, insert, update on intake.webhooks to crm_app;
grant select, insert, update on imports.jobs, imports.id_map to crm_app;
grant select, insert, update, delete on reporting.daily_metrics to crm_app;

-- "all tables in schema" also matches existing partitions, and partitions have no
-- row-level security of their own. Take those grants back, so partitions are reachable
-- only through their parent table, whose policies apply. Partitions created later get
-- no grants at all.
do $$
declare
  v_partition regclass;
begin
  for v_partition in
    select c.oid::regclass
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relispartition and c.relkind in ('r', 'p') and n.nspname in ('events', 'crm', 'automation', 'audit')
  loop
    execute format('revoke all on %s from crm_app, crm_auth', v_partition);
  end loop;
end
$$;

-- crm_auth: sign-in, sessions and API-key lookup --------------------------------------------
-- It works before any tenant context exists, so it bypasses row-level security; it is
-- given nothing outside identity and membership.

grant usage on schema auth, tenancy to crm_auth;
grant select, insert, update on auth.users to crm_auth;
grant select on tenancy.agencies, tenancy.businesses, tenancy.roles to crm_auth;
grant select, insert on tenancy.memberships to crm_auth;
grant select, update on tenancy.invitations to crm_auth;
grant select, update (last_used_at) on tenancy.api_keys to crm_auth;
