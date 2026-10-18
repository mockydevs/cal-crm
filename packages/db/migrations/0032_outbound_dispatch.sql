-- A reservation survives worker retries and crashes. SMTP cannot promise exactly-once
-- delivery: an ambiguous reservation is reviewed, never silently re-sent (ADR-037).
alter table crm.contacts add column do_not_contact boolean not null default false;
alter table messaging.settings add column contact_daily_limit integer not null default 10
  constraint settings_contact_daily_limit_positive check (contact_daily_limit between 1 and 10000);
alter table messaging.messages drop constraint messages_status_valid;
alter table messaging.messages add constraint messages_status_valid check (status in (
  'received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'bounced', 'unknown'));

create table messaging.outbound_dispatch (
  business_id uuid not null,
  id uuid not null,
  identity_id uuid,
  purpose text not null constraint outbound_dispatch_purpose_valid check (purpose in ('marketing','transactional')),
  lane text not null constraint outbound_dispatch_lane_valid check (lane in ('reply','transactional','automation','campaign')),
  request_hash text not null constraint outbound_dispatch_hash_valid check (request_hash ~ '^[0-9a-f]{64}$'),
  reserved_at timestamptz,
  finished_at timestamptz,
  primary key (business_id,id),
  foreign key (business_id,id) references messaging.messages (business_id,id) on delete cascade,
  foreign key (business_id,identity_id) references crm.contact_identities (business_id,id) on delete set null (identity_id),
  constraint outbound_dispatch_finish_needs_reservation check (finished_at is null or reserved_at is not null)
);
create index outbound_dispatch_identity_idx on messaging.outbound_dispatch (business_id,identity_id);
create index messages_outbound_frequency_idx on messaging.messages (business_id,conversation_id,created_at)
  where direction='outbound';
call util.enable_tenant_rls('messaging.outbound_dispatch');
grant select, insert, update on messaging.outbound_dispatch to crm_app;

-- Queue and payload scope are derived from the visible message, never caller input.
-- One named queue per business uses at most one worker slot. Priority is global,
-- so replies/transactional work can run before an idle campaign backlog.
create function private.enqueue_outbound(p_message_id uuid) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_message messaging.messages%rowtype;
  v_job_id bigint;
begin
  select m.* into v_message from messaging.messages m
  join tenancy.businesses b on b.id=m.business_id
  join messaging.outbound_dispatch d on d.business_id=m.business_id and d.id=m.id
  where m.business_id=app.business_id() and b.agency_id=app.agency_id()
    and m.id=p_message_id and m.direction='outbound' and m.status='queued';
  if not found then
    raise exception 'outbound message is not available in this context';
  end if;
  select job.id into v_job_id from graphile_worker.add_job(
    'messaging.dispatch',
    payload := jsonb_build_object(
      'agencyId',app.agency_id(),'businessId',app.business_id(),
      'correlationId',app.correlation_id(),
      'data',jsonb_build_object('messageId',p_message_id)
    )::json,
    queue_name := 'outbound:' || v_message.business_id::text,
    run_at := coalesce(v_message.scheduled_for,now()),
    job_key := 'outbound:' || p_message_id::text,
    job_key_mode := 'preserve_run_at',
    priority := v_message.priority
  ) as job;
  return v_job_id;
end
$$;
revoke execute on function private.enqueue_outbound(uuid) from public;
grant execute on function private.enqueue_outbound(uuid) to crm_app;
