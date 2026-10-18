// Conversations → Trigger Links: a named web address a message carries as
// {{trigger_link.<key>}}. Sent to a contact, the field becomes an address of this install
// that holds one random token; opening it records the click against that contact, starts
// the automations that wait for it, and sends the browser on to the stored address. The
// limits match messaging.trigger_links.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

export const TRIGGER_LINK_LIMITS = {
  /** Trigger links one business may have. */
  links: 1000,
  /** Characters in a link's destination. */
  url: 2000,
  /** The most rows a page of either list holds. */
  page: 100,
} as const;

/** The public path a token is opened at: `<PUBLIC_URL>/l/<token>`. */
export const TRIGGER_LINK_PATH = '/l';

/** A 256-bit URL capability; contains no recipient, link or tenant identifier. */
export const triggerLinkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const MERGE_PREFIX = 'trigger_link.';

/** A link's merge key: what a message writes inside {{ }}. */
export function triggerLinkMergeKey(key: string): string {
  return `${MERGE_PREFIX}${key}`;
}

/** The link keys among a text's merge fields, each once: trigger_link.offer gives offer. */
export function triggerLinkKeys(mergeFields: readonly string[]): string[] {
  return [
    ...new Set(
      mergeFields
        .filter((field) => field.startsWith(MERGE_PREFIX))
        .map((field) => field.slice(MERGE_PREFIX.length)),
    ),
  ];
}

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, {
  error: 'Use a lowercase letter, then lowercase letters, numbers or underscores.',
});
const name = z
  .string()
  .trim()
  .min(1, { error: 'Give the link a name.' })
  .max(120, { error: 'Use at most 120 characters.' });

