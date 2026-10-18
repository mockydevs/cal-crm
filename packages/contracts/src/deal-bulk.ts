// Bulk actions on deals: one change applied to the deals selected in the list or on the
// board, and the list of the bulk actions that were run. GoHighLevel documents four for
// opportunities: reassign the owner, move to a pipeline and stage, set the status, and
// delete; a delete here is a move to the trash, as deleting one deal is.
//
// A request names at most DEAL_BULK_LIMIT deals and is applied in one step: every deal that
// can be changed is, and one that is not found or is in the trash is skipped with its
// reason and never stops the others. Sending the same request again changes nothing.
import * as z from 'zod';

import { actor } from './activity.js';
import { assignContactOwnerInput } from './contact-people.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** The most deals one bulk request names. A larger selection is sent in several requests. */
export const DEAL_BULK_LIMIT = 100;
/** How many bulk actions a page of their list holds unless asked, and the most it holds. */
export const BULK_ACTION_PAGE_SIZE = 20;
export const MAX_BULK_ACTION_PAGE_SIZE = 100;

export const dealBulkActions = ['assign_owner', 'move', 'set_status', 'trash'] as const;
export type DealBulkActionKind = (typeof dealBulkActions)[number];

const ids = z
  .array(publicId('deal'))
  .min(1, { error: 'Select at least one deal.' })
  .max(DEAL_BULK_LIMIT, {
    error: `Select at most ${String(DEAL_BULK_LIMIT)} deals at a time.`,
  })
  .refine((items) => new Set(items).size === items.length, {
    error: 'Name each deal once.',
    params: { code: 'repeated' },
  });

export const bulkDealsInput = z
  .discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('assign_owner'),
      ids,
      owner: assignContactOwnerInput.shape.owner,
    }),
    z.strictObject({
      action: z.literal('move'),
      ids,
      pipelineId: publicId('pipeline'),
      stageId: publicId('stage').meta({ description: 'An active stage of that pipeline.' }),
    }),
    z
      .strictObject({
        action: z.literal('set_status'),
        ids,
        status: z.enum(['open', 'won', 'lost']),
        outcomeReason: z.string().trim().min(1).max(2000).nullable().default(null).meta({
          description:
            'Why the deals were won or lost, kept on each. Needed for lost; none for open.',
        }),
      })
      .superRefine((input, context) => {
        if (input.status === 'open' && input.outcomeReason !== null)
          context.addIssue({
            code: 'custom',
            path: ['outcomeReason'],
            message: 'A reason belongs to a won or lost deal.',
            params: { code: 'outcome_reason' },
          });
        if (input.status === 'lost' && input.outcomeReason === null)
          context.addIssue({
            code: 'custom',
            path: ['outcomeReason'],
            message: 'Explain why the deals were lost.',
            params: { code: 'required' },
          });
      }),
    z.strictObject({ action: z.literal('trash'), ids }),
  ])
  .meta({ id: 'BulkDealsInput' });
export type BulkDealsInput = z.output<typeof bulkDealsInput>;

/** Why a deal of a bulk request was left as it was. */
export const dealBulkSkipCodes = ['not_found', 'in_trash'] as const;
export type DealBulkSkipCode = (typeof dealBulkSkipCodes)[number];

const words = z.string().meta({ description: 'In plain words, for people.' });

export const bulkDealsResult = z
  .looseObject({
    action: z.enum(dealBulkActions),
    results: z
      .array(
        z.looseObject({
          id: publicId('deal'),
          outcome: z.enum(['done', 'unchanged', 'skipped']).meta({
            description:
              'done: it was changed. unchanged: it was already as asked, so nothing was written. skipped: it could not be, for the reason given.',
          }),
          reason: z.looseObject({ code: z.enum(dealBulkSkipCodes), message: words }).nullable(),
        }),
      )
      .meta({ description: 'One entry for each deal named, in the order named.' }),
    done: z.int().min(0),
    unchanged: z.int().min(0),
    skipped: z.int().min(0),
    bulkActionId: publicId('bulk_action').nullable().meta({
      description:
        'The entry this request made in the list of bulk actions. Null when it changed nothing: a request that changes nothing is not listed.',
    }),
  })
  .meta({ id: 'BulkDealsResult' });
export type BulkDealsResult = z.output<typeof bulkDealsResult>;

export const bulkUpdateDeals = defineEndpoint({
  operationId: 'bulkUpdateDeals',
  method: 'post',
  path: '/deals/bulk',
  summary: 'Reassign, move, set the status of or trash many deals at once',
  group: 'Deals',
  body: bulkDealsInput,
  response: {
    status: 200,
    description:
      'What became of each deal. All that can be changed are, in one step; one that is not found or is in the trash is skipped with its reason and never stops the others. Sending the same request again changes nothing and answers unchanged.',
    schema: bulkDealsResult,
  },
});

export const dealBulkAction = z
  .looseObject({
    id: publicId('bulk_action'),
    action: z.enum(dealBulkActions),
    requested: z.int().min(1).meta({ description: 'How many deals the request named.' }),
    done: z.int().min(0),
    unchanged: z.int().min(0),
    skipped: z.int().min(0),
    actor,
    createdAt: timestamp,
    completedAt: timestamp,
  })
  .meta({ id: 'DealBulkAction', description: 'One bulk action that changed at least one deal.' });
export type DealBulkAction = z.infer<typeof dealBulkAction>;

export const dealBulkActionsQuery = z
  .strictObject({
    after: publicId('bulk_action')
      .optional()
      .meta({ description: "Start after this entry: the previous page's next." }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_BULK_ACTION_PAGE_SIZE)
      .default(BULK_ACTION_PAGE_SIZE),
    action: z.enum(dealBulkActions).optional(),
  })
  .meta({ id: 'DealBulkActionsQuery' });

export const dealBulkActionList = z
  .looseObject({
    items: z.array(dealBulkAction).meta({ description: 'Newest first.' }),
    next: publicId('bulk_action').nullable().meta({
      description: 'Pass it as after to read the next page. Null on the last page.',
    }),
  })
  .meta({ id: 'DealBulkActionList' });
export type DealBulkActionList = z.infer<typeof dealBulkActionList>;

export const listDealBulkActions = defineEndpoint({
  operationId: 'listDealBulkActions',
  method: 'get',
  path: '/deals/bulk-actions',
  summary: 'List the bulk actions run on deals, newest first',
  group: 'Deals',
  query: dealBulkActionsQuery,
  response: {
    status: 200,
    description:
      'A page of the bulk actions that changed something: what was asked, by whom, when, and what became of the deals named.',
    schema: dealBulkActionList,
  },
});

export const dealBulkEndpoints = [bulkUpdateDeals, listDealBulkActions] as const;
