-- B1.07 to B1.14: what Settings → Custom Fields, Custom Values and Import Data were
-- missing in the database. Existing rows keep their meaning: no field becomes a system
-- field, every field keeps its folder, key, type and values, and every choice field is
-- shown as it was.

-- System fields (B1.07) -----------------------------------------------------------------------
-- A field the product owns: it can be moved to another folder of its object and given
-- another place in its folder, and nothing else about it can change. Only the system makes
-- one, when the field is made; no field becomes one, or stops being one, afterwards.

alter table crm.field_definitions
  add column is_system boolean not null default false,
  add constraint field_definitions_system_made_by_system
    check (not is_system or created_by_kind = 'system');

-- How a choice field is shown (B1.10) ------------------------------------------------------------
-- GoHighLevel's Radio Select is one choice of several and its Checkbox is several choices
-- of several: what a single choice and a multiple choice field store here already. They
-- differ only in the control that shows them, so that is all that is stored: null for the
-- type's usual control (a dropdown), 'radio' for a single choice shown as radio buttons,
-- 'checkbox' for a multiple choice shown as checkboxes. It is chosen when the field is
-- made and, like the type, never changes.

alter table crm.field_definitions
  add column choice_display text
    constraint field_definitions_choice_display_valid check (
      choice_display is null
      or (choice_display = 'radio' and value_type = 'single_choice')
      or (choice_display = 'checkbox' and value_type = 'multi_choice'));

create function private.guard_field_definition() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.choice_display is distinct from old.choice_display then
    raise exception 'How a choice field is shown is chosen when it is made.'
      using errcode = 'check_violation', constraint = 'field_definitions_choice_display_fixed';
  end if;
  if new.is_system is distinct from old.is_system then
    raise exception 'A field stays a system field, or stays not one.'
      using errcode = 'check_violation', constraint = 'field_definitions_system_fixed';
  end if;
  -- Everything but where it sits. updated_at follows the move.
  if old.is_system
     and (to_jsonb(new) - 'folder_id' - 'position' - 'updated_at')
         is distinct from (to_jsonb(old) - 'folder_id' - 'position' - 'updated_at') then
    raise exception 'A system field can be moved between folders and reordered, not changed.'
      using errcode = 'check_violation', constraint = 'field_definitions_system_field_fixed';
  end if;
  return new;
end
$$;
revoke execute on function private.guard_field_definition() from public;
create trigger field_definitions_guard before update on crm.field_definitions
  for each row execute function private.guard_field_definition();

-- The application may never delete a system field, whatever it asks for. A field still
-- goes with its object type: referential actions are not subject to row-level security.
create policy field_definitions_delete_own_only on crm.field_definitions
  as restrictive for delete
  using (not is_system);

-- The order of fields inside a folder (B1.09) ---------------------------------------------------
-- position was stored and always 0. It now says where a field comes in its folder, from 0.
-- Fields that existed are placed in the order they were made, which is the order every
-- list showed them in. Placing them is not an edit of the field.

alter table crm.field_definitions disable trigger touch_updated_at;
update crm.field_definitions f
set position = placed.place
from (
  select business_id, id,
         (row_number() over (partition by business_id, folder_id order by created_at, id) - 1)::integer as place
  from crm.field_definitions
) placed
where placed.business_id = f.business_id and placed.id = f.id and f.position is distinct from placed.place;
alter table crm.field_definitions enable trigger touch_updated_at;

alter table crm.field_definitions
  add constraint field_definitions_position_not_negative check (position >= 0);
create index field_definitions_folder_order_idx
  on crm.field_definitions (business_id, folder_id, position, id);
