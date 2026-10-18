// What the fields let an assistant propose: a value for one field of a record,
// read from what a contact wrote.
//
// A proposal holds this module's own command, `field.value.set`, with that command's input.
// Applying it runs the command through the command layer as whoever applies it, so the
// field's rules hold for everyone: the field must allow the AI source the value came from,
// and its overwrite setting decides what the assistant may replace on its own ("ask": never
// a value a person entered or confirmed) and what nobody's approval lets it replace
// ("never"). The command keeps those rules in its handler; an assistant that applies its
// own proposal is also held to the business's rule for `update_field`, in the same
// transaction, before the handler.
//
// Undo runs the same command with the value that was there, as the person who undoes, and
// is refused when the value has been changed again since.
import { defineProposable, type Proposable } from '@repo/commands';

import { requireRecord } from '../records/access.js';
import { readSavedRecordField } from './value-read.js';
import { setRecordFieldCommand } from './value-writes.js';

/** The fields' one proposable command: setting a record's value. */
export function createFieldProposables(): readonly Proposable[] {
  return [
    defineProposable({
      kind: 'field_value',
      command: setRecordFieldCommand,
      agents: ['extraction'],
      // The command names no delegation: it keeps its own rule for assistants. This is the
      // action the business's rule is about when an assistant applies the proposal itself.
      action: 'update_field',
      async subject(trx, { id }) {
        const record = await requireRecord(trx, id);
        return {
          recordId: record.id,
          ...(record.kind === 'contact' ? { contactId: record.id } : {}),
        };
      },
      // Made on the value as it was saved then. Anyone changing it since makes the
      // proposal stale, and the command's own revision check refuses it besides.
      revision: async (trx, { id, fieldId }) =>
        (await readSavedRecordField(trx, id, fieldId)).revision,
      // A person may change the value before applying it. It is then their own value: what
      // the assistant read, and how sure it was, no longer describe it.
      change: (input, changes) => ({
        id: input.id,
        fieldId: input.fieldId,
        revision: input.revision,
        value: changes['value'],
      }),
      async present(trx, input) {
        const current = await readSavedRecordField(trx, input.id, input.fieldId);
        return {
          kind: 'field_value',
          fieldId: input.fieldId,
          label: current.definition.label,
          from: current.value,
          fromSource: current.source?.kind ?? null,
          to: input.value,
        };
      },
      capture: async (trx, { id, fieldId }) => (await readSavedRecordField(trx, id, fieldId)).value,
      result: () => ({}),
      // Back to the value that was there (or to empty), made on the value as the command
      // left it: if someone changes it again first, the command refuses the undo.
      undo: (before, field, { id, fieldId }) => ({
        kind: 'field_value',
        input: { id, fieldId, value: before, revision: field.revision },
      }),
    }),
  ];
}
