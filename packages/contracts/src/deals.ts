import { isAmount, isCurrencyCode } from '@repo/kernel';
import * as z from 'zod';
import { contactPerson } from './contact-people.js';
import { contactPhone } from './contact-phone.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';
import { fieldQueryShape, refineFieldQuery } from './field-query.js';

const date = z.iso.date().refine(
  (value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  },
  {
    error: 'Enter a calendar date.',
  },
);
/** The most characters a deal's source holds, as crm.deals.source does. */
export const DEAL_SOURCE_MAX_LENGTH = 200;
const values = z.strictObject({
  name: z.string().trim().min(1, { error: 'Give the deal a name.' }).max(200),
  pipelineId: publicId('pipeline'),
  stageId: publicId('stage'),
  amount: z
    .string()
    .refine((value) => isAmount(value) && !value.startsWith('-'), {
      error: 'Enter a nonnegative decimal amount with at most four decimal places.',
    })
    .nullable()
    .default(null),
  currency: z.string().refine(isCurrencyCode, { error: 'Enter a currency code, such as KES.' }),
  expectedCloseDate: date.nullable().default(null),
  status: z.enum(['open', 'won', 'lost']).default('open'),
  outcomeReason: z.string().trim().min(1).max(2000).nullable().default(null),
  source: z
    .string()
    .trim()
    .min(1, { error: 'Say where the deal came from, or leave it out.' })
    .max(DEAL_SOURCE_MAX_LENGTH, { error: 'Use at most 200 characters.' })
    .nullable()
    .optional()
    .meta({
      description:
        'Where the deal came from, in the words of whoever recorded it, such as a form or a referral. Left out of a new deal it is null; left out of an edit it stays as it is, so a screen that does not show it cannot erase it. Null clears it.',
      examples: ['Website form'],
    }),
  probability: z
    .int()
    .min(0)
    .max(100)
    .nullable()
    .optional()
    .meta({
      description:
        "The deal's own chance of being won, in percent, read where its pipeline says deals carry their own (dealProbability). Left out of a new deal it is null; left out of an edit it stays as it is. Null clears it.",
      examples: [60],
    }),
});
/** The most contacts a deal has beside its primary contact, as GoHighLevel's dialog says. */
export const MAX_DEAL_ADDITIONAL_CONTACTS = 10;

export const dealContact = z
  .looseObject({
    id: publicId('contact'),
    name: z
      .string()
      .nullable()
      .meta({ examples: ['Maya Thompson'] }),
    email: z.string().nullable().meta({ description: 'The primary email address.' }),
    phone: contactPhone.nullable().meta({ description: 'The primary phone number.' }),
    trashed: z.boolean().meta({
      description:
        'Whether the contact is in the trash. It stays linked until it is purged or someone unlinks it.',
    }),
  })
  .meta({ id: 'DealContact', description: 'A contact a deal is with.' });
export type DealContact = z.infer<typeof dealContact>;

export const additionalContactIds = z.array(publicId('contact')).max(MAX_DEAL_ADDITIONAL_CONTACTS, {
  error: `Name at most ${String(MAX_DEAL_ADDITIONAL_CONTACTS)} additional contacts.`,
});

/** A contact is with a deal once: as its primary contact or as an additional one. */
export function refineDealContacts(
  input: {
    readonly primaryContactId?: string | null | undefined;
    readonly additionalContactIds?: readonly string[] | undefined;
  },
  context: z.RefinementCtx,
): void {
  const additional = input.additionalContactIds ?? [];
  for (const [index, id] of additional.entries())
    if (id === input.primaryContactId || additional.indexOf(id) !== index)
      context.addIssue({
        code: 'custom',
        path: ['additionalContactIds', index],
        message: 'Name each contact once.',
        params: { code: 'repeated_contact' },
      });
}

/** What a new deal may say about its contacts, linked in the transaction that makes it. */
const contactsOnCreate = {
  primaryContactId: publicId('contact').optional().meta({
    description:
      "The deal's primary contact. Left out, the deal has none yet. This is how a deal is added from a contact.",
  }),
  additionalContactIds: additionalContactIds.optional().meta({
    description: 'Other contacts the deal is with.',
  }),
};

