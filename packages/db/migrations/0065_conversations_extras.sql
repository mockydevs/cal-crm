-- F3.01 to F3.03 (ADR-070): snippets and their folders, trigger links with their
-- per-recipient tokens and click log, and the manual actions an automation leaves for a
-- person. Nothing that exists changes: message templates (0039) stay what automations send
-- by id; a snippet is what a person inserts into a message.

-- Snippets -------------------------------------------------------------------------------
-- A folder groups snippets. Deleting one leaves its snippets, outside any folder.
create table messaging.snippet_folders (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  name text not null constraint snippet_folders_name_length check (length(btrim(name)) between 1 and 80),
  name_normalized text generated always as (lower(btrim(name))) stored,
  created_by_kind text not null constraint snippet_folders_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id)
);
create unique index snippet_folders_name_unique on messaging.snippet_folders (business_id, name_normalized);
call util.enable_tenant_rls('messaging.snippet_folders');
call util.add_updated_at_trigger('messaging.snippet_folders');
grant select, insert, update, delete on messaging.snippet_folders to crm_app;

-- Plain text only, as templates are. A text snippet has no subject; an email snippet has
-- one, on one line: a line break in a subject would let text become another header.
create table messaging.snippets (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  kind text not null constraint snippets_kind_valid check (kind in ('text', 'email')),
  name text not null constraint snippets_name_length check (length(btrim(name)) between 1 and 120),
  name_normalized text generated always as (lower(btrim(name))) stored,
  subject text constraint snippets_subject_valid
    check (subject is null or (length(subject) between 1 and 255 and subject !~ '[\r\n]')),
  body text not null constraint snippets_body_length check (length(body) between 1 and 100000),
  folder_id uuid,
  created_by_kind text not null constraint snippets_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, folder_id) references messaging.snippet_folders (business_id, id)
    on delete set null (folder_id),
  constraint snippets_subject_by_kind check ((kind = 'email') = (subject is not null)),
  -- A text message holds 1600 characters at most (messaging's SMS_BODY_MAX).
  constraint snippets_text_length check (kind <> 'text' or length(body) <= 1600)
);
-- People pick a snippet by its name, so names are unique whatever the kind or folder. The
-- same index gives the list its order.
create unique index snippets_name_unique on messaging.snippets (business_id, name_normalized);
create index snippets_folder_idx on messaging.snippets (business_id, folder_id);
call util.enable_tenant_rls('messaging.snippets');
call util.add_updated_at_trigger('messaging.snippets');
grant select, insert, update, delete on messaging.snippets to crm_app;

-- Trigger links --------------------------------------------------------------------------
-- A named destination. Its key is what a message writes ({{trigger_link.<key>}}) and what
-- an automation's trigger names, so it never changes; the destination can.
create table messaging.trigger_links (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  name text not null constraint trigger_links_name_length check (length(btrim(name)) between 1 and 120),
  name_normalized text generated always as (lower(btrim(name))) stored,
  key text not null constraint trigger_links_key_format check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  -- Only a web address: the public redirect answers with this value and nothing else.
  url text not null constraint trigger_links_url_valid
    check (length(url) between 1 and 2000 and url ~ '^https?://[^[:space:][:cntrl:]]+$'),
  created_by_kind text not null constraint trigger_links_created_by_kind_valid
    check (created_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id)
);
create unique index trigger_links_name_unique on messaging.trigger_links (business_id, name_normalized);
create unique index trigger_links_key_unique on messaging.trigger_links (business_id, key);
-- The Trigger Links list: newest first.
create index trigger_links_created_idx on messaging.trigger_links (business_id, created_at desc, id desc);

create function private.guard_trigger_link() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.business_id is distinct from old.business_id or new.key is distinct from old.key then
    raise exception 'A trigger link keeps its key.'
      using errcode = 'check_violation', constraint = 'trigger_links_key_fixed';
  end if;
  return new;
end
$$;
revoke execute on function private.guard_trigger_link() from public;
create trigger trigger_links_guard before update on messaging.trigger_links
  for each row execute function private.guard_trigger_link();
call util.enable_tenant_rls('messaging.trigger_links');
call util.add_updated_at_trigger('messaging.trigger_links');
grant select, insert, update, delete on messaging.trigger_links to crm_app;

-- One row each time a link is written into a message for a contact. The address the
-- contact gets holds a random token and nothing else; only its digest is kept, as for the
-- unsubscribe capability (0034).
create table messaging.trigger_link_tokens (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  link_id uuid not null,
  contact_id uuid not null,
  digest text not null constraint trigger_link_tokens_digest_valid check (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, link_id) references messaging.trigger_links (business_id, id) on delete cascade,
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade
);
create unique index trigger_link_tokens_digest_idx on messaging.trigger_link_tokens (digest);
create index trigger_link_tokens_link_idx on messaging.trigger_link_tokens (business_id, link_id);
create index trigger_link_tokens_contact_idx on messaging.trigger_link_tokens (business_id, contact_id);
call util.enable_tenant_rls('messaging.trigger_link_tokens');
-- A token is issued and read, never changed.
grant select, insert on messaging.trigger_link_tokens to crm_app;

