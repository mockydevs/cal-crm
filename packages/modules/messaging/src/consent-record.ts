import { defineCommand, requireBusiness, type Command, type CommandContext } from '@repo/commands';
import {
  consentChannels,
  consentPurposes,
  consentStatuses,
  parseInput,
  recordConsentInput,
  recordContactConsent,
  type ContactConsent,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import type { ActorNames } from '@repo/module-crm';
import { ForbiddenError, NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';
import {
  consentEvidence,
  recorderOf,
  sourceOfActor,
  storedProof,
  type ConsentEvidence,
} from './consent-proof.js';
import { readContactConsent } from './consent-read.js';
import {
  addressConsentStatus,
  latestConsentStatus,
  lockAddressConsent,
  lockContactConsent,
  type CurrentConsent,
} from './consent-state.js';

const recordInput = z.strictObject({
  contactId: z.uuid(),
  channel: z.enum(consentChannels),
  purpose: z.enum(consentPurposes),
  status: z.enum(consentStatuses),
  /** The address it was given or withdrawn for, as the contact's identity holds it. */
  address: z.string().min(1).max(320).optional(),
  evidence: consentEvidence,
});

/** One consent change: what changed for whom, and the evidence its source must show. */
export interface RecordConsent {
  /** The contact's UUID, already resolved in this business by the caller. */
  readonly contactId: string;
  readonly channel: (typeof consentChannels)[number];
  readonly purpose: (typeof consentPurposes)[number];
  readonly status: (typeof consentStatuses)[number];
  /**
   * The email address or phone number it was given or withdrawn for, normalized as the
   * contact's identity holds it. Left out, it is for the contact as a whole.
   */
  readonly address?: string;
  readonly evidence: ConsentEvidence;
}

export interface RecordedConsent {
  /** The new ledger row. */
  readonly id: string;
  /** What the consent was before this change. */
  readonly previous: CurrentConsent;
}

async function currentOf(
  trx: DatabaseTransaction,
  businessId: string,
  contactId: string,
  channel: string,
  purpose: string,
  address?: string,
): Promise<CurrentConsent> {
  const status =
    address === undefined
      ? latestConsentStatus(sql`${businessId}::uuid`, sql`${contactId}::uuid`, channel, purpose)
      : addressConsentStatus(
          sql`${businessId}::uuid`,
          sql`${contactId}::uuid`,
          sql`${address}::text`,
          channel,
          purpose,
        );
  const {
    rows: [row],
  } = await sql<{ status: CurrentConsent }>`select ${status} as status`.execute(trx);
  return row?.status ?? 'unknown';
}

/**
 * Appends one row to the consent ledger, with its proof, and reports it on the contact's
 * timeline. Call it inside a command's tenant transaction, so the row is kept with the
 * command's own change or not at all. It never updates or deletes a row: a change of mind
 * is another call.
 *
 * Proof is required by the source (consent-proof.ts), and who recorded it is decided
 * here: the contact for their own acts (a keyword, a form, a booking, an unsubscribe
 * link), otherwise the command's actor. The next send check reads the new row.
 */
export async function recordConsent(
  trx: DatabaseTransaction,
  command: CommandContext,
  input: RecordConsent,
): Promise<RecordedConsent> {
  const { contactId, channel, purpose, status, address, evidence } = parseInput(recordInput, input);
  const businessId = requireBusiness(command.context);
  const contact = await trx
    .selectFrom('crm.contacts')
    .select(['id', 'deleted_at'])
    .where('business_id', '=', businessId)
    .where('id', '=', contactId)
    .executeTakeFirst();
  if (contact?.deleted_at !== null) throw new NotFoundError('Contact', contactId);
  await lockContactConsent(trx, contactId);
  if (address !== undefined) await lockAddressConsent(trx, businessId, channel, address);
  const previous = await currentOf(trx, businessId, contactId, channel, purpose, address);
  const recorder = recorderOf(evidence.source, contactId, command.context);
  const row = await trx
    .insertInto('messaging.consents')
    .values({
      business_id: businessId,
      contact_id: contactId,
      channel,
      purpose,
      status,
      address_normalized: address ?? null,
      source: evidence.source,
      proof: sql`${JSON.stringify(storedProof(evidence))}::jsonb`,
      // The time it is written, under the lock: now() would be the transaction's start.
      recorded_at: sql`clock_timestamp()`,
      recorded_by_kind: recorder.kind,
      recorded_by_id: recorder.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await command.emit({
    type: status === 'granted' ? 'consent.granted' : 'consent.withdrawn',
    subject: { kind: 'contact', id: contactId },
    records: [contactId],
    // No proof here: events are kept forever and read by automations and webhooks.
    payload: { channel, purpose, source: evidence.source },
  });
  return { id: row.id, previous };
}

const commandInput = recordConsentInput.extend(recordContactConsent.params.shape);

/**
 * A person, or a program with an API key, records that a contact gave or withdrew
 * consent. The note saying how they know is required and kept as the proof.
 */
export function createRecordContactConsentCommand(
  actorNames: ActorNames = {},
): Command<typeof commandInput, ContactConsent> {
  return defineCommand({
    name: 'consents.record',
    permission: 'contacts.manage',
    input: commandInput,
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      const source = sourceOfActor(command.context.actorKind);
      if (source === undefined)
        throw new ForbiddenError('Only a person or an API key can record consent.');
      const contactId = parsePublicId('contact', input.id);
      if (contactId === undefined) throw new NotFoundError('Contact', input.id);
      // Held from the check to the insert, so a withdrawal can't slip between them.
      await lockContactConsent(trx, contactId);
      if (
        input.status === 'granted' &&
        !input.replacesWithdrawal &&
        (await currentOf(trx, businessId, contactId, input.channel, input.purpose)) === 'withdrawn'
      )
        throw new ValidationError([
          {
            path: '/replacesWithdrawal',
            code: 'consent_withdrawn',
            message:
              'This contact withdrew consent. Confirm that they asked to get these messages again.',
          },
        ]);
      await recordConsent(trx, command, {
        contactId,
        channel: input.channel,
        purpose: input.purpose,
        status: input.status,
        evidence: { source, note: input.note },
      });
      return readContactConsent(trx, command, input.id, actorNames);
    },
  });
}
