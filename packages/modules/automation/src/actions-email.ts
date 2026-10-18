// email.send: plain or formatted content filled in for the enrolled contact, with the
// step's own From name, Reply-To, Cc, Bcc and files, and queued through messaging's own
// outbound path, so consent, quiet hours, suppressions and sending limits apply exactly as
// for any other message. Nothing is sent from here.

import { requireBusiness } from '@repo/commands';
import { renderMessageTemplate } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, type TenantContext } from '@repo/kernel';
import {
  composeEmail,
  OUTBOUND_ATTACHMENT_BYTES,
  queueOutboundMessage,
  type EmailParts,
} from '@repo/module-messaging';
import { sql } from 'kysely';
import * as z from 'zod';

import { runAppointment, type AppointmentLinks } from './appointment-values.js';
import { runValues } from './run-values.js';
import { readPublishedEmailContent } from './email-content-resolution.js';
import { readEmailVisitReplay } from './email-visit-replay.js';

/** What queueing a message for a step came to: queued (and when it may go), or why not. */
export type MessageSendResult =
  | {
      readonly ok: true;
      readonly messageId: string;
      readonly explanation: string;
      readonly emailContent?: { readonly binding: string; readonly revision: number };
    }
  | { readonly ok: false; readonly code: string; readonly explanation: string };
export type EmailSendResult = MessageSendResult;

export const refused = (code: string, explanation: string): MessageSendResult => ({
  ok: false,
  code,
  explanation,
});

const HELD: Readonly<Record<string, string>> = {
  quiet_hours: "it is held until the contact's quiet hours end",
  frequency_cap: "it is held until the contact's daily message limit allows it",
};

/**
 * What messaging decided about a message just queued. A refusal (no consent, suppressed, do
 * not contact) is kept on the message and fails the step; a deferral (quiet hours, limits)
 * leaves it queued to go later, and the step says so.
 */
export async function queuedOutcome(
  trx: DatabaseTransaction,
  messageId: string,
  noun: 'email' | 'text message',
): Promise<MessageSendResult> {
  const message = await trx
    .selectFrom('messaging.messages')
    .select(['status', 'error_code'])
    .where('id', '=', messageId)
    .executeTakeFirstOrThrow();
  if (message.status === 'failed')
    return refused(
      message.error_code ?? 'refused',
      `Messaging refused the ${noun}: ${message.error_code ?? 'no reason given'}.`,
    );
  const held = message.error_code === null ? undefined : HELD[message.error_code];
  return {
    ok: true,
    messageId,
    explanation:
      held === undefined ? `The ${noun} was queued to send.` : `The ${noun} was queued; ${held}.`,
  };
}

// The mailbox to send from: the one named, else the business's only one. Either way it
// must be working and marked for conversations, the same rule the setup offers them by.
export async function senderOf(
  trx: DatabaseTransaction,
  mailbox: string | undefined,
): Promise<string | EmailSendResult> {
  const usable = trx
    .selectFrom('messaging.mailboxes as mailbox')
    .innerJoin('messaging.channel_accounts as channel', (join) =>
      join
        .onRef('channel.id', '=', 'mailbox.id')
        .onRef('channel.business_id', '=', 'mailbox.business_id'),
    )
    .select('mailbox.id')
    .where('channel.status', '=', 'active')
    .where('mailbox.use_for_conversations', '=', true);
  if (mailbox !== undefined) {
    const id = parsePublicId('mailbox', mailbox);
    const row =
      id === undefined ? undefined : await usable.where('mailbox.id', '=', id).executeTakeFirst();
    return (
      row?.id ??
      refused('mailbox_unavailable', "The step's mailbox is gone, paused or not for conversations.")
    );
  }
  const rows = await usable.limit(2).execute();
  const [only] = rows;
  if (only === undefined || rows.length > 1)
    return refused(
      'mailbox_required',
      rows.length === 0
        ? 'No mailbox is connected and working, so there is nothing to send from.'
        : 'More than one mailbox can send, so the step must say which.',
    );
  return only.id;
}

type Values = Awaited<ReturnType<typeof runValues>>;

const emailAddress = z.email().max(254);

// One line of the step filled in: the From name, or an address given as a merge field.
function filledLine(text: string, values: Values, what: string): string | EmailSendResult {
  const rendered = renderMessageTemplate({ subject: text, body: '' }, values);
  if (rendered.ok) return rendered.subject.trim();
  return refused(
    rendered.code,
    rendered.code === 'missing_values'
      ? `The contact has no value for ${rendered.fields.join(', ')}, which ${what} needs.`
      : `A line break in ${rendered.fields.join(', ')} can't go in ${what}.`,
  );
}

// Reply-To, Cc and Bcc as addresses: each given as one, or as a merge field that must hold one.
function addressesOf(
  given: readonly string[],
  values: Values,
  what: string,
): string[] | EmailSendResult {
  const addresses: string[] = [];
  for (const each of given) {
    const line = filledLine(each, values, what);
    if (typeof line !== 'string') return line;
    const address = emailAddress.safeParse(line.toLowerCase());
    if (!address.success)
      return refused('invalid_address', `${what} holds "${line}", which is not an email address.`);
    if (!addresses.includes(address.data)) addresses.push(address.data);
  }
  return addresses;
}

