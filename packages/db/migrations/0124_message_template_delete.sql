-- Message templates can be deleted to a trash and restored from it.
--
-- A template in the trash is archived too. Everything that reads templates (workflow sends,
-- publishing, sync and copies, campaigns, setup, folder counts, the picker) already treats
-- an archived template as unavailable, and the unique-name index covers live templates
-- only, so a deleted template is unavailable and frees its name with no change anywhere
-- else. deleted_at says which archived templates are in the trash. Templates keep their own
-- trash, as workflows do: the CRM's trash holds records, and messaging is a module apart.
-- Nothing empties the trash: published workflow versions name templates by id.
--
-- Deployed while the app runs: the check is NOT VALID, so it holds for every row written
-- from now on without a scan under the table's lock (every existing row meets it: the new
-- column is empty). Building the partial index still reads the whole table under SHARE,
-- so template writes wait for that scan; the table is small, so the wait is short.

alter table messaging.templates
  add column deleted_at timestamptz,
  add constraint templates_deleted_is_archived
    check (deleted_at is null or archived_at is not null) not valid;

-- Finds a business's templates in the trash, for the Trash view and its count. The view
-- sorts them by name or by last change, not by this index's order.
create index templates_trash_list
  on messaging.templates (business_id, deleted_at desc, id) where deleted_at is not null;
