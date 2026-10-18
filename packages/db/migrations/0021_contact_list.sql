-- The contact list's two orders (task P1.12), over contacts not in the trash, so a page is
-- read from the index in order rather than sorted from every contact of the business.
-- Keyset paging continues after a row: (created_at, id) for the newest first, and
-- (lower(display_name), id) by name, where unnamed contacts come last.

create index contacts_newest_idx
  on crm.contacts (business_id, created_at desc, id desc) where deleted_at is null;

create index contacts_name_idx
  on crm.contacts (business_id, lower(display_name), id) where deleted_at is null;
