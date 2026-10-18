// An event as events.events records it: what happened, to what, caused by whom and by
// what. Automations, webhooks, reports and the "Why?" panel all read events.
import { actorKinds } from '@repo/kernel';
import * as z from 'zod';

import { timestamp } from './timestamps.js';

export const eventEnvelope = z
  .object({
    id: z.uuid(),
    agencyId: z.uuid(),
    /** Null for agency-level events. */
    businessId: z.uuid().nullable(),
    /** Two or more dotted parts, such as contact.created. */
    type: z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/),
    version: z.int().min(1).max(32767),
    /** When it happened in the business; an import can set it in the past. */
    occurredAt: timestamp,
    /** When it was stored. */
    recordedAt: timestamp,
    actorKind: z.enum(actorKinds),
    actorId: z.uuid().nullable(),
    /** The event that caused this one. */
    causationId: z.uuid().nullable(),
    /** Shared by every event that one originating request led to. */
    correlationId: z.uuid(),
    subjectKind: z.string().regex(/^[a-z][a-z_]*$/),
    subjectId: z.uuid(),
    payload: z.record(z.string(), z.unknown()),
    /** The assistant's proposal a person applied to cause it; null for everything else. */
    proposalId: z.uuid().nullable(),
    /** The outer audit command that wrote it; null for events written outside a command. */
    commandId: z.uuid().nullable(),
  })
  .meta({ id: 'Event' });

export type EventEnvelope = z.infer<typeof eventEnvelope>;
