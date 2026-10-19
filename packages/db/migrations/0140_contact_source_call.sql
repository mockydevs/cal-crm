-- Widens the contacts' source constraint to allow 'call' (a contact created from a missed call).

alter table crm.contacts
  drop constraint contacts_created_source_valid,
  add constraint contacts_created_source_valid check (created_source in (
    'user', 'api', 'form', 'booking', 'import', 'email', 'sms', 'call',
    'webchat', 'automation', 'assistant', 'unknown')) not valid;
