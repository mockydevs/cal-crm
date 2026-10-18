-- Who last edited a note, beside who wrote it (task P1.21, ADR-034). Anyone who may manage
-- notes can edit one, so a note keeps its author and says who changed it last, and when.

-- All three are empty until the first edit; an edit sets the editor's kind and the time, and
-- its id unless the editor is the system, which has none. A pin, which also moves
-- updated_at, isn't an edit.
alter table crm.notes
  add column edited_by_kind text constraint notes_edited_by_kind_valid
    check (edited_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import')),
  add column edited_by_id uuid,
  add column edited_at timestamptz,
  add constraint notes_edited_together check (
    (edited_by_kind is null) = (edited_at is null)
    and (edited_by_id is null or edited_by_kind is not null)
  );

-- Newest first, the id breaking ties between notes written at the same moment, such as an
-- import's, so each page ends exactly where the next begins.
drop index crm.notes_record_idx;
create index notes_record_idx on crm.notes (business_id, record_id, created_at desc, id desc);
