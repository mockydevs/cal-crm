import {
  addDuration,
  createNoteInput,
  createTaskInput,
  noteDocumentFromText,
  parseInput,
  setContactDndInput,
  type AutomationStep,
  type ConditionValues,
} from '@repo/contracts';
import { ValidationError } from '@repo/kernel';

import { mergedText } from './actions-text.js';

/** Validates native record actions without executing commands or allocating real ids. */
export function simulateRecordAction(
  step: AutomationStep,
  key: string,
  values: ConditionValues,
  now: Date,
  sequence: number,
): Readonly<Record<string, string>> | undefined {
  if (step.type === 'dnd.set') {
    const reason = mergedText({ title: '', notes: step.config.reason }, values).notes;
    parseInput(setContactDndInput.pick({ reason: true }), { reason });
    return undefined;
  }
  if (step.type === 'note.create') {
    const text = mergedText({ title: '', notes: step.config.text }, values).notes;
    parseInput(createNoteInput, { body: noteDocumentFromText(text) });
    return { noteId: `simulated:note:${key}:${String(sequence)}` };
  }
  if (step.type === 'task.create') {
    const text = mergedText({ title: step.config.title, notes: step.config.notes ?? '' }, values);
    const dueAt = step.config.dueIn === undefined ? null : addDuration(now, step.config.dueIn);
    if (dueAt === undefined || (dueAt !== null && Number.isNaN(dueAt.getTime())))
      throw new ValidationError([
        {
          path: '/config/dueIn',
          code: 'date_out_of_range',
          message: 'The task would be due beyond any date.',
        },
      ]);
    parseInput(createTaskInput, {
      title: text.title,
      description: text.notes,
      dueAt: dueAt === null ? null : dueAt.toISOString(),
    });
    return { taskId: `simulated:task:${key}:${String(sequence)}` };
  }
  return undefined;
}
