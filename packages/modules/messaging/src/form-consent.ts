// Marketing consent from a form: a box a visitor ticked, with what proves it. The forms
// module calls this inside its submission's transaction, for the contact its canonical
// intake resolved, so the ledger row is kept with the submission or not at all.
import { requireBusiness, type CommandContext } from '@repo/commands';
import { parseInput } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { countryOf, normalizePhone } from '@repo/module-crm';
import { NotFoundError } from '@repo/kernel';
import { sql } from 'kysely';
import { isIP } from 'node:net';
import * as z from 'zod';

import { recordConsent } from './consent-record.js';
import {
  addressConsentStatus,
  lockAddressConsent,
  lockContactConsent,
  type CurrentConsent,
} from './consent-state.js';

const consentInput = z.strictObject({
  contactId: z.uuid(),
  channel: z.enum(['email', 'sms']),
  /**
   * The email address or phone number this submission gave for the channel, as typed. The
   * consent is for that address alone, and only when the contact holds it.
   */
  address: z.string().trim().min(1).max(320),
  /** The words beside the box, exactly as the form showed them. */
  wording: z.string().trim().min(1).max(2000),
  formId: z.uuid(),
  submissionId: z.uuid(),
  /** The address the server saw the request come from; never one the visitor sent. */
  ipAddress: z
    .string()
    .max(45)
    .refine((value) => isIP(value) !== 0),
  pageUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .optional(),
  userAgent: z.string().max(500).optional(),
});

export type FormConsentInput = z.input<typeof consentInput>;

/**
 * Recorded as granted; left alone because the address had withdrawn it; or not recorded
 * because the contact does not hold the address the submission gave.
 */
export type FormConsentOutcome = 'granted' | 'withdrawn_kept' | 'no_address';

/**
 * Records marketing consent for one channel from a form's box, with its proof: the form,
 * the submission, the wording, the server-observed address and the time.
 *
 * A form is filled in by anyone who knows an address, so it never undoes a withdrawal:
 * when the contact's consent for this channel is withdrawn, nothing is written and the
 * caller is told. A person on the team can record the new consent, with the submission
 * as what they saw (the consents.record command asks them to confirm exactly this).
 */
export async function recordFormConsent(
  trx: DatabaseTransaction,
  command: CommandContext,
  input: FormConsentInput,
): Promise<FormConsentOutcome> {
  const { contactId, channel, address: typed, ...evidence } = parseInput(consentInput, input);
  const businessId = requireBusiness(command.context);
  const contact = await trx
    .selectFrom('crm.contacts')
    .select('deleted_at')
    .where('id', '=', contactId)
    .executeTakeFirst();
  if (contact?.deleted_at !== null) throw new NotFoundError('Contact', contactId);
  // As the contact's identities hold it: an email in lower case, a phone number in E.164,
  // read in the business's country as the intake read it.
  const normalized =
    channel === 'email'
      ? typed.toLowerCase()
      : normalizePhone(typed, await countryOf(trx, businessId));
  if (typeof normalized !== 'string') return 'no_address';
  const held = await trx
    .selectFrom('crm.contact_identities')
    .select('value_normalized')
    .where('contact_id', '=', contactId)
    .where('kind', '=', channel === 'email' ? 'email' : 'phone')
    .where('value_normalized', '=', normalized)
    .executeTakeFirst();
  // A box ticked beside an address the contact doesn't hold grants nothing: never consent
  // for a number or address the visitor did not give.
  if (held === undefined) return 'no_address';
  // Held from the check to the insert, so a withdrawal can't slip between them.
  await lockContactConsent(trx, contactId);
  await lockAddressConsent(trx, businessId, channel, normalized);
  const {
    rows: [row],
  } = await sql<{ status: CurrentConsent }>`
    select ${addressConsentStatus(sql`${businessId}::uuid`, sql`${contactId}::uuid`, sql`${normalized}::text`, channel, 'marketing')} as status
  `.execute(trx);
  if (row?.status === 'withdrawn') return 'withdrawn_kept';
  await recordConsent(trx, command, {
    contactId,
    channel,
    purpose: 'marketing',
    status: 'granted',
    address: normalized,
    evidence: { source: 'form', ...evidence },
  });
  return 'granted';
}
