import type { CommandContext } from '@repo/commands';
import {
  createNoteInput,
  noteDocumentFromText,
  parseInput,
  type ConditionValues,
  type RecordKind,
} from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import { createNoteCommand, type TaskOptions } from '@repo/module-crm';

import { runActionCommand } from './actions-command.js';

import { mergedText } from './actions-text.js';

export async function createStepNote(
  command: CommandContext,
  options: TaskOptions,
  record: { readonly id: string; readonly kind: RecordKind },
  text: string,
  values: ConditionValues,
): Promise<{ noteId: string }> {
  const rendered = mergedText({ title: '', notes: text }, values).notes;
  const body = parseInput(createNoteInput, {
    body: noteDocumentFromText(rendered),
  });
  const note = await runActionCommand(command, createNoteCommand(options.actorNames), {
    id: toPublicId(record.kind, record.id),
    ...body,
  });
  return { noteId: note.id };
}
