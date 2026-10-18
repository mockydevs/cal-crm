// One email to one contact from another module, such as an invoice from commerce. It is a
// transactional message, queued through the one outbound pipeline: the contact's
// transactional consent for email, suppressions, do not contact, quiet hours, the daily cap
// and the mailbox's own limits all apply, and the message is stored in the contact's
// conversation like any other. Nothing here sends: the worker's dispatch job does.
//
// The caller names the contact and one of the contact's own addresses. An address that is
// not the contact's is refused: the pipeline sends to an identity, never to typed text.
// What the pipeline decided is read back and returned, a refusal included; a refused
// message is left as the pipeline stored it, for the caller's transaction to keep or undo.
import { requireBusiness } from '@repo/commands';
import { parseInput } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import {
  lockBusiness,
  OUTBOUND_ATTACHMENT_LIMIT,
  queueOutboundMessage,
  readOutboundPolicy,
} from './outbound.js';

const emailInput = z.strictObject({
  contactId: z.uuid(),
  to: z.string().trim().min(3).max(320),
  /** A mailbox's public id. Left out: the business's first that sends conversations. */
  mailboxId: z.string().max(100).optional(),
  idempotencyKey: z.string().min(1).max(200),
  subject: z
    .string()
    .min(1)
    .max(998)
    .regex(/^[^\r\n]*$/),
  text: z.string().min(1).max(100_000),
  /** Public ids of files of the business to send with it. */
  attachments: z.array(z.string().max(100)).max(OUTBOUND_ATTACHMENT_LIMIT),
});
export interface ContactEmailInput {
  /** crm.contacts.id. */
  readonly contactId: string;
  /** One of the contact's own email addresses. */
  readonly to: string;
  readonly mailboxId?: string | undefined;
  readonly idempotencyKey: string;
  readonly subject: string;
  readonly text: string;
  /** Public ids of files of the business to send with it. */
  readonly attachments: readonly string[];
}

/** Why the email was not taken. Each is a precondition someone can put right. */
export type ContactEmailRefusal =
  /** The business has no active mailbox that sends conversations, or not the one named. */
  | 'no_mailbox'
  /** The address is not one of this contact's email addresses. */
  | 'not_contacts_address'
  | 'contact_inactive'
  | 'sender_inactive'
  | 'do_not_contact'
  | 'suppressed'
  | 'consent_withdrawn'
  /** No transactional consent for email is recorded for the contact. */
  | 'consent_required'
  /** Quiet hours are on and the contact has no time zone to keep them in. */
  | 'timing_unknown';

export type ContactEmailResult =
  | {
      readonly outcome: 'queued';
      /** Public ids. */
      readonly messageId: string;
      readonly conversationId: string;
      readonly to: string;
      /** Held for later by quiet hours, the contact's daily cap or the mailbox's limits. */
      readonly deferred: boolean;
      /** The idempotency key was sent before: this is that message, and nothing was added. */
      readonly repeated: boolean;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: ContactEmailRefusal;
      /** A suppression's category, or `channel` for do not disturb on email alone. */
      readonly detail?: string;
    };

const REFUSALS: ReadonlySet<string> = new Set<ContactEmailRefusal>([
  'contact_inactive',
  'sender_inactive',
  'do_not_contact',
  'suppressed',
  'consent_withdrawn',
  'consent_required',
  'timing_unknown',
]);
const isRefusal = (code: string | null): code is ContactEmailRefusal =>
  code !== null && REFUSALS.has(code);

/**
 * Takes the pipeline's own lock on the business, first. A command that will queue an email
 * calls this before it holds anything else of the business: the pipeline takes the business
 * FOR UPDATE, and a command that already shared it with another would deadlock with it.
 */
export async function holdContactEmail(
  trx: DatabaseTransaction,
  context: TenantContext,
): Promise<void> {
  await lockBusiness(trx, context);
}

/** The email queued under this key before, if one was: so a repeated request sends nothing. */
export async function findContactEmail(
  trx: DatabaseTransaction,
  context: TenantContext,
  idempotencyKey: string,
): Promise<Extract<ContactEmailResult, { outcome: 'queued' }> | undefined> {
  const message = await trx
    .selectFrom('messaging.messages')
    .select([
      'id',
      'conversation_id',
      'to_addresses',
      sql<boolean>`coalesce(scheduled_for > now(), false)`.as('deferred'),
    ])
    .where('business_id', '=', requireBusiness(context))
    .where('idempotency_key', '=', idempotencyKey)
    .where('direction', '=', 'outbound')
    .where('channel', '=', 'email')
    .executeTakeFirst();
  if (message === undefined) return undefined;
  return {
    outcome: 'queued',
    messageId: toPublicId('message', message.id),
    conversationId: toPublicId('conversation', message.conversation_id),
    to: message.to_addresses[0] ?? '',
    deferred: message.deferred,
    repeated: true,
  };
}

type Refused = Extract<ContactEmailResult, { outcome: 'refused' }>;

