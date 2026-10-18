// The proof kept with each consent change (messaging.consents.proof), by where the change
// came from. A change with nothing to show for it is refused: the ledger exists to answer
// "how do you know?" (ARCHITECTURE.md section 5.2).
import type { ActorKind } from '@repo/kernel';
import type { ConsentProof, ConsentSource } from '@repo/contracts';
import { isIP } from 'node:net';
import * as z from 'zod';

const note = z.string().trim().min(1).max(1000);
const wording = z.string().trim().min(1).max(2000);
const ipAddress = z
  .string()
  .max(45)
  .refine((value) => isIP(value) !== 0);
const pageUrl = z.url({ protocol: /^https?$/ }).max(2000);

/**
 * What each source must show. The keys are the ones already stored by the booking page
 * (appointmentId, wording, ipAddress) and the unsubscribe link (messageId).
 */
export const consentEvidence = z.discriminatedUnion('source', [
  // A person, or a program with an API key, says how they know.
  z.strictObject({ source: z.literal('user'), note }),
  z.strictObject({ source: z.literal('api'), note }),
  z.strictObject({ source: z.literal('import'), note, fileId: z.uuid().optional() }),
  // A keyword the contact sent, such as STOP: the word, and the message it came in.
  z
    .strictObject({
      source: z.literal('keyword'),
      keyword: z.string().trim().min(1).max(40),
      messageId: z.uuid().optional(),
      providerMessageId: z.string().min(1).max(200).optional(),
    })
    .refine((value) => value.messageId !== undefined || value.providerMessageId !== undefined, {
      error: 'A keyword needs the message it came in.',
    }),
  // A box the contact ticked: the words beside it, and the form or widget that showed it.
  z
    .strictObject({
      source: z.literal('form'),
      wording,
      formId: z.uuid().optional(),
      submissionId: z.uuid().optional(),
      widgetId: z.uuid().optional(),
      pageUrl: pageUrl.optional(),
      ipAddress: ipAddress.optional(),
      userAgent: z.string().max(500).optional(),
    })
    .refine((value) => value.formId !== undefined || value.widgetId !== undefined, {
      error: 'A form needs the form or widget that showed the wording.',
    }),
  z.strictObject({
    source: z.literal('booking'),
    appointmentId: z.uuid(),
    wording,
    ipAddress,
  }),
  z.strictObject({ source: z.literal('unsubscribe_link'), messageId: z.uuid() }),
]);
export type ConsentEvidence = z.input<typeof consentEvidence>;

/** The proof as stored: the evidence without its source, which has a column of its own. */
export function storedProof(evidence: z.output<typeof consentEvidence>): Record<string, string> {
  const proof: Record<string, string> = {};
  for (const [key, value] of Object.entries(evidence))
    if (key !== 'source' && typeof value === 'string') proof[key] = value;
  return proof;
}

// The contact acted for themselves through these; anything else is recorded by whoever
// ran the command, so nobody can attribute a change to someone else.
const byContact: readonly ConsentSource[] = ['keyword', 'form', 'booking', 'unsubscribe_link'];

/** Who a change is recorded as made by: the contact for their own acts, else the actor. */
export function recorderOf(
  source: ConsentSource,
  contactId: string,
  actor: { readonly actorKind: ActorKind; readonly actorId?: string },
): { readonly kind: ActorKind; readonly id: string | null } {
  return byContact.includes(source)
    ? { kind: 'contact', id: contactId }
    : { kind: actor.actorKind, id: actor.actorId ?? null };
}

/**
 * The source a change made through the API is recorded with. Only a signed-in person or
 * an API key may say a contact consented: an assistant or an automation has nothing to
 * show for it.
 */
export function sourceOfActor(actorKind: ActorKind): 'user' | 'api' | undefined {
  if (actorKind === 'user') return 'user';
  if (actorKind === 'api_key') return 'api';
  return undefined;
}

const text = (proof: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = proof[key];
  return typeof value === 'string' && value !== '' ? value : null;
};

/**
 * Stored proof as the API shows it. Internal ids stay out: what a change is linked to is
 * named by its kind. Rows written before proof was required show nothing.
 */
export function presentProof(stored: unknown): ConsentProof {
  const proof: Readonly<Record<string, unknown>> =
    typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? { ...stored } : {};
  return {
    note: text(proof, 'note'),
    wording: text(proof, 'wording'),
    keyword: text(proof, 'keyword'),
    ipAddress: text(proof, 'ipAddress'),
    pageUrl: text(proof, 'pageUrl'),
    linked:
      text(proof, 'appointmentId') !== null
        ? 'appointment'
        : text(proof, 'formId') !== null ||
            text(proof, 'submissionId') !== null ||
            text(proof, 'widgetId') !== null
          ? 'form'
          : text(proof, 'messageId') !== null || text(proof, 'providerMessageId') !== null
            ? 'message'
            : null,
  };
}
