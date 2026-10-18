// Conversations → Manual Actions: the calls to place and texts to send by hand that an
// automation's manual.call and manual.sms steps leave for a person. A run waits at the step
// until its action is completed or skipped, and then goes on.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

export const MANUAL_ACTION_LIMITS = {
  /** The most actions a page of the queue holds. */
  page: 100,
  /** Characters in what an action says to send or to say. */
  body: 2000,
} as const;

export const manualActionTypes = ['call', 'sms'] as const;
export type ManualActionType = (typeof manualActionTypes)[number];

/** cancelled: the run ended some other way before anyone did the action. */
export const manualActionStatuses = ['pending', 'completed', 'skipped', 'cancelled'] as const;
export type ManualActionStatus = (typeof manualActionStatuses)[number];

const revision = z.string().regex(/^[a-f0-9]{64}$/);

const person = z
  .looseObject({
    membershipId: publicId('membership').nullable(),
    name: z.string().nullable(),
    you: z.boolean(),
  })
  .nullable();

export const manualAction = z
  .looseObject({
    id: publicId('manual_action'),
    type: z.enum(manualActionTypes),
    status: z.enum(manualActionStatuses),
    body: z.string().meta({
      description:
        'The text to send, or notes for the call, already filled in for the contact. May be empty for a call.',
    }),
    contact: z.looseObject({
      id: publicId('contact'),
      name: z.string(),
      phone: z.string().nullable().meta({ description: "The contact's main number, in E.164." }),
      trashed: z.boolean(),
    }),
    automation: z.looseObject({ id: publicId('automation'), name: z.string() }),
    runId: publicId('automation_enrolment'),
    assignee: person.meta({ description: 'Null when nobody is assigned.' }),
    createdAt: timestamp,
    closedAt: timestamp.nullable(),
    closedBy: person.meta({
      description: 'Who completed or skipped it. Null while pending, and when the run ended it.',
    }),
    revision,
  })
  .meta({ id: 'ManualAction' });
export type ManualAction = z.output<typeof manualAction>;

export const listManualActionsQuery = z
  .strictObject({
    status: z.enum([...manualActionStatuses, 'all']).default('pending'),
    type: z.enum(manualActionTypes).optional(),
    automationId: publicId('automation').optional(),
    assignee: z
      .union([z.enum(['anyone', 'me', 'unassigned']), publicId('membership')])
      .default('anyone'),
    limit: z.coerce.number().int().min(1).max(MANUAL_ACTION_LIMITS.page).default(20),
    after: z
      .string()
      .max(600)
      .optional()
      .meta({ description: 'Start after the previous page: its next, exactly as it was given.' }),
  })
  .meta({ id: 'ListManualActionsQuery' });
export type ListManualActionsQuery = z.output<typeof listManualActionsQuery>;

export const manualActionList = z
  .looseObject({
    items: z.array(manualAction),
    total: z.int().meta({ description: 'How many actions match the filters, on every page.' }),
    next: z
      .string()
      .nullable()
      .meta({ description: 'Pass it as after to read the next page. Null on the last page.' }),
    canWork: z.boolean().meta({
      description: 'Whether the reader may complete, skip and take actions.',
    }),
    canAssign: z.boolean().meta({
      description: 'Whether the reader may give an action to someone else.',
    }),
  })
  .meta({ id: 'ManualActionList' });
export type ManualActionList = z.output<typeof manualActionList>;

export const assignManualActionInput = z
  .strictObject({
    assignee: z.union([z.literal('me'), publicId('membership')]).nullable(),
    revision,
  })
  .meta({ id: 'AssignManualActionInput' });
export const closeManualActionInput = z
  .strictObject({ revision })
  .meta({ id: 'CloseManualActionInput' });

const group = 'Manual actions';
const actionParams = z.strictObject({ actionId: publicId('manual_action') });

export const listManualActions = defineEndpoint({
  operationId: 'listManualActions',
  method: 'get',
  path: '/manual-actions',
  group,
  summary: 'Read the manual actions queue, oldest first',
  query: listManualActionsQuery,
  response: {
    status: 200,
    description: 'A page of actions, and how many match.',
    schema: manualActionList,
  },
});
export const getManualAction = defineEndpoint({
  operationId: 'getManualAction',
  method: 'get',
  path: '/manual-actions/{actionId}',
  group,
  summary: 'Read one manual action',
  params: actionParams,
  response: { status: 200, description: 'The action and its revision.', schema: manualAction },
});
export const assignManualAction = defineEndpoint({
  operationId: 'assignManualAction',
  method: 'put',
  path: '/manual-actions/{actionId}/assignee',
  group,
  summary: 'Assign a pending manual action, or leave it for anyone',
  params: actionParams,
  body: assignManualActionInput,
  response: { status: 200, description: 'The action.', schema: manualAction },
});
export const completeManualAction = defineEndpoint({
  operationId: 'completeManualAction',
  method: 'post',
  path: '/manual-actions/{actionId}/complete',
  group,
  summary: 'Say a manual action was done, and let its run go on',
  params: actionParams,
  body: closeManualActionInput,
  response: {
    status: 200,
    description: 'The completed action. Nothing is sent or dialled by this call.',
    schema: manualAction,
  },
});
export const skipManualAction = defineEndpoint({
  operationId: 'skipManualAction',
  method: 'post',
  path: '/manual-actions/{actionId}/skip',
  group,
  summary: 'Skip a manual action, and let its run go on',
  params: actionParams,
  body: closeManualActionInput,
  response: { status: 200, description: 'The skipped action.', schema: manualAction },
});

/** Every manual action endpoint, for the API's list of operations. */
export const manualActionEndpoints = [
  listManualActions,
  getManualAction,
  assignManualAction,
  completeManualAction,
  skipManualAction,
] as const;