/** Who it goes to and which mailbox sends it, or why neither can be named. */
async function resolve(
  trx: DatabaseTransaction,
  businessId: string,
  email: {
    readonly contactId: string;
    readonly to: string;
    readonly mailboxId?: string | undefined;
  },
): Promise<
  | {
      readonly identity: { readonly id: string; readonly value_normalized: string };
      readonly accountId: string;
    }
  | Refused
> {
  const identity = await trx
    .selectFrom('crm.contact_identities')
    .select(['id', 'value_normalized'])
    .where('business_id', '=', businessId)
    .where('contact_id', '=', email.contactId)
    .where('kind', '=', 'email')
    .where('value_normalized', '=', email.to.toLowerCase())
    .executeTakeFirst();
  if (identity === undefined) return { outcome: 'refused', reason: 'not_contacts_address' };

  const mailboxId =
    email.mailboxId === undefined ? undefined : parsePublicId('mailbox', email.mailboxId);
  if (email.mailboxId !== undefined && mailboxId === undefined)
    return { outcome: 'refused', reason: 'no_mailbox' };
  let senders = trx
    .selectFrom('messaging.channel_accounts as a')
    .innerJoin('messaging.mailboxes as m', (join) =>
      join.onRef('m.business_id', '=', 'a.business_id').onRef('m.id', '=', 'a.id'),
    )
    .select('a.id')
    .where('a.business_id', '=', businessId)
    .where('a.channel', '=', 'email')
    .where('a.status', '=', 'active')
    .where('m.use_for_conversations', '=', true)
    .orderBy('a.created_at')
    .orderBy('a.id');
  if (mailboxId !== undefined) senders = senders.where('a.id', '=', mailboxId);
  const sender = await senders.limit(1).executeTakeFirst();
  if (sender === undefined) return { outcome: 'refused', reason: 'no_mailbox' };
  return { identity, accountId: sender.id };
}

const checkInput = emailInput.pick({ contactId: true, to: true, mailboxId: true });

/**
 * Whether an email to this address of the contact would be taken now, before the caller
 * does the work of writing it: undefined when it would (sent at once or held for later),
 * else the refusal. Queueing decides again.
 */
export async function checkContactEmail(
  trx: DatabaseTransaction,
  context: TenantContext,
  input: z.input<typeof checkInput>,
): Promise<Refused | undefined> {
  const email = parseInput(checkInput, input);
  const resolved = await resolve(trx, requireBusiness(context), email);
  if ('outcome' in resolved) return resolved;
  const decision = await readOutboundPolicy(trx, {
    identityId: resolved.identity.id,
    accountId: resolved.accountId,
    channel: 'email',
    purpose: 'transactional',
  });
  if (decision.action !== 'refuse') return undefined;
  return {
    outcome: 'refused',
    reason: decision.reason,
    ...(decision.reason === 'suppressed'
      ? { detail: decision.suppressionReason }
      : 'scope' in decision
        ? { detail: decision.scope }
        : {}),
  };
}

/** Call inside an authorized command's tenant transaction, after holdContactEmail. */
export async function queueContactEmail(
  trx: DatabaseTransaction,
  context: TenantContext,
  input: ContactEmailInput,
): Promise<ContactEmailResult> {
  const email = parseInput(emailInput, input);
  const businessId = requireBusiness(context);
  const resolved = await resolve(trx, businessId, email);
  if ('outcome' in resolved) return resolved;
  const { identity } = resolved;
  const sender = { id: resolved.accountId };

  const attachments = email.attachments.map((fileId) => parsePublicId('file', fileId));
  if (attachments.some((fileId) => fileId === undefined))
    throw new TypeError('An attachment is named by a file id.');
  const earlier = await trx
    .selectFrom('messaging.messages')
    .select('id')
    .where('business_id', '=', businessId)
    .where('idempotency_key', '=', email.idempotencyKey)
    .executeTakeFirst();
  const messageId = await queueOutboundMessage(trx, context, {
    identityId: identity.id,
    accountId: sender.id,
    channel: 'email',
    purpose: 'transactional',
    lane: 'transactional',
    idempotencyKey: email.idempotencyKey,
    subject: email.subject,
    text: email.text,
    ...(attachments.length === 0
      ? {}
      : { attachments: attachments.filter((fileId) => fileId !== undefined) }),
  });
  const message = await trx
    .selectFrom('messaging.messages')
    .select([
      'conversation_id',
      'status',
      'error_code',
      'error_detail',
      sql<boolean>`coalesce(scheduled_for > now(), false)`.as('deferred'),
    ])
    .where('id', '=', messageId)
    .executeTakeFirstOrThrow();
  if (message.status === 'failed' && isRefusal(message.error_code))
    return {
      outcome: 'refused',
      reason: message.error_code,
      ...(message.error_detail === null ? {} : { detail: message.error_detail }),
    };
  // A status the pipeline gave it for a reason this file does not name is a bug to see.
  if (message.status === 'failed')
    throw new Error(`The outbound pipeline refused an email: ${message.error_code ?? 'unknown'}.`);
  return {
    outcome: 'queued',
    messageId: toPublicId('message', messageId),
    conversationId: toPublicId('conversation', message.conversation_id),
    to: identity.value_normalized,
    deferred: message.deferred,
    repeated: earlier !== undefined,
  };
}
