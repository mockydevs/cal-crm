// Searching for a record to go to: the command bar's contacts, companies and deals, a few
// of each kind.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { recordId, recordKinds } from './ids.js';

/** How many records of each kind a search gives at most. */
export const SEARCH_LIMIT = 5;

export const searchRecordsQuery = z
  .strictObject({
    q: z
      .string()
      .trim()
      .min(1, { error: 'Type what to search for.' })
      .max(200, { error: 'Use at most 200 characters.' })
      .meta({
        description:
          'Finds contacts by name, email address or phone number digits, and companies and deals by name. Companies also by domain.',
        examples: ['lee'],
      }),
  })
  .meta({ id: 'SearchRecordsQuery' });

export const foundRecord = z
  .looseObject({
    id: recordId,
    kind: z.enum(recordKinds),
    name: z.string().nullable().meta({
      description:
        "A contact's name or else its primary email address or phone; a company's or deal's name.",
    }),
    detail: z.string().nullable().meta({
      description:
        "What tells it apart: a named contact's primary email address or phone, a company's domain, a deal's pipeline and stage.",
    }),
  })
  .meta({ id: 'FoundRecord' });

export type FoundRecord = z.infer<typeof foundRecord>;

export const searchResults = z
  .looseObject({
    items: z.array(foundRecord).meta({
      description: `Contacts, then companies, then deals, at most ${String(SEARCH_LIMIT)} of each: names starting with the search first, then by name.`,
    }),
  })
  .meta({ id: 'SearchResults' });

export type SearchResults = z.infer<typeof searchResults>;

export const searchRecords = defineEndpoint({
  operationId: 'searchRecords',
  method: 'get',
  path: '/search',
  summary: 'Search contacts, companies and deals',
  group: 'Search',
  query: searchRecordsQuery,
  response: {
    status: 200,
    description: 'The records the search finds, outside the trash.',
    schema: searchResults,
  },
});
