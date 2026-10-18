// task.create: a task on the enrolled record, through the CRM's own task command. It goes
// to the record's owner when it has one who is still on the team, and is left unassigned
// otherwise, for anyone to pick up.
import type { CommandContext } from '@repo/commands';
import {
  addDuration,
  createTaskInput,
  parseInput,
  type ConditionValues,
  type RecordKind,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId, ValidationError } from '@repo/kernel';
import { createTaskCommand, type TaskOptions } from '@repo/module-crm';

import { runActionCommand } from './actions-command.js';

import { mergedText } from './actions-text.js';

const OWNED = {
  contact: 'crm.contacts',
  company: 'crm.companies',
  deal: 'crm.deals',
} as const satisfies Record<RecordKind, string>;

const refuse = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path, code, message }]);

/** Creates the step's task on the record, and gives its public id. */
export async function createStepTask(
  trx: DatabaseTransaction,
  command: CommandContext,
  options: TaskOptions,
  input: {
    readonly record: { readonly id: string; readonly kind: RecordKind };
    readonly config: {
      readonly title: string;
      readonly dueIn?: string | undefined;
      readonly notes?: string | undefined;
    };
    readonly values: ConditionValues;
    readonly now: Date;
  },
): Promise<{ taskId: string }> {
  const { record, config } = input;
  const text = mergedText({ title: config.title, notes: config.notes ?? '' }, input.values);
  const dueAt = config.dueIn === undefined ? null : addDuration(input.now, config.dueIn);
  // An Invalid Date can't be written out; the CRM never sees it.
  if (dueAt === undefined || (dueAt !== null && Number.isNaN(dueAt.getTime())))
    throw refuse('/config/dueIn', 'date_out_of_range', 'The task would be due beyond any date.');
  const owned = await trx
    .selectFrom(OWNED[record.kind])
    .select('owner_user_id')
    .where('id', '=', record.id)
    .executeTakeFirst();
  const owner = owned?.owner_user_id ?? null;
  // The CRM assigns by membership. An owner who left the team has none, so nobody is named.
  const assignee =
    owner === null
      ? null
      : ((await options.assignees.memberships(trx, command.context, [owner])).get(owner) ?? null);
  const task = await runActionCommand(
    command,
    createTaskCommand(options),
    parseInput(createTaskInput, {
      recordId: toPublicId(record.kind, record.id),
      title: text.title,
      description: text.notes,
      dueAt: dueAt === null ? null : dueAt.toISOString(),
      assignee,
    }),
  );
  return { taskId: task.id };
}
