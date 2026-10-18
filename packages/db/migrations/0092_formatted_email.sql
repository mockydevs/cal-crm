-- Formatted email in templates and in a workflow's Send email step (ADR-092).
--
-- 1. A template may hold formatted text: HTML the messaging module cleaned before it was
--    stored (packages/modules/messaging/src/email-html.ts), beside the plain-text body every
--    template already has, and the preview line mail apps show after the subject. A
--    template with neither new column is the plain-text template it was.
-- 2. A published workflow email's content revision (0071, ADR-078) holds the same two.
-- 3. An outbound message may say whose name it is from and where answers go. A campaign's
--    email reads both from its campaign; a workflow's email keeps them here, on the
--    dispatch row that already holds how the message is sent. Cc and Bcc need no column:
--    messaging.messages has had cc_addresses and bcc_addresses since 0006.
alter table messaging.templates
  add column body_html text constraint templates_body_html_length
    check (length(body_html) between 1 and 200000),
  add column preheader text constraint templates_preheader_valid
    check (length(preheader) between 1 and 150 and preheader !~ '[\r\n]'),
  -- The preview line is hidden text inside the formatted part; plain text has nowhere for it.
  add constraint templates_preheader_needs_html check (preheader is null or body_html is not null);

alter table automation.email_content_revisions
  add column body_html text constraint email_content_body_html_length
    check (length(body_html) between 1 and 200000),
  add column preheader text constraint email_content_preheader_valid
    check (length(preheader) between 1 and 150 and preheader !~ '[\r\n]');

alter table messaging.outbound_dispatch
  add column from_name text constraint outbound_dispatch_from_name_valid
    check (length(from_name) between 1 and 120 and from_name !~ '[\r\n]'),
  -- One address, as the mailbox's own is checked (0006). RFC 5321 4.5.3.1.3: a path is at
  -- most 256 octets with its angle brackets.
  add column reply_to text constraint outbound_dispatch_reply_to_valid
    check (reply_to ~ '^[^@\s]+@[^@\s]+$' and length(reply_to) <= 254);
