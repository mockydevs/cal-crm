-- P1.28: credentials wait encrypted in the vault while the worker verifies both sign-ins.
-- A pending attempt is not a mailbox or channel account. Completion transfers its secret
-- to the new mailbox, or removes it on failure, in the same transaction as the result.
create table messaging.mailbox_connection_attempts (
  business_id uuid not null references tenancy.businesses (id) on delete cascade,
  id uuid not null default uuidv7(),
  email_address text not null constraint mailbox_attempts_email_format
    check (length(email_address) <= 320 and email_address ~ '^[^@\s]+@[^@\s]+$'),
  email_normalized text generated always as (lower(btrim(email_address))) stored,
  secret_id uuid,
  status text not null default 'pending' constraint mailbox_attempts_status_valid
    check (status in ('pending', 'connected', 'failed')),
  mailbox_id uuid,
  result jsonb constraint mailbox_attempts_result_object check (jsonb_typeof(result) = 'object'),
  failure_code text constraint mailbox_attempts_failure_valid
    check (failure_code in ('connection_failed', 'expired', 'credentials_unreadable')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  finished_at timestamptz,
  primary key (business_id, id),
  foreign key (business_id, secret_id) references vault.secrets (business_id, id),
  foreign key (business_id, mailbox_id) references messaging.mailboxes (business_id, id) on delete cascade,
  constraint mailbox_attempts_completion_consistent check (
    (status = 'pending' and secret_id is not null and mailbox_id is null
      and result is null and failure_code is null and finished_at is null)
    or (status = 'connected' and secret_id is null and mailbox_id is not null
      and result is not null and failure_code is null and finished_at is not null
      and coalesce(result->'smtp'->>'status' = 'pass' and result->'imap'->>'status' = 'pass', false))
    or (status = 'failed' and secret_id is null and mailbox_id is null
      and failure_code is not null and finished_at is not null)
  ),
  constraint mailbox_attempts_expiry_after_creation check (expires_at > created_at)
);
create unique index mailbox_attempts_pending_email_unique
  on messaging.mailbox_connection_attempts (business_id, email_normalized) where status = 'pending';
create index mailbox_attempts_secret_idx on messaging.mailbox_connection_attempts (business_id, secret_id);
create index mailbox_attempts_mailbox_idx on messaging.mailbox_connection_attempts (business_id, mailbox_id);
create index mailbox_attempts_expiry_idx on messaging.mailbox_connection_attempts (expires_at, id)
  where status = 'pending';
call util.enable_tenant_rls('messaging.mailbox_connection_attempts');
grant select, insert, update, delete on messaging.mailbox_connection_attempts to crm_app;

-- Maintenance lists identifiers only; each cleanup then runs in its own tenant transaction.
create function private.expired_mailbox_attempts(p_limit integer)
returns table (agency_id uuid, business_id uuid, attempt_id uuid)
language sql stable security definer set search_path = ''
as $$
  select b.agency_id, a.business_id, a.id
  from messaging.mailbox_connection_attempts a
  join tenancy.businesses b on b.id = a.business_id
  where a.status = 'pending' and a.expires_at <= now()
  order by a.expires_at, a.id
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke execute on function private.expired_mailbox_attempts(integer) from public;
grant execute on function private.expired_mailbox_attempts(integer) to crm_app;
