-- The field.changed trigger, and the stop conditions, goals and wait steps that listen for
-- a field change, were stored as listening for an event of type 'field.changed', which
-- nothing has ever emitted. The CRM says a custom field changed as field.value_set or
-- field.value_cleared, and a contact's own field as contact.updated; the engine now
-- listens for those (packages/modules/automation/src/triggers.ts). A version published,
-- and a run started, before that still holds the old rows and would never hear a change.
-- Each old row becomes three, one per real event type, and nothing else about it changes.

insert into automation.trigger_subscriptions
  (business_id, automation_id, version_id, event_type, conditions, created_at)
select s.business_id, s.automation_id, s.version_id, real.event_type, s.conditions, s.created_at
from automation.trigger_subscriptions s
cross join (values ('field.value_set'), ('field.value_cleared'), ('contact.updated'))
  as real (event_type)
where s.event_type = 'field.changed';

delete from automation.trigger_subscriptions where event_type = 'field.changed';

-- created_at is kept: a wait step is woken only by an event recorded after its wait began.
insert into automation.event_waits
  (business_id, enrolment_id, kind, event_type, record_id, conditions, expires_at, created_at)
select w.business_id, w.enrolment_id, w.kind, real.event_type, w.record_id, w.conditions,
  w.expires_at, w.created_at
from automation.event_waits w
cross join (values ('field.value_set'), ('field.value_cleared'), ('contact.updated'))
  as real (event_type)
where w.event_type = 'field.changed';

delete from automation.event_waits where event_type = 'field.changed';
