// sms.send: the step's text filled in for the enrolled contact and queued through
// messaging's own outbound path, so consent, do-not-contact, suppressions, quiet hours and
// sending limits apply exactly as for any other message. Nothing is sent from here.
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, type TenantContext } from '@repo/kernel';
import {
  queueOutboundMessage,
  readSmsSenders,
  renderWithTriggerLinks,
  SMS_BODY_MAX,
} from '@repo/module-messaging';

import { queuedOutcome, refused, type MessageSendResult } from './actions-email.js';
import { runAppointment, type AppointmentLinks } from './appointment-values.js';
import { runValues } from './run-values.js';

// The number to send from: the one named, else the business's only one. Either way it must
// be able to send now, the same rule the setup offers numbers by.
export async function senderOf(
  trx: DatabaseTransaction,
  number: string | undefined,
): Promise<string | MessageSendResult> {
  const usable = await readSmsSenders(trx);
  if (number !== undefined) {
    const id = parsePublicId('phone_number', number);
    return (
      usable.find((each) => each.id === id)?.id ??
      refused(
        'number_unavailable',
        "The step's number is gone, turned off, or its provider is not connected.",
      )
    );
  }
  const [only] = usable;
  if (only === undefined || usable.length > 1)
    return refused(
      'number_required',
      usable.length === 0
        ? 'No number is connected and able to send text messages.'
        : 'More than one number can send, so the step must say which.',
    );
  return only.id;
}

/**
 * Queues the text for the contact, once per visit to the step: the key makes a retried job
 * find the message it already queued instead of sending a second one.
 */
export async function sendTextMessage(
  trx: DatabaseTransaction,
  context: TenantContext,
  input: {
    readonly contactId: string;
    readonly enrolmentId?: string | undefined;
    readonly message: string;
    readonly number: string | undefined;
    /** transactional: about the appointment the contact booked. Left out, marketing. */
    readonly purpose?: 'marketing' | 'transactional' | undefined;
    readonly idempotencyKey: string;
    /** Whether this install can hand a text message to its provider at all. */
    readonly available: boolean;
    /** PUBLIC_URL: where a trigger link in the text gets its address. */
    readonly publicUrl?: string | undefined;
    /** What fills appointment.manageUrl; left out, it is empty. */
    readonly appointmentLinks?: AppointmentLinks | undefined;
  },
): Promise<MessageSendResult> {
  if (!input.available)
    return refused(
      'sms_unavailable',
      "This install can't send text messages: it needs a secrets vault and a public https address for delivery reports.",
    );
  const sender = await senderOf(trx, input.number);
  if (typeof sender !== 'string') return sender;

  const recipient = await trx
    .selectFrom('crm.contact_identities')
    .select('id')
    .where('contact_id', '=', input.contactId)
    .where('kind', '=', 'phone')
    .where('is_primary', '=', true)
    .executeTakeFirst();
  if (recipient === undefined)
    return refused('no_phone_number', 'The contact has no phone number to send to.');

  // A text has no subject, so only a missing value can stop it being filled in.
  const rendered = await renderWithTriggerLinks(trx, context, {
    contactId: input.contactId,
    text: { subject: '', body: input.message },
    values: await runValues(trx, input.contactId, input.enrolmentId, input.appointmentLinks),
    publicUrl: input.publicUrl,
  });
  if (!rendered.ok)
    return refused('missing_values', `The contact has no value for ${rendered.fields.join(', ')}.`);
  if (rendered.body.length > SMS_BODY_MAX)
    return refused(
      'sms_body_too_long',
      `Filled in, the text is ${String(rendered.body.length)} characters; a text message holds ${String(SMS_BODY_MAX)} at most.`,
    );

  const purpose = input.purpose ?? 'marketing';
  // A transactional text names the contact's own appointment it is about, so quiet hours do
  // not hold a reminder of it.
  const appointmentId =
    purpose === 'transactional' && input.enrolmentId !== undefined
      ? await runAppointment(trx, input.contactId, input.enrolmentId)
      : undefined;
  const messageId = await queueOutboundMessage(trx, context, {
    identityId: recipient.id,
    accountId: sender,
    channel: 'sms',
    purpose,
    lane: 'automation',
    idempotencyKey: input.idempotencyKey,
    text: rendered.body,
    ...(appointmentId === undefined ? {} : { appointmentId }),
  });
  return queuedOutcome(trx, messageId, 'text message');
}
