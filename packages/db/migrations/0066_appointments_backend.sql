-- B11.01 to B11.03 (ADR-075): appointments a signed-in person books, moves, cancels and
-- marks, and the appointment list. Nothing that exists changes its meaning: the five
-- statuses keep their names, a public booking is written as before, and nobody can be
-- booked twice at the same time (appointments_no_double_booking holds booked and confirmed
-- appointments only, as it did).

-- The sixth status. GoHighLevel's appointment has new, confirmed, cancelled, showed, noshow
-- and invalid; ours had no word for an appointment that should not count (a test, a
-- duplicate, a wrong number). An invalid appointment holds nobody's time.
alter table calendar.appointments drop constraint appointments_status_valid;
alter table calendar.appointments
  add constraint appointments_status_valid
    check (status in ('booked', 'confirmed', 'cancelled', 'no_show', 'completed', 'invalid'));

-- A booker's page reads its appointment's receipt back through this check. One marked
-- invalid by the team after a move or a cancellation is still a receipt that can be read.
create or replace function util.valid_appointment_receipt(p_receipt jsonb)
returns boolean language plpgsql stable set search_path = ''
as $$
declare
  starts text;
  ends text;
  instant_pattern constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$';
begin
  if p_receipt is null or pg_catalog.jsonb_typeof(p_receipt)<>'object'
    or pg_catalog.octet_length(p_receipt::text)>1024 then return false; end if;
  if not (p_receipt ?& array['status','startsAt','endsAt'])
    or p_receipt-array['status','startsAt','endsAt']<>'{}'::jsonb then return false; end if;
  if pg_catalog.jsonb_typeof(p_receipt->'status')<>'string'
    or pg_catalog.jsonb_typeof(p_receipt->'startsAt')<>'string'
    or pg_catalog.jsonb_typeof(p_receipt->'endsAt')<>'string' then return false; end if;
  if p_receipt->>'status' not in ('booked','confirmed','cancelled','completed','no_show','invalid') then return false; end if;
  starts := p_receipt->>'startsAt';
  ends := p_receipt->>'endsAt';
  if starts !~ instant_pattern or ends !~ instant_pattern
    or pg_catalog.left(starts,5)='0000-' or pg_catalog.left(ends,5)='0000-' then return false; end if;
  if not pg_catalog.pg_input_is_valid(starts,'timestamp with time zone')
    or not pg_catalog.pg_input_is_valid(ends,'timestamp with time zone') then return false; end if;
  return ends::timestamptz>starts::timestamptz;
end;
$$;

-- Who booked it, when a person of the team did. Null for a booking page's appointment and
-- for every appointment made before this migration. Leaving the team does not remove an
-- account; if the account itself is ever removed, the appointment stays and forgets who.
alter table calendar.appointments
  add column created_by_user_id uuid references auth.users (id) on delete set null;
create index appointments_created_by_idx on calendar.appointments (created_by_user_id)
  where created_by_user_id is not null;

-- The appointment list in the order of "Date added", a page at a time.
create index appointments_created_idx on calendar.appointments (business_id, created_at, id);
