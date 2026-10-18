import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

export const contactMemory = z
  .looseObject({
    summary: z
      .looseObject({
        text: z.string(),
        updatedAt: timestamp,
        throughEventId: publicId('event').nullable(),
      })
      .nullable(),
  })
  .meta({
    id: 'ContactMemory',
    description: 'The saved contact summary, or null when none exists.',
  });
export type ContactMemory = z.infer<typeof contactMemory>;

export const getContactMemory = defineEndpoint({
  operationId: 'getContactMemory',
  method: 'get',
  path: '/contacts/{id}/memory',
  summary: 'Read the saved contact summary',
  group: 'Contacts',
  params: z.strictObject({ id: publicId('contact') }),
  response: {
    status: 200,
    description: 'Saved memory. Reading never generates a summary or calls a model.',
    schema: contactMemory,
  },
});
