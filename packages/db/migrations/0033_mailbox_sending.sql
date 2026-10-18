-- SMTP admission is separate from connection status: a temporary quota pause must
-- leave IMAP and queued outbound messages available. Daily usage counts reservations.
alter table messaging.mailboxes
  add constraint mailboxes_daily_limit_bounded check (daily_limit <= 100000),
  add column pacing_per_minute integer not null default 5
    constraint mailboxes_pacing_positive check (pacing_per_minute between 1 and 600),
  add column sending_paused_until timestamptz,
  add column sending_pause_reason text
    constraint mailboxes_sending_pause_reason_valid check (sending_pause_reason = 'provider_temporary'),
  add constraint mailboxes_sending_pause_complete
    check ((sending_paused_until is null) = (sending_pause_reason is null));

update messaging.mailboxes set warmup_started_at=created_at where warmup_started_at is null;

create index outbound_dispatch_reserved_idx on messaging.outbound_dispatch (business_id, reserved_at)
  where reserved_at is not null;
