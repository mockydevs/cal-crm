-- Incoming calls: which Dial the route is waiting on. The action address of each Dial names
-- the first leg it added, and the route keeps that leg here, so the answer to a Dial moves
-- the call on only if it is the answer to the Dial ringing now. A repeated or late answer
-- to an earlier Dial changes nothing.
alter table messaging.call_routes
  add column step_leg_id uuid,
  add constraint call_routes_step_leg foreign key (business_id, step_leg_id)
    references messaging.call_legs (business_id, id) on delete set null (step_leg_id);
create index call_routes_step_leg_idx on messaging.call_routes (business_id, step_leg_id)
  where step_leg_id is not null;
