-- Incoming calls (Phone System stage PS4): the route a call to one of the business's numbers
-- follows. When a call comes in, the worker works out who rings and in what order, from the
-- number's routing and the business's calling defaults, and keeps that plan here under the
-- call. Each answer from a Dial moves the call on by one step, and the next step is always
-- read from here, never from what the provider sent: a replayed or forged report can neither
-- skip a step nor ring one twice.
create table messaging.call_routes (
  business_id uuid not null,
  call_id uuid not null,
  -- The groups that ring, in order. Each group is an array of the people and numbers that
  -- ring together: {"kind": "client", "address": <device identity>, "membershipId": <uuid>}
  -- or {"kind": "number", "address": <E.164>}.
  steps jsonb not null
    constraint call_routes_steps_array check (
      jsonb_typeof(steps) = 'array'
      and jsonb_array_length(steps) <= 20
      and octet_length(steps::text) <= 16384),
  -- The step ringing now, 0 for the first. Equal to the number of steps once every one has
  -- rung and nobody answered.
  step integer not null default 0
    constraint call_routes_step_range check (step >= 0),
  -- Whether a caller nobody answered may leave a voicemail.
  voicemail boolean not null,
  -- How long each step rings, as Twilio is asked for it.
  timeout_seconds integer not null
    constraint call_routes_timeout_range check (timeout_seconds between 5 and 120),
  -- The number a ringing person or outside number sees: the caller's or the business's.
  caller_id text not null
    constraint call_routes_caller_id_format check (caller_id ~ '^\+[1-9][0-9]{6,14}$'),
  -- When the route stopped: someone answered, the caller reached voicemail, or nobody was left.
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, call_id),
  constraint call_routes_call foreign key (business_id, call_id)
    references messaging.calls (business_id, id) on delete cascade,
  constraint call_routes_step_within check (step <= jsonb_array_length(steps))
);
call util.add_updated_at_trigger('messaging.call_routes');
call util.enable_tenant_rls('messaging.call_routes');
grant select, insert, update on messaging.call_routes to crm_app;

comment on table messaging.call_routes is
  'The route an incoming call follows: who rings, in what order, and the step reached. Advanced only by the worker, one step at a time.';
