-- Inbound do not disturb, and a notice for the people who follow a contact.

-- Inbound do not disturb is one switch for what the contact sends in. A text message from
-- them is not stored, not shown in a conversation, not passed on to the team and starts no
-- automation; a STOP or START in one still changes their consent, with the message's SID as
-- proof, and that is all that is kept of it. Their calls are not blocked until the phone
-- system checks this. It stops nothing the business sends them; do_not_contact and
-- dnd_channels are for that.
alter table crm.contacts
  add column dnd_inbound boolean not null default false;

-- A contact wrote in a conversation whose contact you follow.
alter table notifications.notifications
  drop constraint notifications_kind_valid,
  add constraint notifications_kind_valid check (kind in (
    'conversation.assigned', 'message.received', 'message.received_other',
    'message.received_following', 'task.assigned', 'task.due', 'appointment.booked',
    'appointment.rescheduled', 'appointment.cancelled', 'form.submitted', 'ai.limit_reached',
    'automation.notice', 'calendar.google_disconnected'
  ));

alter table notifications.preferences
  drop constraint preferences_kind_valid,
  add constraint preferences_kind_valid check (kind in (
    'conversation.assigned', 'message.received', 'message.received_other',
    'message.received_following', 'task.assigned', 'task.due', 'appointment.booked',
    'appointment.rescheduled', 'appointment.cancelled', 'form.submitted', 'ai.limit_reached',
    'automation.notice', 'calendar.google_disconnected'
  ));
