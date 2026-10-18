import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { publicId, recordId } from './ids.js';
import { timestamp } from './timestamps.js';
import { actor } from './activity.js';
import {
  recurrenceDueTooOld,
  taskFrequencies,
  taskRecurrenceEnd,
  taskRecurrenceInput,
} from './tasks-recurrence.js';

const revision = z.string().regex(/^[0-9a-f]{64}$/);
const dueAt = z.iso
  .datetime({ offset: true })
  .refine((value) => !value.startsWith('0000-'))
  .nullable();
/** The message a recurring due time too far back is refused with, here and on the server. */
export const DUE_TOO_OLD =
  'A recurring task can start at most one repeat in the past. Choose a later due date.';

// A recurring task's first due time may be at most one step of its rule in the past: a
// series is never made to catch up on what came due long ago.
function recentEnoughToRepeat<Context>(
  value: {
    readonly dueAt?: string | null | undefined;
    readonly recurrence?: z.output<typeof taskRecurrenceInput> | null | undefined;
  },
  context: z.RefinementCtx<Context>,
): void {
  if (
    value.recurrence !== undefined &&
    value.recurrence !== null &&
    typeof value.dueAt === 'string' &&
    recurrenceDueTooOld(value.dueAt, value.recurrence, Date.now())
  )
    context.addIssue({
      code: 'custom',
      path: ['dueAt'],
      message: DUE_TOO_OLD,
      params: { code: 'due_too_old' },
    });
}

const taskFields = z.strictObject({
  recordId: recordId.nullable().default(null),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10000).default(''),
  dueAt: dueAt.default(null),
  assignee: z
    .union([z.literal('me'), publicId('membership')])
    .nullable()
    .default(null),
  recurrence: taskRecurrenceInput.optional().meta({
    description:
      'Make it a recurring task: this task is the first, each next one is made at its scheduled time, at most one repeat before it is due. Needs a due date no more than one repeat in the past.',
  }),
});
export const createTaskInput = taskFields
  .superRefine(recentEnoughToRepeat)
  .meta({ id: 'CreateTaskInput' });

/** Whether an edit or a deletion is of this task alone or of the series it belongs to. */
export const taskApplyTo = z.enum(['this', 'series']).optional().meta({
  description:
    "this (left out): this task alone. series: this task and the series' later tasks, and the tasks it makes from now on. Only for a task of a recurring series.",
});
export const updateTaskInput = taskFields
  .omit({ recordId: true })
  .extend({
    description: taskFields.shape.description.unwrap(),
    dueAt: taskFields.shape.dueAt.unwrap(),
    assignee: taskFields.shape.assignee.unwrap(),
    revision,
    applyTo: taskApplyTo,
    recurrence: taskRecurrenceInput.nullable().optional().meta({
      description:
        "Left out: the rule stays as it is. For a task that is not recurring, makes it the first task of a new series. With applyTo series, a new rule that runs on from this task's due date, or null to stop the series (its tasks stay).",
    }),
  })
  .superRefine(recentEnoughToRepeat)
  .meta({ id: 'UpdateTaskInput' });
export const completeTaskInput = z
  .strictObject({ completed: z.boolean(), revision })
  .meta({ id: 'CompleteTaskInput' });
export const deleteTaskInput = z
  .strictObject({ revision, applyTo: taskApplyTo })
  .meta({ id: 'DeleteTaskInput' });

/** How a task of a recurring series repeats, and when its series next makes one. */
export const taskRecurrence = z
  .looseObject({
    frequency: z.enum(taskFrequencies),
    every: z.int().min(1),
    ends: taskRecurrenceEnd,
    createIfOverdue: z.boolean(),
    occurrence: z.int().min(0).meta({ description: 'Which task of the series this is, from 0.' }),
    active: z.boolean().meta({ description: 'Whether the series still makes tasks.' }),
    nextDueAt: timestamp.nullable().meta({
      description: 'When the next task the series will make is due; null once it has ended.',
    }),
  })
  .meta({ id: 'TaskRecurrence' });
export type TaskRecurrence = z.output<typeof taskRecurrence>;
export const task = z
  .looseObject({
    id: publicId('task'),
    record: z.looseObject({ id: recordId, name: z.string(), trashed: z.boolean() }).nullable(),
    title: z.string(),
    description: z.string(),
    dueAt: timestamp.nullable(),
    assignee: z
      .looseObject({
        membershipId: publicId('membership').nullable(),
        name: z.string().nullable(),
        you: z.boolean(),
      })
      .nullable(),
    completedAt: timestamp.nullable(),
    completedBy: actor.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    revision,
    recurrence: taskRecurrence.optional().meta({
      description: 'Only on a task of a recurring series: how it repeats.',
    }),
  })
  .meta({ id: 'Task' });
export type Task = z.output<typeof task>;
export const taskList = z
  .looseObject({
    canManage: z.boolean(),
    items: z.array(task),
    nextCursor: publicId('task').nullable(),
    total: z.int().min(0).optional().meta({
      description: 'How many tasks match the filters, on every page. This server always sends it.',
    }),
  })
  .meta({ id: 'TaskList' });
export type TaskList = z.output<typeof taskList>;
const taskParams = z.object({ id: publicId('task') });

/** A page of tasks when the request names no size, and the most a request may ask for. */
export const TASK_PAGE_SIZE = 50;
export const MAX_TASK_PAGE_SIZE = 100;

/**
 * The orders of the task list: when a task was made (the one a request without it gets,
 * newest first), when it is due (soonest first), or its title (from A). Each runs both
 * ways. Tasks without a due date come last whichever way the due order runs.
 */
