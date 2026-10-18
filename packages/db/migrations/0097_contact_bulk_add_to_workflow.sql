-- Contacts → Bulk Actions → "Add to workflow" (tasks/limelight-parity.md, gap 4): a bulk
-- action that enrols the contacts selected in the list, or a whole filtered list, in one
-- published workflow, by the rules every enrolment keeps. The workflow is kept in the
-- action's parameters as the id the application resolved when it started, as tags and an
-- owner already are.
--
-- Only the list of kinds an action may be grows. No row is rewritten, and the reasons a
-- contact is skipped are already any short code (contact_bulk_action_items_reason_format).

alter table crm.contact_bulk_actions
  drop constraint contact_bulk_actions_action_valid;

alter table crm.contact_bulk_actions
  add constraint contact_bulk_actions_action_valid
    check (action in ('add_tags', 'remove_tags', 'trash', 'assign_owner', 'add_to_workflow'));
