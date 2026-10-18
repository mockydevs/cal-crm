-- Merging contacts, as GoHighLevel's Merge Contacts does: one contact is kept, everything of
-- the others moves to it, and the others are gone. Here they go to the trash, marked with
-- the contact they were merged into, so an old link or API call finds where they went and a
-- missed row is still there until the trash is purged. A merge cannot be undone, so a merged
-- contact cannot be restored: the check below holds that whatever writes the row.
--
-- crm.contacts is large and read on every inbound message. Adding a nullable column with no
-- default touches no row; the foreign key and the checks are added NOT VALID and validated
-- after. The migration is one transaction, so the lock the ALTER took on crm.contacts is
-- held while they validate: writes to contacts wait briefly while the table is read once.

alter table crm.contacts add column merged_into_id uuid;
alter table crm.contacts
  add constraint contacts_merged_into_fkey
    foreign key (business_id, merged_into_id) references crm.contacts (business_id, id)
    on delete set null (merged_into_id) not valid,
  add constraint contacts_merged_into_other
    check (merged_into_id <> id) not valid,
  add constraint contacts_merged_is_trashed
    check (merged_into_id is null or deleted_at is not null) not valid;
alter table crm.contacts validate constraint contacts_merged_into_fkey;
alter table crm.contacts validate constraint contacts_merged_into_other;
alter table crm.contacts validate constraint contacts_merged_is_trashed;
comment on column crm.contacts.merged_into_id is
  'The contact this one was merged into. Set only on a contact in the trash, which stays there.';

-- Few contacts are ever merged: the index holds only those, for the foreign key's lookups
-- when the contact they were merged into is purged.
create index contacts_merged_into_idx
  on crm.contacts (business_id, merged_into_id) where merged_into_id is not null;

-- A merged contact's files move to the contact it was merged into. A file that filled one
-- of its file fields, where the merge kept the other contact's value, stays one of the
-- record's files and no longer fills the field.
grant update (record_id, field_id) on crm.record_files to crm_app;
