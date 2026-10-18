// Custom field values given with a new contact: written in the transaction that
// makes the contact, by the command that sets a field, so they are checked as any change of
// the field is and are on the contact before anything reads it, such as a workflow started
// by the contact being created.
import type { CommandContext } from '@repo/commands';
import { choiceKeyOf, choiceKeysOf, fieldOption } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ForbiddenError, toPublicId, ValidationError, type Issue } from '@repo/kernel';
import * as z from 'zod';

import { readRecordField } from '../fields/value-read.js';
import { setRecordFieldCommand } from '../fields/value-writes.js';

type Given = string | boolean | readonly string[] | null;

const storedOptions = z.array(fieldOption).catch([]);

/**
 * The value a choice field is given as: a choice named by its label becomes its key. What
 * names no choice is passed on as it came, for the field's own check to refuse in its words.
 */
export function asChoiceKeys(
  valueType: string,
  options: readonly { key: string; label: string; archived: boolean }[],
  value: string | boolean | readonly string[],
): string | boolean | string[] {
  if (typeof value === 'boolean') return value;
  if (valueType === 'single_choice')
    return typeof value === 'string' ? (choiceKeyOf(options, value) ?? value) : [...value];
  if (valueType === 'multi_choice')
    return typeof value === 'string'
      ? (choiceKeysOf(options, value) ?? value)
      : value.map((each) => choiceKeyOf(options, each) ?? each);
  return typeof value === 'string' ? value : [...value];
}

/**
 * Writes the custom field values given with a new contact, each by the field's key or id.
 * A field that is not one of the business's contact fields, and a value its field refuses,
 * refuse the whole contact, each said by its place under /fields. Null leaves a field empty.
 */
export async function writeCreatedFields(
  trx: DatabaseTransaction,
  command: CommandContext,
  contact: { readonly id: string; readonly objectTypeId: string },
  given: Readonly<Record<string, Given>> | undefined,
): Promise<void> {
  const entries = Object.entries(given ?? {}).filter(
    (entry): entry is [string, Exclude<Given, null>] => entry[1] !== null,
  );
  if (entries.length === 0) return;
  // Setting a field's value is a permission of its own, as it is for an existing contact.
  if (command.permissions !== 'all' && !command.permissions.has('fields.values'))
    throw new ForbiddenError(
      "Your role doesn't allow setting field values: it needs fields.values.",
      'fields.values',
    );
  const definitions = await trx
    .selectFrom('crm.field_definitions')
    .select(['id', 'key', 'value_type', 'options'])
    .where('object_type_id', '=', contact.objectTypeId)
    .where('merged_into_field_id', 'is', null)
    .execute();
  const named = entries.map(([name, value]) => ({
    name,
    value,
    definition: definitions.find(
      (each) => each.key === name || toPublicId('field', each.id) === name,
    ),
  }));
  const unknown: Issue[] = named
    .filter((each) => each.definition === undefined)
    .map((each) => ({
      path: `/fields/${each.name}`,
      code: 'unknown_field',
      message: 'This is not one of the contact fields. Name a field by its key or id.',
    }));
  const [first, ...rest] = unknown;
  if (first !== undefined) throw new ValidationError([first, ...rest]);
  const record = toPublicId('contact', contact.id);
  for (const { name, value, definition } of named) {
    if (definition === undefined) continue;
    const fieldId = toPublicId('field', definition.id);
    const current = await readRecordField(trx, command, record, fieldId);
    try {
      await setRecordFieldCommand.handle(
        trx,
        {
          id: record,
          fieldId,
          value: asChoiceKeys(
            definition.value_type,
            storedOptions.parse(definition.options),
            value,
          ),
          revision: current.revision,
        },
        command,
      );
    } catch (error) {
      // The field's own refusal, said by the field it was given for.
      if (!(error instanceof ValidationError)) throw error;
      const [issue, ...others] = error.issues;
      const placed = (each: Issue): Issue => ({
        ...each,
        path: `/fields/${name}${each.path === '/value' ? '' : each.path}`,
      });
      throw new ValidationError([placed(issue), ...others.map(placed)]);
    }
  }
}
