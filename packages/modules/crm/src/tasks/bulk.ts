// One change applied to many tasks at once. What each action does to a task is done by the
// single-task command itself: task.complete for complete and reopen, task.update for an
// assignee or a due date, task.delete. Its handler runs here, inside a savepoint for each
// task, with the revision read a moment before, so every rule is the single command's and
// so is every event: automations, notifications and timelines cannot tell a bulk change
// from the same change made one task at a time.
//
// A task the single command refuses is skipped with the reason and its savepoint undone;
// the others go on. Anything that is not a refusal is a fault, and undoes the whole request.
// A task already as asked is left alone: nothing is written and no event is made.
import { defineCommand, requireBusiness, type Command, type CommandContext } from '@repo/commands';
import {
  bulkTasksInput,
  type BulkTasksInput,
  type BulkTasksResult,
  type TaskBulkSkipCode,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';

import {
  completeTaskCommand,
  deleteTaskCommand,
  recordsOf,
  requireTask,
  revisionOf,
  updateTaskCommand,
  version,
  type TaskOptions,
  type TaskRow,
} from './tasks.js';

type Result = BulkTasksResult['results'][number];
type Outcome = Pick<Result, 'outcome' | 'reason'>;

const reasons: Record<TaskBulkSkipCode, string> = {
  not_found: 'This task was not found.',
  record_in_trash: 'This task belongs to a record in the trash. Restore the record first.',
  changed: 'This task was changed while the action ran. Try it again.',
  assignee_unavailable:
    'The person this task is assigned to is no longer on the team. Choose an assignee in the task first.',
};
const skipped = (code: TaskBulkSkipCode): Outcome => ({
  outcome: 'skipped',
  reason: { code, message: reasons[code] },
});
const did = (changed: boolean): Outcome => ({
  outcome: changed ? 'done' : 'unchanged',
  reason: null,
});

/** Why the single-task command's refusal skips the task; undefined when it is no refusal. */
function skipCodeOf(error: unknown): TaskBulkSkipCode | undefined {
  // Deleted, or its record purged, between this request's read and the command's.
  if (error instanceof NotFoundError) return 'not_found';
  // The revision no longer matches, or the record went to the trash in between.
  if (error instanceof ConflictError) return 'changed';
  return undefined;
}

export function bulkTasksCommand(
  options: TaskOptions,
): Command<typeof bulkTasksInput, BulkTasksResult> {
  const update = updateTaskCommand(options);
  const complete = completeTaskCommand(options);

  /** Changes one task by its own command, and says whether anything was written. */
  async function apply(
    trx: DatabaseTransaction,
    command: CommandContext,
    input: BulkTasksInput,
    current: TaskRow,
    assignee: string | null,
  ): Promise<Outcome> {
    const id = toPublicId('task', current.id);
    const revision = revisionOf(current);
    if (input.action === 'complete' || input.action === 'reopen') {
      const completed = input.action === 'complete';
      if ((current.completed_at !== null) === completed) return did(false);
      await complete.handle(trx, { id, completed, revision }, command);
      return did(true);
    }
    if (input.action === 'delete') {
      await deleteTaskCommand.handle(trx, { id, revision }, command);
      return did(true);
    }
    // task.update saves the title, the description, the due date and the assignee
    // together: the ones this action does not name are sent as they are.
    const kept = {
      id,
      revision,
      title: current.title,
      description: current.body_text,
    };
    const dueAt = current.due_at?.toISOString() ?? null;
    if (input.action === 'assign') {
      if (current.assignee_user_id === assignee) return did(false);
      await update.handle(trx, { ...kept, dueAt, assignee: input.assignee }, command);
      return did(true);
    }
    const wanted = input.dueAt === null ? null : Date.parse(input.dueAt);
    if ((current.due_at?.getTime() ?? null) === wanted) return did(false);
    let membership: string | null = null;
    if (current.assignee_user_id !== null) {
      const memberships = await options.assignees.memberships(trx, command.context, [
        current.assignee_user_id,
      ]);
      const found = memberships.get(current.assignee_user_id);
      // The command would refuse the assignee it is given back, as the task's form would.
      if (found === undefined) return skipped('assignee_unavailable');
      membership = found;
    }
    await update.handle(trx, { ...kept, dueAt: input.dueAt, assignee: membership }, command);
    return did(true);
  }

  return defineCommand({
    name: 'task.bulk',
    permission: 'tasks.manage',
    input: bulkTasksInput,
    audit: (input) => ({ action: input.action, ids: input.ids }),
    async handle(trx, input, command): Promise<BulkTasksResult> {
      const businessId = requireBusiness(command.context);
      // Whom an assign names is the same for every task: someone not on the team refuses
      // the whole request, in task.update's own words, before any task is touched.
      const assignee =
        input.action === 'assign'
          ? await options.assignees.resolve(trx, command.context, input.assignee)
          : null;

      const wanted = input.ids.map((publicId) => ({
        publicId,
        id: parsePublicId('task', publicId),
      }));
      const ids = wanted.flatMap((item) => (item.id === undefined ? [] : [item.id]));
      // Row-level security shows this business's tasks only: another's is not found.
      const seen = await trx
        .selectFrom('crm.tasks')
        .selectAll()
        .select(version)
        .where('business_id', '=', businessId)
        .where('id', 'in', ids)
        // In the order of their ids, so two requests over the same tasks never wait on
        // each other.
        .orderBy('id')
        .execute();
      const records = await recordsOf(trx, seen);

      const outcomes = new Map<string, Outcome>();
      for (const row of seen) {
        if (row.record_id !== null && records.get(row.record_id)?.trashed !== false) {
          // The single command refuses a task of a record in the trash; so it stays.
          outcomes.set(row.id, skipped('record_in_trash'));
          continue;
        }
        await sql`savepoint bulk_task`.execute(trx);
        try {
          // Read again here, so the revision is the one the command will check.
          const current = await requireTask(trx, toPublicId('task', row.id));
          outcomes.set(row.id, await apply(trx, command, input, current, assignee));
          await sql`release savepoint bulk_task`.execute(trx);
        } catch (error) {
          await sql`rollback to savepoint bulk_task`.execute(trx);
          await sql`release savepoint bulk_task`.execute(trx);
          const code = skipCodeOf(error);
          if (code === undefined) throw error;
          outcomes.set(row.id, skipped(code));
        }
      }

      const results = wanted.map((item): Result => {
        const outcome =
          (item.id === undefined ? undefined : outcomes.get(item.id)) ?? skipped('not_found');
        return { id: item.publicId, ...outcome };
      });
      const count = (outcome: Result['outcome']) =>
        results.filter((result) => result.outcome === outcome).length;
      return {
        action: input.action,
        results,
        done: count('done'),
        unchanged: count('unchanged'),
        skipped: count('skipped'),
      };
    },
  });
}