function validateOutcome(
  input: { status: string; outcomeReason: string | null },
  context: z.RefinementCtx,
): void {
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
      message: 'Explain why the deal was lost.',
      params: { code: 'required' },
    });
}
export const createDealInput = values
  .extend(contactsOnCreate)
  .superRefine((input, context) => {
    validateOutcome(input, context);
    refineDealContacts(input, context);
  })
  .meta({ id: 'CreateDealInput' });
export const updateDealInput = values
  .extend({ revision: z.string().regex(/^[0-9a-f]{64}$/) })
  .superRefine(validateOutcome)
  .meta({ id: 'UpdateDealInput' });
export const dealIdInput = z.object({ id: publicId('deal') });
export const updateDealCommandInput = values
  .extend({ ...dealIdInput.shape, revision: z.string().regex(/^[0-9a-f]{64}$/) })
  .superRefine(validateOutcome);
export const deal = values
  .extend({
    id: publicId('deal'),
    pipelineName: z.string(),
    stageName: z.string(),
    closedAt: timestamp.nullable(),
    stageEnteredAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    trashedAt: timestamp.nullable(),
    revision: z.string().regex(/^[0-9a-f]{64}$/),
    canManage: z.boolean(),
    primaryContact: dealContact.nullable().optional().meta({
      description:
        "Present when include names contact: the deal's primary contact, or null when it has none.",
    }),
    owner: contactPerson.nullable().optional().meta({
      description: "Present when include names owner: the deal's owner, or null when it has none.",
    }),
    tags: z
      .array(z.looseObject({ id: publicId('tag'), name: z.string() }))
      .optional()
      .meta({ description: "Present when include names tags: the deal's tags, by name." }),
  })
  .meta({ id: 'Deal' });
export type Deal = z.output<typeof deal>;
export type CreateDealInput = z.input<typeof createDealInput>;
export type UpdateDealInput = z.input<typeof updateDealInput>;
/**
 * The orders of the deal list: by when a deal was made, when it was last changed, its name,
 * or its value. Each runs both ways. Deals without a value come last whichever way the list
 * runs.
 */
export const dealSorts = ['created', 'updated', 'name', 'value'] as const;
export type DealSort = (typeof dealSorts)[number];
export const sortDirections = ['asc', 'desc'] as const;
export type SortDirection = (typeof sortDirections)[number];

/** The way a list runs when the request names none: names from A, everything else newest or largest first. */
export const dealSortDirection = (sort: DealSort, direction?: SortDirection): SortDirection =>
  direction ?? (sort === 'name' ? 'asc' : 'desc');

const dealSearch = z
  .string()
  .trim()
  .max(200, { error: 'Use at most 200 characters.' })
  .optional()
  .meta({
    description:
      "Finds deals by name (the start of its words, or any part of three characters or more), and by a contact the deal is with: the contact's name, email address or phone number digits.",
    examples: ['fence'],
  });