-- Who clicked which link, and when. Append-only.
create table messaging.trigger_link_clicks (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  link_id uuid not null,
  contact_id uuid not null,
  token_id uuid not null,
  clicked_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, link_id) references messaging.trigger_links (business_id, id) on delete cascade,
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade,
  foreign key (business_id, token_id) references messaging.trigger_link_tokens (business_id, id) on delete cascade
);
-- "Analyze": a link's clicks, newest first, and its counts.
create index trigger_link_clicks_link_idx
  on messaging.trigger_link_clicks (business_id, link_id, clicked_at desc, id desc);
create index trigger_link_clicks_contact_idx on messaging.trigger_link_clicks (business_id, contact_id);
-- A token's newest click, which decides whether another one so soon is recorded.
create index trigger_link_clicks_token_idx
  on messaging.trigger_link_clicks (business_id, token_id, clicked_at desc);
call util.enable_tenant_rls('messaging.trigger_link_clicks');
grant select, insert on messaging.trigger_link_clicks to crm_app;

-- A token locates its tenant before any session exists. It gives the stored destination
-- and who the token was issued for, and grants no write: the tenant command reads the
-- token again under row-level security.
create function private.trigger_link_scope(p_digest text)
returns table (agency_id uuid, business_id uuid, token_id uuid, link_id uuid, contact_id uuid, url text)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, t.business_id, t.id, t.link_id, t.contact_id, l.url
  from messaging.trigger_link_tokens t
  join messaging.trigger_links l on l.business_id = t.business_id and l.id = t.link_id
  join tenancy.businesses b on b.id = t.business_id
  where t.digest = p_digest
$$;
revoke execute on function private.trigger_link_scope(text) from public;
grant execute on function private.trigger_link_scope(text) to crm_app;

-- Manual actions -------------------------------------------------------------------------
-- A call to place or a text to send by hand, left by a manual.call or manual.sms step. The
-- run waits at the step until a person completes or skips the action.
create table automation.manual_actions (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  automation_id uuid not null,
  enrolment_id uuid not null,
  step_key text not null constraint manual_actions_step_key_length check (length(step_key) between 1 and 200),
  contact_id uuid not null,
  kind text not null constraint manual_actions_kind_valid check (kind in ('call', 'sms')),
  -- What to say: the text to send, or notes for the call, already filled in for the contact.
  body text not null default '' constraint manual_actions_body_length check (length(body) <= 2000),
  status text not null default 'pending' constraint manual_actions_status_valid
    check (status in ('pending', 'completed', 'skipped', 'cancelled')),
  assignee_user_id uuid references auth.users (id) on delete set null,
  closed_at timestamptz,
  closed_by_kind text constraint manual_actions_closed_by_kind_valid
    check (closed_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  closed_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  foreign key (business_id, automation_id) references automation.automations (business_id, id) on delete cascade,
  foreign key (business_id, enrolment_id) references automation.enrolments (business_id, id) on delete cascade,
  foreign key (business_id, contact_id) references crm.contacts (business_id, id) on delete cascade,
  constraint manual_actions_closed_complete
    check ((status = 'pending') = (closed_at is null) and (closed_at is null) = (closed_by_kind is null))
);
-- A run waits at one step at a time, so it has one open action at most.
create unique index manual_actions_one_open_idx
  on automation.manual_actions (business_id, enrolment_id) where status = 'pending';
-- The queue: by status, oldest first; and the same narrowed to a workflow or a person.
create index manual_actions_queue_idx on automation.manual_actions (business_id, status, created_at, id);
create index manual_actions_automation_idx
  on automation.manual_actions (business_id, automation_id, status, created_at, id);
create index manual_actions_assignee_idx
  on automation.manual_actions (assignee_user_id, business_id, status, created_at, id);
create index manual_actions_enrolment_idx on automation.manual_actions (business_id, enrolment_id);
create index manual_actions_contact_idx on automation.manual_actions (business_id, contact_id);
call util.enable_tenant_rls('automation.manual_actions');
call util.add_updated_at_trigger('automation.manual_actions');
grant select, insert, update on automation.manual_actions to crm_app;

-- A run that ends any other way (a stop condition, a deleted automation, a failure) takes
-- its open action off the queue, whoever ended it.
create function private.cancel_manual_actions() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.status not in ('running', 'waiting') then
    update automation.manual_actions
    set status = 'cancelled', closed_at = now(), closed_by_kind = 'system'
    where business_id = new.business_id and enrolment_id = new.id and status = 'pending';
  end if;
  return null;
end
$$;
revoke execute on function private.cancel_manual_actions() from public;
create trigger enrolments_cancel_manual_actions after update of status on automation.enrolments
  for each row execute function private.cancel_manual_actions();