// Addresses nothing may be sent to are left out of Cc and Bcc, as the recipient's own is.
async function allowedCopies(
  trx: DatabaseTransaction,
  addresses: readonly string[],
  exclude: readonly string[],
): Promise<string[]> {
  const wanted = addresses.filter((address) => !exclude.includes(address));
  if (wanted.length === 0) return [];
  const blocked = await trx
    .selectFrom('messaging.suppressions')
    .select('address_normalized')
    .where('channel', '=', 'email')
    .where('address_normalized', 'in', wanted)
    .where(sql<boolean>`(expires_at is null or expires_at > now())`)
    .execute();
  const suppressed = new Set(blocked.map((row) => row.address_normalized));
  return wanted.filter((address) => !suppressed.has(address));
}

// The step's files as the pipeline takes them: files of this business that still exist and
// together fit in one email. Anything else fails the step before a message is made.
async function attachmentsOf(
  trx: DatabaseTransaction,
  context: TenantContext,
  files: readonly string[],
): Promise<string[] | EmailSendResult> {
  const ids = files.map((file) => parsePublicId('file', file));
  const known = ids.filter((id) => id !== undefined);
  const rows =
    known.length === 0
      ? []
      : await trx
          .selectFrom('files.files')
          .select(['id', 'size_bytes'])
          .where('business_id', '=', requireBusiness(context))
          .where('id', 'in', known)
          .where('deleted_at', 'is', null)
          // A file kept for one purpose, such as a record's document, is reached only that way.
          .where('purpose', 'is', null)
          .execute();
  if (rows.length !== files.length)
    return refused(
      'attachment_unavailable',
      'A file this step attaches is gone, or is not a file of this business.',
    );
  if (rows.reduce((bytes, row) => bytes + Number(row.size_bytes), 0) > OUTBOUND_ATTACHMENT_BYTES)
    return refused(
      'attachments_too_large',
      'The files this step attaches come to more than 15 MB, which mail servers refuse.',
    );
  return known;
}

/** What a Send email step says besides its content (contracts workflowEmailEnvelope). */
export interface EmailEnvelope {
  /**
   * transactional: about the appointment the contact booked, so the booking's consent
   * counts and no marketing footer is added. Left out, marketing, as it always was.
   */
  readonly purpose?: 'marketing' | 'transactional' | undefined;
  readonly mailbox?: string | undefined;
  readonly fromName?: string | undefined;
  readonly replyTo?: string | undefined;
  readonly cc?: readonly string[] | undefined;
  readonly bcc?: readonly string[] | undefined;
  readonly preheader?: string | undefined;
  readonly attachments?: readonly string[] | undefined;
}

/** The step's content, in each form its config takes (contracts workflowEmailStepConfig). */
export type EmailStepContent =
  | {
      readonly mode: 'copy';
      readonly subject: string;
      readonly body: string;
      readonly html?: string | undefined;
    }
  | {
      readonly mode: 'sync';
      readonly source: { readonly id: string };
      readonly subject?: string | undefined;
    }
  | { readonly mode?: undefined; readonly template: string; readonly subject?: string | undefined }
  | {
      readonly mode?: undefined;
      readonly subject: string;
      readonly body: string;
      readonly html?: string | undefined;
    };

export async function liveTemplate(
  trx: DatabaseTransaction,
  template: string,
): Promise<
  { subject: string; body: string; body_html: string | null; preheader: string | null } | undefined
> {
  const templateId = parsePublicId('template', template);
  return templateId === undefined
    ? undefined
    : trx
        .selectFrom('messaging.templates')
        .select(['subject', 'body', 'body_html', 'preheader'])
        .where('id', '=', templateId)
        .where('channel', '=', 'email')
        .where('archived_at', 'is', null)
        .executeTakeFirst();
}

/**
 * Queues email content for the contact, once per visit to the step: the key makes a retried
 * job find the message it already queued instead of sending a second one.
 */
