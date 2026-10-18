-- Two more things an inbox UID can be (ADR-098): a spam complaint from a mailbox provider's
-- feedback loop (RFC 5965), handled as a bounce is, and mail whose From address the
-- receiving server says was forged (DMARC failed), which is not filed under a contact.
alter table messaging.mailbox_inbound_uids drop constraint mailbox_inbound_uids_outcome_valid;
alter table messaging.mailbox_inbound_uids add constraint mailbox_inbound_uids_outcome_valid
  check (outcome in (
    'stored',
    'duplicate',
    'refused',
    'own_message',
    'sender_is_mailbox',
    'sender_unresolved',
    'delivery_report',
    'before_connection',
    'complaint_report',       -- an RFC 5965 feedback report, left for complaint handling
    'sender_unauthenticated'  -- Authentication-Results says DMARC failed for the From domain
  ));