/** One order applies to a list: a built-in one, or a custom field. */
function refineDealSort(
  query: { readonly sort?: string | undefined; readonly sortField?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (query.sort !== undefined && query.sort !== 'created' && query.sortField !== undefined)
    context.addIssue({
      code: 'custom',
      path: ['sortField'],
      message: 'Sort by a built-in order or by a field, not both.',
    });
}

/** What a row of the deal list, or a card of the board, can show beside the deal itself. */
export const dealListExtras = ['contact', 'owner', 'tags'] as const;
export type DealListExtra = (typeof dealListExtras)[number];

/** The extras a request names, each once, in the contract's order. */
export function dealListExtrasOf(include: string | undefined): DealListExtra[] {
  const named = new Set((include ?? '').split(','));
  return dealListExtras.filter((extra) => named.has(extra));
}

export const dealListQuery = z
  .object({
    pipelineId: publicId('pipeline').optional(),
    stageId: publicId('stage').optional().meta({
      description:
        "Only the deals in this stage: one column of the board, paged by itself. The stage's count and total come from getDealStageSummary with the same filters.",
    }),
    status: z.enum(['open', 'won', 'lost', 'all']).default('open'),
    q: dealSearch,
    sort: z.enum(dealSorts).optional().meta({
      description:
        'The order of the list: created (the one a request without it gets), updated, name or value. Deals that tie are in the order of their ids.',
    }),
    direction: z.enum(sortDirections).optional().meta({
      description: 'Left out: names from A, and newest or largest first for the others.',
    }),
    after: publicId('deal').optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    include: z
      .string()
      .regex(new RegExp(`^(${dealListExtras.join('|')})(,(${dealListExtras.join('|')}))*$`), {
        error: `Name any of ${dealListExtras.join(', ')}, separated by commas.`,
      })
      .optional()
      .meta({
        description:
          'More about each deal, by name and separated by commas: contact (its primary contact), owner, tags. Left out, a deal has none of them.',
        examples: ['contact,owner'],
      }),
    ...fieldQueryShape,
  })
  .superRefine((query, context) => {
    refineFieldQuery(query, context);
    refineDealSort(query, context);
  });

/** The board's filters: what the cards are narrowed by, without an order or a place. */
export const dealStageSummaryQuery = z
  .strictObject({
    pipelineId: publicId('pipeline'),
    status: z.enum(['open', 'won', 'lost', 'all']).default('open'),
    q: dealSearch,
    fieldId: fieldQueryShape.fieldId,
    fieldOperator: fieldQueryShape.fieldOperator,
    fieldValue: fieldQueryShape.fieldValue,
  })
  .superRefine(refineFieldQuery)
  .meta({ id: 'DealStageSummaryQuery' });

const moneyTotal = z.looseObject({
  currency: z.string().meta({ examples: ['KES'] }),
  amount: z.string().meta({
    description: 'The sum as a decimal, exact to four places. Deals without an amount add nothing.',
    examples: ['125000.0000'],
  }),
});
const totals = z.array(moneyTotal).meta({
  description:
    'One sum for each currency the deals are in, by currency code. Amounts in different currencies are never added together.',
});
export const dealStageSummary = z
  .looseObject({
    pipelineId: publicId('pipeline'),
    count: z.int().min(0).meta({ description: 'Deals in every stage together.' }),
    totals,
    stages: z
      .array(
        z.looseObject({
          stageId: publicId('stage'),
          name: z.string(),
          archived: z.boolean(),
          count: z.int().min(0),
          totals,
        }),
      )
      .meta({
        description:
          "In the pipeline's order. Every active stage is listed, with zero when it is empty; an archived stage only while a deal the filters keep is still in it.",
      }),
  })
  .meta({
    id: 'DealStageSummary',
    description:
      "What the board's column headers show: how many deals each stage holds and what they add up to, over deals not in the trash that the filters keep.",
  });
export type DealStageSummary = z.output<typeof dealStageSummary>;
export const dealList = z
  .object({ items: z.array(deal), next: publicId('deal').nullable(), canManage: z.boolean() })
  .meta({ id: 'DealList' });
export const createDeal = defineEndpoint({
  operationId: 'createDeal',
  method: 'post',
  path: '/deals',
  summary: 'Create a deal with its initial stage history.',
  group: 'Deals',
  body: createDealInput,
  response: { status: 201, description: 'The created deal.', schema: deal },
});
export const updateDeal = defineEndpoint({
  operationId: 'updateDeal',
  method: 'put',
  path: '/deals/{id}',
  summary: 'Edit a deal, change its stage or record its outcome.',
  group: 'Deals',
  params: dealIdInput,
  body: updateDealInput,
  response: { status: 200, description: 'The updated deal.', schema: deal },
});
export const getDeal = defineEndpoint({
  operationId: 'getDeal',
  method: 'get',
  path: '/deals/{id}',
  summary: 'Read a deal.',
  group: 'Deals',
  params: dealIdInput,
  response: { status: 200, description: 'The deal.', schema: deal },
});
export const getDeals = defineEndpoint({
  operationId: 'getDeals',
  method: 'get',
  path: '/deals',
  summary: 'Page deals in stable newest-first order.',
  group: 'Deals',
  query: dealListQuery,
  response: { status: 200, description: 'A page of deals.', schema: dealList },
});
export const getDealStageSummary = defineEndpoint({
  operationId: 'getDealStageSummary',
  method: 'get',
  path: '/deals/stage-summary',
  summary: "Count and total a pipeline's deals by stage, with the board's filters.",
  group: 'Deals',
  query: dealStageSummaryQuery,
  response: {
    status: 200,
    description:
      'Each stage with its number of deals and their totals by currency. Paging getDeals with the same filters and a stageId reads exactly the deals counted for that stage.',
    schema: dealStageSummary,
  },
});
