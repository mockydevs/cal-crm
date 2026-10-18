-- The data the list and board screens read (tasks B3.01 to B3.05, ADR-067): a contact's last
-- activity, a list's table columns, a deal's source and the time its status last changed, a
-- conversation's star, and the indexes the board, the calendar grid and the dashboard's
-- opportunity numbers are read from. No new table: everything here belongs to a row that
-- already exists.

-- B3.01 Contacts list -------------------------------------------------------------------

-- A contact's last activity is the newest entry of its timeline that is the contact getting
-- in touch: a message from them, a form they sent in, an appointment booked, moved or
-- cancelled. It is read, not stored: this index holds exactly those entries, newest first
-- for each record, so the list finds each row's with one descent, and nothing has to keep a
-- second copy right in the writer's transaction. Changing which events count means a new
-- index with the new list, in a later migration.
create index timeline_entries_contact_activity_idx
  on crm.timeline_entries (business_id, record_id, occurred_at desc, event_id desc)
  include (event_recorded_at, event_type)
  where event_type in ('message.received', 'form.submitted', 'appointment.booked',
                       'appointment.rescheduled', 'appointment.cancelled');

-- The columns a list's table shows, in order, saved with the view. `columns` (0005) keeps
-- the four keys the first table had; this is the whole choice. Null: the view has none of
-- its own. The application checks the keys; a list is a document, never filtered on.
alter table crm.saved_views
  add column table_columns jsonb
    constraint saved_views_table_columns_array
      check (table_columns is null or jsonb_typeof(table_columns) = 'array');

-- B3.02 Opportunities -------------------------------------------------------------------

-- Where a deal came from, in the words of whoever recorded it. Empty is null, never ''.
alter table crm.deals
  add column source text
    constraint deals_source_length
      check (source is null or (source = btrim(source) and length(source) between 1 and 200)),
  -- When the status last became what it is: the creation, a close, or a reopening.
  add column status_changed_at timestamptz;

-- A closed deal's close is its last change of status (closed_at moves on every change
-- between won and lost). An open deal was either never closed, or reopened: the reopening
-- is in the event log while that month is kept, and otherwise the creation stands.
update crm.deals d set status_changed_at = coalesce(
  d.closed_at,
  (select max(e.occurred_at) from events.events e
   where e.subject_id = d.id and e.business_id = d.business_id and e.type = 'deal.reopened'),
  d.created_at);

alter table crm.deals
  alter column status_changed_at set default now(),
  alter column status_changed_at set not null;

-- Whatever a writer sets, the column holds when the status last changed.
create function private.stamp_deal_status_change()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status_changed_at := coalesce(new.closed_at, new.created_at);
  elsif new.status is distinct from old.status then
    new.status_changed_at := coalesce(new.closed_at, clock_timestamp());
  else
    new.status_changed_at := old.status_changed_at;
  end if;
  return new;
end
$$;
revoke execute on function private.stamp_deal_status_change() from public;
create trigger stamp_status_change
  before insert or update on crm.deals
  for each row execute function private.stamp_deal_status_change();

-- One column of the board, a page at a time in the list's order (newest id first).
create index deals_stage_page_idx
  on crm.deals (business_id, pipeline_id, stage_id, id desc) where deleted_at is null;

-- B3.05 Dashboard: a pipeline's deals whose status changed, or that were created, in a
-- range of dates, without reading the deals outside it.
create index deals_status_changed_idx
  on crm.deals (business_id, pipeline_id, status_changed_at) where deleted_at is null;
create index deals_created_idx
  on crm.deals (business_id, pipeline_id, created_at) where deleted_at is null;

-- B3.03 Conversations -------------------------------------------------------------------

-- One star for the team, as read state is the team's. Null: not starred.
alter table messaging.conversations add column starred_at timestamptz;
-- The Starred tab, in the list's order.
create index conversations_starred_idx on messaging.conversations
  (business_id, (coalesce(last_message_at, created_at)) desc, id desc)
  where starred_at is not null;

-- B3.04 Calendars -----------------------------------------------------------------------

-- What is on the calendar between two instants. An appointment that overlaps a window
-- starts before the window ends and no more than its own length before the window starts;
-- with a longest length the read is one range of this index, whatever the history. The
-- booking page makes appointments of at most eight hours (calendars_slot_range).
alter table calendar.appointments
  add constraint appointments_duration_bounded check (ends_at - starts_at <= interval '31 days');
create index appointments_window_idx on calendar.appointments (business_id, starts_at);
-- Absences have no longest length (leave can be months), so they are found by their end:
-- past ones are skipped, and a person has at most 730.
create index user_absences_window_idx on calendar.user_absences (business_id, ends_at);