// A scheme, a host with no user name before it, then anything without spaces. The host
// stops at the first slash, question mark or hash, so nothing can sit in front of it.
const WEB_ADDRESS = /^https?:\/\/[^\s\p{Cc}/?#@\\]+(?:[/?#][^\s\p{Cc}]*)?$/u;
const parsedAddress = z.url({ protocol: /^https?$/ });

function isWebAddress(value: string): boolean {
  return WEB_ADDRESS.test(value) && !value.includes('{{') && parsedAddress.safeParse(value).success;
}

// The one place a click is sent: a plain web address, written out in full. No merge field,
// no sign-in details, no other scheme.
const url = z
  .string()
  .trim()
  .min(1, { error: 'Give the address the link opens.' })
  .max(TRIGGER_LINK_LIMITS.url, { error: 'Use at most 2,000 characters.' })
  .refine(isWebAddress, {
    error:
      'Use a full web address starting with https:// or http://, without spaces, merge fields or a user name.',
  });

export const createTriggerLinkInput = z
  .strictObject({
    name,
    url,
    key: key.optional().meta({
      description:
        'Left out, the key is made from the name (Spring Offer becomes spring_offer), with a number added if that key is taken. It never changes afterwards.',
    }),
  })
  .meta({ id: 'CreateTriggerLinkInput' });
export const updateTriggerLinkInput = z.strictObject({ name, url, revision }).meta({
  id: 'UpdateTriggerLinkInput',
  description:
    'The whole link, with the revision it was read at. The key is not part of it. Addresses already sent follow the new destination. A stale revision returns 409 and changes nothing.',
});

export const triggerLink = z
  .looseObject({
    id: publicId('trigger_link'),
    name: z.string(),
    url: z.string(),
    key,
    mergeKey: z.string().meta({
      description: 'The path that puts the link into a message, written inside {{ }}.',
      examples: ['trigger_link.spring_offer'],
    }),
    clicks: z.int().meta({ description: 'Clicks recorded, by anyone, in all.' }),
    contacts: z.int().meta({ description: 'How many different contacts clicked.' }),
    lastClickedAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    revision,
  })
  .meta({ id: 'TriggerLink' });
export type TriggerLink = z.output<typeof triggerLink>;

const after = z
  .string()
  .max(600)
  .optional()
  .meta({ description: 'Start after the previous page: its next, exactly as it was given.' });
const next = z
  .string()
  .nullable()
  .meta({ description: 'Pass it as after to read the next page. Null on the last page.' });

export const listTriggerLinksQuery = z
  .strictObject({
    q: z
      .string()
      .trim()
      .max(200, { error: 'Use at most 200 characters.' })
      .optional()
      .meta({ description: 'Finds links by any part of their name, key or address.' }),
    limit: z.coerce.number().int().min(1).max(TRIGGER_LINK_LIMITS.page).default(20),
    after,
  })
  .meta({ id: 'ListTriggerLinksQuery' });
export type ListTriggerLinksQuery = z.output<typeof listTriggerLinksQuery>;

export const triggerLinkList = z
  .looseObject({
    items: z.array(triggerLink),
    total: z.int().meta({ description: 'How many links match the search, on every page.' }),
    next,
    canManage: z.boolean(),
  })
  .meta({ id: 'TriggerLinkList' });
export type TriggerLinkList = z.output<typeof triggerLinkList>;

export const listTriggerLinkClicksQuery = z
  .strictObject({
    from: timestamp.optional().meta({ description: 'Only clicks at or after this moment.' }),
    to: timestamp.optional().meta({ description: 'Only clicks before this moment.' }),
    limit: z.coerce.number().int().min(1).max(TRIGGER_LINK_LIMITS.page).default(20),
    after,
  })
  .meta({ id: 'ListTriggerLinkClicksQuery' });
export type ListTriggerLinkClicksQuery = z.output<typeof listTriggerLinkClicksQuery>;

export const triggerLinkClick = z
  .looseObject({
    id: z.uuid(),
    contact: z.looseObject({
      id: publicId('contact'),
      name: z.string(),
      trashed: z.boolean(),
    }),
    clickedAt: timestamp,
  })
  .meta({ id: 'TriggerLinkClick' });
export type TriggerLinkClick = z.output<typeof triggerLinkClick>;

export const triggerLinkClickList = z
  .looseObject({
    items: z.array(triggerLinkClick),
    clicks: z.int().meta({ description: 'Clicks in the range asked for.' }),
    contacts: z.int().meta({ description: 'Different contacts who clicked in that range.' }),
    next,
  })
  .meta({ id: 'TriggerLinkClickList' });
export type TriggerLinkClickList = z.output<typeof triggerLinkClickList>;

const group = 'Trigger links';
const linkParams = z.strictObject({ linkId: publicId('trigger_link') });

export const listTriggerLinks = defineEndpoint({
  operationId: 'listTriggerLinks',
  method: 'get',
  path: '/trigger-links',
  group,
  summary: 'Read trigger links, newest first, with their click counts',
  query: listTriggerLinksQuery,
  response: {
    status: 200,
    description: 'A page of links, and how many match.',
    schema: triggerLinkList,
  },
});
export const getTriggerLink = defineEndpoint({
  operationId: 'getTriggerLink',
  method: 'get',
  path: '/trigger-links/{linkId}',
  group,
  summary: 'Read one trigger link',
  params: linkParams,
  response: { status: 200, description: 'The link and its revision.', schema: triggerLink },
});
export const createTriggerLink = defineEndpoint({
  operationId: 'createTriggerLink',
  method: 'post',
  path: '/trigger-links',
  group,
  summary: 'Create a trigger link with a permanent key',
  body: createTriggerLinkInput,
  response: { status: 201, description: 'The new link, with its key.', schema: triggerLink },
});
export const updateTriggerLink = defineEndpoint({
  operationId: 'updateTriggerLink',
  method: 'put',
  path: '/trigger-links/{linkId}',
  group,
  summary: 'Rename a trigger link or change where it goes',
  params: linkParams,
  body: updateTriggerLinkInput,
  response: { status: 200, description: 'The saved link and its revision.', schema: triggerLink },
});
export const deleteTriggerLink = defineEndpoint({
  operationId: 'deleteTriggerLink',
  method: 'delete',
  path: '/trigger-links/{linkId}',
  group,
  summary: 'Delete a trigger link and its click history',
  params: linkParams,
  response: {
    status: 204,
    description:
      'The link is gone, with its clicks. Addresses already sent stop working, and a message that still writes its merge field is not sent.',
  },
});
export const listTriggerLinkClicks = defineEndpoint({
  operationId: 'listTriggerLinkClicks',
  method: 'get',
  path: '/trigger-links/{linkId}/clicks',
  group,
  summary: 'Read who clicked a trigger link, newest first',
  params: linkParams,
  query: listTriggerLinkClicksQuery,
  response: {
    status: 200,
    description: 'A page of clicks, with the counts for the range asked for.',
    schema: triggerLinkClickList,
  },
});

/** Every trigger link endpoint, for the API's list of operations. */
export const triggerLinkEndpoints = [
  listTriggerLinks,
  getTriggerLink,
  createTriggerLink,
  updateTriggerLink,
  deleteTriggerLink,
  listTriggerLinkClicks,
] as const;
