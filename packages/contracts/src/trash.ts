// The trash: contacts, companies and deals moved there, until they're restored or purged
// after the business's retention days.
import * as z from 'zod';

import { deal, dealIdInput } from './deals.js';
import { defineEndpoint } from './endpoints.js';
import { recordId, recordKinds } from './ids.js';
import { timestamp } from './timestamps.js';

/** How many records a page of the trash holds. */
export const TRASH_PAGE_SIZE = 50;

export const listTrashQuery = z
  .strictObject({
    kind: z.enum(recordKinds).optional().meta({ description: 'Only records of this kind.' }),
    after: recordId
      .optional()
      .meta({ description: "Start after this record: the previous page's next." }),
  })
  .meta({ id: 'ListTrashQuery' });

export const trashedRecord = z
  .looseObject({
    id: recordId,
    kind: z.enum(recordKinds),
    name: z.string().nullable().meta({
      description:
        "A contact's name or else its primary email address or phone; a company's or deal's name.",
    }),
    trashedAt: timestamp,
    purgeAt: timestamp.meta({ description: 'When it will be purged, unless restored first.' }),
  })
  .meta({ id: 'TrashedRecord' });

export type TrashedRecord = z.infer<typeof trashedRecord>;

export const trashList = z
  .looseObject({
    items: z.array(trashedRecord).meta({ description: 'Most recently trashed first.' }),
    next: recordId
      .nullable()
      .meta({ description: 'Pass it as after to read the next page. Null on the last page.' }),
    retentionDays: z.int().meta({ description: 'Days a record stays in the trash.' }),
    canPurge: z.boolean().meta({ description: 'Whether you may purge records yourself.' }),
  })
  .meta({ id: 'TrashList' });

export type TrashList = z.infer<typeof trashList>;

/** Which record: as a path parameter, and as the purge command's input. */
export const trashedRecordIdInput = z.object({ id: recordId });

const group = 'Trash';

export const listTrash = defineEndpoint({
  operationId: 'listTrash',
  method: 'get',
  path: '/trash',
  summary: 'List the contacts, companies and deals in the trash',
  group,
  query: listTrashQuery,
  response: {
    status: 200,
    description: `A page of the trash, ${String(TRASH_PAGE_SIZE)} at most.`,
    schema: trashList,
  },
});

export const purgeRecord = defineEndpoint({
  operationId: 'purgeRecord',
  method: 'delete',
  path: '/trash/{id}',
  summary: 'Purge a record in the trash, with everything attached to it',
  group,
  params: trashedRecordIdInput,
  response: { status: 204, description: 'Purged: it and everything attached are gone.' },
});

export const trashDeal = defineEndpoint({
  operationId: 'trashDeal',
  method: 'delete',
  path: '/deals/{id}',
  summary: 'Move a deal to the trash',
  group: 'Deals',
  params: dealIdInput,
  response: { status: 200, description: 'The deal, in the trash.', schema: deal },
});

export const restoreDeal = defineEndpoint({
  operationId: 'restoreDeal',
  method: 'post',
  path: '/deals/{id}/restore',
  summary: 'Restore a deal from the trash',
  group: 'Deals',
  params: dealIdInput,
  response: { status: 200, description: 'The restored deal.', schema: deal },
});
