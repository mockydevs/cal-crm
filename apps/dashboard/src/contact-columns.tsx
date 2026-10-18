// The contact list's "Manage fields": its built-in columns, then the business's custom fields
// under their folders, at most as many fields as a list page answers. Fetched as the list
// first draws: not part of what the list's page loads first.
import type { FieldDefinition } from '@repo/contracts';
import type { ReactElement } from 'react';
import { useFieldColumnChoices } from './field-column-choices';
import { isFieldColumn, MAX_FIELD_COLUMNS, type ContactColumn } from './list-columns';
import { ManageFields, ManageFieldsForm } from './manage-fields';
import type { FieldChoice } from './manage-fields-types';

const limit = { max: MAX_FIELD_COLUMNS, applies: isFieldColumn };

interface ChooserProps {
  /** The built-in columns, in GoHighLevel's order. */
  readonly builtIns: readonly FieldChoice<ContactColumn>[];
  /** The business's contact fields in use. */
  readonly fields: readonly FieldDefinition[];
  readonly value: readonly ContactColumn[];
  readonly onApply: (columns: ContactColumn[]) => void;
}

function useChoices(
  builtIns: readonly FieldChoice<ContactColumn>[],
  fields: readonly FieldDefinition[],
): FieldChoice<ContactColumn>[] {
  return [...builtIns, ...useFieldColumnChoices(fields)];
}

/** The toolbar's button and the panel it opens. */
export function ContactColumnsButton({
  builtIns,
  fields,
  value,
  onApply,
}: ChooserProps): ReactElement {
  return (
    <ManageFields
      choices={useChoices(builtIns, fields)}
      value={value}
      limit={limit}
      onApply={onApply}
    />
  );
}

/** The same form as a step of the panel that adds or edits a smart list. */
export function ContactColumnsStep({
  builtIns,
  fields,
  value,
  onApply,
  onCancel,
}: ChooserProps & { readonly onCancel: () => void }): ReactElement {
  return (
    <ManageFieldsForm
      choices={useChoices(builtIns, fields)}
      value={value}
      limit={limit}
      onApply={onApply}
      onCancel={onCancel}
    />
  );
}
