// A record's activity, and the chain of events behind one: what the timeline and its "Why?"
// panel read. Each entry is an event, with who or what made it.
import { actorKinds } from '@repo/kernel';
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId, recordId } from './ids.js';
import { timestamp } from './timestamps.js';

/** How many entries a page of a record's activity holds. */
export const ACTIVITY_PAGE_SIZE = 50;

/** How many steps back "Why?" follows a chain of causes. */
export const MAX_CHAIN_LENGTH = 50;

export const actor = z
  .looseObject({
    kind: z.enum(actorKinds),
    name: z
      .string()
      .nullable()
      .meta({
        description:
          "The person's, API key's, automation's, form's or contact's name. Null for a kind with no name, or one you can't see.",
        examples: ['Dana Brooks'],
      }),
    you: z.boolean().meta({ description: 'Whether the actor is you.' }),
  })
  .meta({
    id: 'Actor',
    description: 'Who or what made a change. The dashboard shows it as an actor label.',
  });

export type Actor = z.infer<typeof actor>;

export const activityEntry = z
  .looseObject({
    id: publicId('event'),
    type: z.string().meta({ examples: ['tag.created'] }),
    occurredAt: timestamp,
    subject: z.looseObject({
      kind: z.string().meta({ examples: ['tag'] }),
      id: z
        .string()
        .nullable()
        .meta({
          description:
            'Its public id. Null for a kind the API shows no ids for, such as the agency.',
          examples: ['tag_01h455vb4pex5vsknk084sn02q'],
        }),
    }),
    actor,
    payload: z
      .record(z.string(), z.unknown())
      .meta({ description: 'What changed, as the event recorded it.' }),
    causedBy: publicId('event').nullable().meta({
      description: 'The event that led to this one. Null when the actor started it directly.',
    }),
  })
  .meta({
    id: 'ActivityEntry',
    description: 'An event: what happened, to what, and who or what did it.',
  });

export type ActivityEntry = z.infer<typeof activityEntry>;

export const recordActivity = z
  .looseObject({
    items: z.array(activityEntry).meta({ description: 'Newest first.' }),
    next: publicId('event').nullable().meta({
      description: 'Pass it as after to read the next page. Null on the last page.',
    }),
  })
  .meta({ id: 'RecordActivity', description: "A page of a record's activity." });

export type RecordActivity = z.infer<typeof recordActivity>;

export const listRecordActivityQuery = z.strictObject({
  after: publicId('event')
    .optional()
    .meta({ description: "Start after this entry: the previous page's next." }),
});

export const listRecordActivity = defineEndpoint({
  operationId: 'listRecordActivity',
  method: 'get',
  path: '/records/{id}/activity',
  summary: "List a record's activity",
  group: 'Activity',
  params: z.object({ id: recordId }),
  query: listRecordActivityQuery,
  response: {
    status: 200,
    description: `Every change to the record, newest first, ${String(ACTIVITY_PAGE_SIZE)} at a time.`,
    schema: recordActivity,
  },
});

export const eventChain = z
  .looseObject({
    items: z.array(activityEntry).meta({
      description:
        'From the event that started the chain, through each one it led to, to this one.',
    }),
    reachesOrigin: z.boolean().meta({
      description: `False when an earlier cause can't be read: it was archived, you can't see it, or it's more than ${String(MAX_CHAIN_LENGTH)} steps back.`,
    }),
  })
  .meta({ id: 'EventChain', description: 'Why an event happened: the events that led to it.' });

export type EventChain = z.infer<typeof eventChain>;

export const explainEvent = defineEndpoint({
  operationId: 'explainEvent',
  method: 'get',
  path: '/events/{id}/why',
  summary: 'Explain why an event happened',
  group: 'Activity',
  params: z.object({ id: publicId('event') }),
  response: {
    status: 200,
    description: 'The chain of events that led to it, oldest first.',
    schema: eventChain,
  },
});
