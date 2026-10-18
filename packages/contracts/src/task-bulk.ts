// Bulk actions on tasks: one change applied to the tasks ticked in the list. GoHighLevel
// documents marking tasks as done and deleting them in bulk; reopening, assigning and
// changing the due date are this product's own single-task changes applied to each task. A
// delete here is for good, as deleting one task is.
//
// A request names at most TASK_BULK_LIMIT tasks, a whole page of the list, and is applied in
// one step: every task that can be changed is, by the command a single change uses, and one
// that cannot be is skipped with its reason and never stops the others. Sending the same
// request again changes nothing.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { updateTaskInput } from './tasks.js';

/** The most tasks one bulk request names. A larger selection is sent in several requests. */
export const TASK_BULK_LIMIT = 100;

export const taskBulkActions = ['complete', 'reopen', 'assign', 'set_due', 'delete'] as const;
export type TaskBulkActionKind = (typeof taskBulkActions)[number];

const ids = z
  .array(publicId('task'))
  .min(1, { error: 'Select at least one task.' })
  .max(TASK_BULK_LIMIT, {
    error: `Select at most ${String(TASK_BULK_LIMIT)} tasks at a time.`,
  })
  .refine((items) => new Set(items).size === items.length, {
    error: 'Name each task once.',
    params: { code: 'repeated' },
  });

export const bulkTasksInput = z
  .discriminatedUnion('action', [
    z.strictObject({ action: z.literal('complete'), ids }),
    z.strictObject({ action: z.literal('reopen'), ids }),
    z.strictObject({
      action: z.literal('assign'),
      ids,
      assignee: updateTaskInput.shape.assignee.meta({
        description: 'A member by the id listTaskAssignees gives, me, or null for nobody.',
      }),
    }),
    z.strictObject({
      action: z.literal('set_due'),
      ids,
      dueAt: updateTaskInput.shape.dueAt.meta({
        description: 'A time with its offset, or null for no due date.',
      }),
    }),
    z.strictObject({ action: z.literal('delete'), ids }),
  ])
  .meta({ id: 'BulkTasksInput' });
export type BulkTasksInput = z.output<typeof bulkTasksInput>;

/**
 * Why a task of a bulk request was left as it was. Each is a refusal of the single-task
 * command: `record_in_trash` when its contact, company or deal is in the trash; `changed`
 * when someone else changed it as the request ran; `assignee_unavailable` when a new due
 * date cannot be saved because the task's present assignee is no longer on the team.
 */
export const taskBulkSkipCodes = [
  'not_found',
  'record_in_trash',
  'changed',
  'assignee_unavailable',
] as const;
export type TaskBulkSkipCode = (typeof taskBulkSkipCodes)[number];

export const bulkTasksResult = z
  .looseObject({
    action: z.enum(taskBulkActions),
    results: z
      .array(
        z.looseObject({
          id: publicId('task'),
          outcome: z.enum(['done', 'unchanged', 'skipped']).meta({
            description:
              'done: it was changed. unchanged: it was already as asked, so nothing was written. skipped: it could not be, for the reason given.',
          }),
          reason: z
            .looseObject({
              code: z.enum(taskBulkSkipCodes),
              message: z.string().meta({ description: 'In plain words, for people.' }),
            })
            .nullable(),
        }),
      )
      .meta({ description: 'One entry for each task named, in the order named.' }),
    done: z.int().min(0),
    unchanged: z.int().min(0),
    skipped: z.int().min(0),
  })
  .meta({ id: 'BulkTasksResult' });
export type BulkTasksResult = z.output<typeof bulkTasksResult>;

export const bulkUpdateTasks = defineEndpoint({
  operationId: 'bulkUpdateTasks',
  method: 'post',
  path: '/tasks/bulk',
  summary: 'Complete, reopen, assign, set the due date of or delete many tasks at once',
  group: 'Tasks',
  body: bulkTasksInput,
  response: {
    status: 200,
    description:
      'What became of each task. All that can be changed are, in one step, each by the command a single change uses; one that is not found, belongs to a record in the trash or was changed meanwhile is skipped with its reason and never stops the others. Sending the same request again changes nothing.',
    schema: bulkTasksResult,
  },
});

export const taskBulkEndpoints = [bulkUpdateTasks] as const;
