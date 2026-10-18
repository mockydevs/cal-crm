-- F13.14: the Dashboard's email numbers over a range of dates (GET /reports/email). Each
-- is counted on the day it happened, so each is read by its own date: an email sent by
-- sent_at, one refused or bounced by failed_at, one received by created_at, and a
-- withdrawal of consent by recorded_at. Until now a business's messages could only be
-- reached through a conversation, an account or a Message-ID, and its consents through a
-- contact: a range of dates read every row the business has.
--
-- Partial, so each holds only the rows its count reads: most messages never fail, and
-- text messages, chat and notes are in none of them. The booking numbers
-- (GET /reports/appointments) need nothing new: appointments_window_idx (0057) and
-- appointments_created_idx (0066) already lead with the business and the date.

create index messages_email_sent_idx on messaging.messages (business_id, sent_at)
  where channel = 'email' and direction = 'outbound' and sent_at is not null;
create index messages_email_failed_idx on messaging.messages (business_id, failed_at)
  where channel = 'email' and direction = 'outbound' and failed_at is not null;
create index messages_email_received_idx on messaging.messages (business_id, created_at)
  where channel = 'email' and direction = 'inbound';
create index consents_email_withdrawn_idx on messaging.consents (business_id, recorded_at)
  where channel = 'email' and status = 'withdrawn';