export const taskSorts = ['created', 'due', 'title'] as const;
export type TaskSort = (typeof taskSorts)[number];

/** The way a list runs when the request names none. */
export const taskSortDirection = (sort: TaskSort, direction?: 'asc' | 'desc'): 'asc' | 'desc' =>
  direction ?? (sort === 'created' ? 'desc' : 'asc');

const dueBound = z.iso.datetime({ offset: true }).refine((value) => !value.startsWith('0000-'));
export const listTasks = defineEndpoint({
  operationId: 'listTasks',
  method: 'get',
  path: '/tasks',
  summary: 'Read record or workspace tasks',
  group: 'Tasks',
  query: z
    .strictObject({
      recordId: recordId.optional(),
      scope: z.enum(['all', 'mine', 'unassigned']).default('all'),
      status: z.enum(['open', 'completed', 'all']).default('open'),
      due: z.enum(['any', 'overdue', 'today', 'upcoming']).default('any').meta({
        description:
          "overdue: due before now. today: due on the business's current calendar day, in the business's time zone, whether or not that time has passed. upcoming: due after the end of that day. A task without a due date is in none of the three.",
      }),
      dueFrom: dueBound.optional().meta({
        description: 'Only tasks due at or after this time. A time with its offset.',
      }),
      dueBefore: dueBound.optional().meta({
        description: 'Only tasks due before this time. A time with its offset, after dueFrom.',
      }),
      assignee: publicId('membership').optional().meta({
        description:
          "Only the tasks assigned to this member, by the id listTaskAssignees gives. With scope left out or all: scope's mine and unassigned name whose tasks by themselves.",
      }),
      q: z
        .string()
        .trim()
        .max(200, { error: 'Use at most 200 characters.' })
        .optional()
        .meta({ description: 'Finds tasks by any part of their title, in either case.' }),
      sort: z.enum(taskSorts).optional().meta({
        description:
          'The order of the list: created (the one a request without it gets), due or title. Tasks that tie are in the order of their ids. By due, tasks without a due date come last.',
      }),
      direction: z.enum(['asc', 'desc']).optional().meta({
        description: 'Left out: newest first by created, soonest first by due, from A by title.',
      }),
      limit: z.coerce
        .number()
        .int()
        .min(1, { error: 'Ask for at least 1 task.' })
        .max(MAX_TASK_PAGE_SIZE, { error: `Ask for at most ${String(MAX_TASK_PAGE_SIZE)} tasks.` })
        .optional()
        .meta({ description: `How many tasks a page holds. Left out, ${String(TASK_PAGE_SIZE)}.` }),
      after: publicId('task').optional().meta({
        description:
          "Start after this task: the previous page's nextCursor, with the same sort and direction.",
      }),
    })
    .superRefine((query, context) => {
      if (query.assignee !== undefined && query.scope !== 'all')
        context.addIssue({
          code: 'custom',
          path: ['assignee'],
          message: 'Name one member, or use scope: not both.',
          params: { code: 'assignee_with_scope' },
        });
      if (
        query.dueFrom !== undefined &&
        query.dueBefore !== undefined &&
        Date.parse(query.dueBefore) <= Date.parse(query.dueFrom)
      )
        context.addIssue({
          code: 'custom',
          path: ['dueBefore'],
          message: 'End the range after it starts.',
          params: { code: 'empty_due_range' },
        });
    }),
  response: {
    status: 200,
    description:
      'A page of tasks and how many match, newest first unless sort says otherwise, with optional record, assignment, due, title and status filters.',
    schema: taskList,
  },
});
export const createTask = defineEndpoint({
  operationId: 'createTask',
  method: 'post',
  path: '/tasks',
  summary: 'Create a task',
  group: 'Tasks',
  body: createTaskInput,
  response: { status: 201, description: 'The saved task with its current revision.', schema: task },
});
export const updateTask = defineEndpoint({
  operationId: 'updateTask',
  method: 'put',
  path: '/tasks/{id}',
  summary: 'Edit a task without overwriting another edit',
  group: 'Tasks',
  params: taskParams,
  body: updateTaskInput,
  response: { status: 200, description: 'The saved task.', schema: task },
});
export const completeTask = defineEndpoint({
  operationId: 'completeTask',
  method: 'post',
  path: '/tasks/{id}/completion',
  summary: 'Complete or reopen a task',
  group: 'Tasks',
  params: taskParams,
  body: completeTaskInput,
  response: {
    status: 200,
    description: 'The task with trusted completion provenance.',
    schema: task,
  },
});
export const deleteTask = defineEndpoint({
  operationId: 'deleteTask',
  method: 'delete',
  path: '/tasks/{id}',
  summary: 'Delete a task after checking its revision',
  group: 'Tasks',
  params: taskParams,
  body: deleteTaskInput,
  response: { status: 204, description: 'The task was deleted and the action recorded.' },
});
export const taskAssigneeList = z
  .looseObject({
    items: z.array(
      z.looseObject({ id: publicId('membership'), name: z.string().nullable(), you: z.boolean() }),
    ),
    nextCursor: publicId('membership').nullable(),
  })
  .meta({ id: 'TaskAssigneeList' });
export type TaskAssigneeList = z.output<typeof taskAssigneeList>;
export const listTaskAssignees = defineEndpoint({
  operationId: 'listTaskAssignees',
  method: 'get',
  path: '/tasks/assignees',
  summary: 'Read people eligible for task assignment',
  group: 'Tasks',
  query: z.strictObject({ after: publicId('membership').optional() }),
  response: {
    status: 200,
    description: 'Business and agency members, one entry per person.',
    schema: taskAssigneeList,
  },
});