export async function sendAutomationEmail(
  trx: DatabaseTransaction,
  context: TenantContext,
  input: {
    readonly contactId: string;
    readonly enrolmentId?: string | undefined;
    readonly stepKey?: string;
    readonly idempotencyKey: string;
    /** PUBLIC_URL: where a trigger link in the template gets its address. */
    readonly publicUrl?: string | undefined;
    /** What fills appointment.manageUrl; left out, it is empty. */
    readonly appointmentLinks?: AppointmentLinks | undefined;
  } & EmailEnvelope &
    EmailStepContent,
): Promise<EmailSendResult> {
  const existing = await readEmailVisitReplay(trx, context, input);
  if (existing !== undefined) {
    // Content and addresses were frozen by messaging when this visit was admitted.
    // Delivery still rechecks consent and sender policy in the canonical dispatch task.
    const outcome = await queuedOutcome(trx, existing.id, 'email');
    return outcome.ok && existing.emailContent !== undefined
      ? { ...outcome, emailContent: existing.emailContent }
      : outcome;
  }
  let parts: EmailParts;
  let emailContent: { readonly binding: string; readonly revision: number } | undefined;
  const unavailable = refused('template_unavailable', "The step's template is gone or archived.");
  if (input.mode === 'copy' || input.mode === 'sync') {
    const stored =
      input.enrolmentId === undefined || input.stepKey === undefined
        ? undefined
        : await readPublishedEmailContent(trx, input.enrolmentId, input.stepKey);
    if (stored === 'unavailable') return unavailable;
    if (stored === undefined)
      return refused('email_content_unavailable', 'The published email content is unavailable.');
    emailContent = { binding: stored.binding, revision: stored.revision };
    parts =
      input.mode === 'copy'
        ? {
            subject: stored.subject,
            text: stored.body,
            html: stored.html,
            preheader: stored.preheader,
          }
        : {
            // The step's own subject and preview text stand in for the template's.
            subject: input.subject ?? stored.subject,
            text: stored.body,
            html: stored.html,
            preheader: input.preheader ?? stored.preheader,
          };
  } else if ('template' in input) {
    const template = await liveTemplate(trx, input.template);
    if (template === undefined) return unavailable;
    parts = {
      subject: input.subject ?? template.subject,
      text: template.body,
      html: template.body_html,
      preheader: input.preheader ?? template.preheader,
    };
  } else {
    parts = {
      subject: input.subject,
      text: input.body,
      html: input.html,
      preheader: input.preheader,
    };
  }

  const sender = await senderOf(trx, input.mailbox);
  if (typeof sender !== 'string') return sender;

  const recipient = await trx
    .selectFrom('crm.contact_identities')
    .select(['id', 'value_normalized'])
    .where('contact_id', '=', input.contactId)
    .where('kind', '=', 'email')
    .where('is_primary', '=', true)
    .executeTakeFirst();
  if (recipient === undefined)
    return refused('no_email_address', 'The contact has no email address to send to.');

  const values = await runValues(trx, input.contactId, input.enrolmentId, input.appointmentLinks);
  const fromName =
    input.fromName === undefined ? undefined : filledLine(input.fromName, values, 'the From name');
  if (fromName !== undefined && typeof fromName !== 'string') return fromName;
  const replyTo =
    input.replyTo === undefined ? [] : addressesOf([input.replyTo], values, 'Reply-To');
  if (!Array.isArray(replyTo)) return replyTo;
  const cc = addressesOf(input.cc ?? [], values, 'Cc');
  if (!Array.isArray(cc)) return cc;
  const bcc = addressesOf(input.bcc ?? [], values, 'Bcc');
  if (!Array.isArray(bcc)) return bcc;
  const copied = await allowedCopies(trx, cc, [recipient.value_normalized]);
  const hidden = await allowedCopies(trx, bcc, [recipient.value_normalized, ...copied]);
  const attachments =
    input.attachments === undefined
      ? undefined
      : await attachmentsOf(trx, context, input.attachments);
  if (attachments !== undefined && !Array.isArray(attachments)) return attachments;

  const purpose = input.purpose ?? 'marketing';
  const rendered = await composeEmail(trx, context, {
    contactId: input.contactId,
    parts,
    values,
    publicUrl: input.publicUrl,
    marketing: purpose === 'marketing',
  });
  if (!rendered.ok)
    return refused(
      rendered.code,
      rendered.code === 'missing_values'
        ? `The contact has no value for ${rendered.fields.join(', ')}.`
        : `A line break in ${rendered.fields.join(', ')} can't go in the subject.`,
    );

  // A transactional email names the contact's own appointment it is about, so quiet hours
  // do not hold a reminder of it.
  const appointmentId =
    purpose === 'transactional' && input.enrolmentId !== undefined
      ? await runAppointment(trx, input.contactId, input.enrolmentId)
      : undefined;
  const messageId = await queueOutboundMessage(trx, context, {
    identityId: recipient.id,
    accountId: sender,
    channel: 'email',
    purpose,
    lane: 'automation',
    idempotencyKey: input.idempotencyKey,
    ...(appointmentId === undefined ? {} : { appointmentId }),
    subject: rendered.subject,
    text: rendered.text,
    // Each is left out when the step sets none, so an older step's request is what it was.
    ...(rendered.html === null ? {} : { html: rendered.html }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(fromName === undefined || fromName === '' ? {} : { fromName: fromName.slice(0, 120) }),
    ...(replyTo[0] === undefined ? {} : { replyTo: replyTo[0] }),
    ...(copied.length === 0 ? {} : { cc: copied }),
    ...(hidden.length === 0 ? {} : { bcc: hidden }),
  });
  const outcome = await queuedOutcome(trx, messageId, 'email');
  return outcome.ok && emailContent !== undefined ? { ...outcome, emailContent } : outcome;
}
