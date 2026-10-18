-- Webhooks to installed apps. The agency gives an app one https address, the event types it
-- wants and a signing secret sealed in the vault. An event that a live install subscribes
-- to queues a dispatch job in the writer's transaction; the job writes one delivery per
-- install, and the worker sends each, signed, retried, and recorded here.

alter table tenancy.marketplace_apps
  add column webhook_url text
    constraint marketplace_apps_webhook_https
    check (length(webhook_url) <= 2048 and webhook_url ~ '^https://[^\s]+$'),
  -- The catalog's event types (the contracts check each); the table checks their shape.
  add column webhook_events text[] not null default '{}'
    constraint marketplace_apps_webhook_events_shape
    check (cardinality(webhook_events) <= 64 and array_position(webhook_events, null) is null),
  -- The signing secret, sealed in the vault for the agency; only the worker opens it.
  add column webhook_secret_id uuid,
  add column webhook_secret_set_at timestamptz,
  add constraint marketplace_apps_webhook_secret_pair
    check ((webhook_secret_id is null) = (webhook_secret_set_at is null)),
  add constraint marketplace_apps_webhook_events_need_url
    check (cardinality(webhook_events) = 0 or webhook_url is not null),
  add constraint marketplace_apps_webhook_secret_owner foreign key (agency_id, webhook_secret_id)
    references vault.secrets (agency_id, id);
create index marketplace_apps_webhook_secret_idx
  on tenancy.marketplace_apps (agency_id, webhook_secret_id);

-- One message to one install about one event, and what became of it.
create table tenancy.marketplace_webhook_deliveries (
  business_id uuid not null,
  id uuid not null default uuidv7(),
  agency_id uuid not null,
  install_id uuid not null,
  app_id uuid not null,
  -- The event it tells of. No foreign key: the event log is append-only and archived by month.
  event_id uuid not null,
  event_type text not null constraint marketplace_webhook_deliveries_event_type_format
    check (event_type ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  -- The JSON sent, the same on every attempt: names and ids, never a record's contents.
  body jsonb not null constraint marketplace_webhook_deliveries_body_object
    check (jsonb_typeof(body) = 'object' and pg_column_size(body) <= 16384),
  status text not null default 'pending' constraint marketplace_webhook_deliveries_status
    check (status in ('pending', 'delivered', 'failed')),
  attempts smallint not null default 0 constraint marketplace_webhook_deliveries_attempts
    check (attempts between 0 and 100),
  -- The last attempt: its HTTP status when one came back, else why it failed.
  last_status smallint constraint marketplace_webhook_deliveries_last_status
    check (last_status between 100 and 599),
  last_error text constraint marketplace_webhook_deliveries_last_error_length
    check (length(last_error) <= 1000),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, id),
  constraint marketplace_webhook_deliveries_once unique (business_id, event_id, install_id),
  foreign key (agency_id, business_id) references tenancy.businesses (agency_id, id)
    on delete cascade,
  foreign key (business_id, install_id) references tenancy.marketplace_installs (business_id, id)
    on delete cascade,
  foreign key (agency_id, app_id) references tenancy.marketplace_apps (agency_id, id)
    on delete cascade,
  constraint marketplace_webhook_deliveries_delivered
    check ((status = 'delivered') = (delivered_at is not null))
);
-- The agency's view of an app's deliveries, newest first, and a business's own.
create index marketplace_webhook_deliveries_app_idx
  on tenancy.marketplace_webhook_deliveries (agency_id, app_id, created_at desc);
create index marketplace_webhook_deliveries_business_idx
  on tenancy.marketplace_webhook_deliveries (agency_id, business_id);
create index marketplace_webhook_deliveries_install_idx
  on tenancy.marketplace_webhook_deliveries (business_id, install_id, created_at);
call util.add_updated_at_trigger('tenancy.marketplace_webhook_deliveries');
call util.enable_scoped_rls('tenancy.marketplace_webhook_deliveries');
-- Deliveries older than 30 days are deleted by the dispatch job.
grant select, insert, update, delete on tenancy.marketplace_webhook_deliveries to crm_app;

-- An event that an install in its business subscribes to queues one dispatch job, in the
-- same transaction; app.installed and app.uninstalled go to an app with a webhook whether
-- or not it subscribed. A business with no such install queues nothing.
create function private.queue_app_webhooks() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.business_id is null then
    return null;
  end if;
  if (
    new.type in ('marketplace_app.installed', 'marketplace_app.uninstalled')
    and new.subject_kind = 'marketplace_app'
    and exists (
      select 1 from tenancy.marketplace_apps a
      where a.agency_id = new.agency_id and a.id = new.subject_id and a.webhook_url is not null
    )
  ) or exists (
    select 1
    from tenancy.marketplace_installs i
    join tenancy.marketplace_apps a on a.agency_id = i.agency_id and a.id = i.app_id
    where i.business_id = new.business_id and i.uninstalled_at is null
      and a.webhook_url is not null and new.type = any (a.webhook_events)
  ) then
    perform graphile_worker.add_job(
      'marketplace.dispatch_event',
      payload := jsonb_build_object(
        'agencyId', new.agency_id,
        'businessId', new.business_id,
        'correlationId', new.correlation_id,
        'causationId', new.id,
        'data', jsonb_build_object('eventId', new.id, 'recordedAt', new.recorded_at)
      )::json,
      job_key := 'marketplace-dispatch:' || new.id::text,
      job_key_mode := 'preserve_run_at'
    );
  end if;
  return null;
end
$$;
revoke execute on function private.queue_app_webhooks() from public;

create trigger events_queue_app_webhooks
  after insert on events.events
  for each row execute function private.queue_app_webhooks();

-- Queues an attempt at a delivery of the caller's agency (and business, inside one), now or
-- later. One job per delivery: queuing it again, as Send again does, replaces a waiting
-- retry rather than adding a second.
create function private.enqueue_marketplace_delivery(
  p_delivery_id uuid,
  p_run_at timestamptz default now()
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_business_id uuid;
begin
  select d.business_id into v_business_id
  from tenancy.marketplace_webhook_deliveries d
  where d.id = p_delivery_id and d.agency_id = app.agency_id()
    and (app.business_id() is null or d.business_id = app.business_id());
  if not found then
    raise exception 'delivery is not available in this context';
  end if;
  perform graphile_worker.add_job(
    'marketplace.deliver',
    payload := jsonb_build_object(
      'agencyId', app.agency_id(),
      'businessId', v_business_id,
      'correlationId', app.correlation_id(),
      'causationId', null,
      'data', jsonb_build_object('deliveryId', p_delivery_id)
    )::json,
    run_at := p_run_at,
    job_key := 'marketplace-delivery:' || p_delivery_id::text,
    job_key_mode := 'replace'
  );
end
$$;
revoke execute on function private.enqueue_marketplace_delivery(uuid, timestamptz) from public;
grant execute on function private.enqueue_marketplace_delivery(uuid, timestamptz) to crm_app;
