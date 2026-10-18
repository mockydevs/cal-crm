// A verified inbound SMS: stored as a message in the sender's conversation, and, when the
// whole message is STOP, START or HELP (sms-keywords.ts), acted on.
//
// STOP withdraws the contact's SMS consent for marketing and for transactional messages,
// in the consent ledger, with the keyword and the message as proof. The outbound policy
// reads the ledger at dispatch, so the next send is refused, including one already queued.
// Twilio also blocks the number itself (error 21610), but that block is Twilio's and
// covers one sender; the ledger is ours and covers the business.
// START gives back only what a keyword took away: a purpose whose latest entry is a
// withdrawal by keyword. It never creates consent nobody had.
// HELP changes no consent. It is reported as an event, and no reply is sent from here:
// Twilio answers HELP itself on the numbers it handles keywords for.
//
// A message from a number under inbound do not disturb (inbound-dnd.ts) is not stored: it
// opens no conversation, tells nobody and starts no automation. Of a keyword in one, only
// what compliance needs is done (blockedKeyword): opting out is the contact's right
// whatever the business blocks.
import { defineCommand, requireBusiness, type Command, type CommandContext } from '@repo/commands';
import { createContactInput } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ForbiddenError, ValidationError } from '@repo/kernel';
import { createContact } from '@repo/module-crm';
import { sql } from 'kysely';
import * as z from 'zod';

import { recordConsent } from './consent-record.js';
import { latestConsentFirst, lockAddressConsent, lockContactConsent } from './consent-state.js';
import { inboundDoNotDisturbFrom } from './inbound-dnd.js';
import { finishSmsWebhook, verifiedSmsWebhook } from './sms-intake.js';
import { keywordText, smsKeyword, type SmsKeyword } from './sms-keywords.js';

const E164 = /^\+[1-9][0-9]{6,14}$/;
const PURPOSES = ['marketing', 'transactional'] as const;

const receiveInput = z.strictObject({
  webhookId: z.uuid(),
  accountSid: z.string(),
  messageSid: z.string().regex(/^(SM|MM)[0-9a-fA-F]{32}$/),
  from: z.string().max(100),
  to: z.string().max(100),
  body: z.string().max(10_000),
  optOutType: z.string().max(40).nullable(),
});

export type ReceiveSmsOutcome =
  | { readonly outcome: 'stored'; readonly messageId: string; readonly keyword: SmsKeyword | null }
  /** This Twilio message is already stored: a repeated or replayed webhook. */
  | { readonly outcome: 'duplicate'; readonly messageId: string }
  /** Not verified, or not for a number this connection has registered. Nothing changed. */
  | { readonly outcome: 'ignored' }
  /**
   * From a number under inbound do not disturb. Nothing was stored; a STOP or START in it
   * changed consent.
   */
  | { readonly outcome: 'blocked' };

/** The sender's contact, created when the number belongs to nobody in the business yet. */
async function senderContact(
  trx: DatabaseTransaction,
  command: CommandContext,
  from: string,
): Promise<string | null> {
  const find = () =>
    trx
      .selectFrom('crm.contact_identities')
      .select('contact_id')
      .where('kind', '=', 'phone')
      .where('value_normalized', '=', from)
      .executeTakeFirst();
  const known = await find();
  if (known !== undefined) return known.contact_id;
  const input = createContactInput.safeParse({ phones: [from] });
  if (!input.success) return null;
  try {
    // The CRM's own command keeps its invariants: identities, timeline and contact.created.
    await createContact(trx, input.data, command, 'sms');
  } catch (failure) {
    // A number the CRM doesn't accept as a phone number is refused before it writes anything.
    if (!(failure instanceof ValidationError)) throw failure;
    return null;
  }
  return (await find())?.contact_id ?? null;
}

/** STOP or START: the consent change a keyword makes, with the message it came in as proof. */
async function applyKeyword(
  trx: DatabaseTransaction,
  command: CommandContext,
  businessId: string,
  keyword: Exclude<SmsKeyword, 'help'>,
  proof: {
    contactId: string;
    /** The number the keyword came from: the change is that number's. */
    address: string;
    /** The stored message; none for one inbound do not disturb kept out. */
    messageId: string | undefined;
    messageSid: string;
    word: string;
  },
): Promise<void> {
  const { contactId, address, messageId, messageSid } = proof;
  const message =
    messageId === undefined
      ? { providerMessageId: messageSid }
      : { messageId, providerMessageId: messageSid };
  const evidence = { source: 'keyword', keyword: proof.word, ...message } as const;
  const contact = await trx
    .selectFrom('crm.contacts')
    .select('deleted_at')
    .where('id', '=', contactId)
    .executeTakeFirst();
  for (const purpose of PURPOSES) {
    // A contact in the trash can still say STOP, and it must hold if they are restored.
    // recordConsent refuses a deleted contact, so that one case is written here, in the
    // same form and without the timeline event.
    if (contact?.deleted_at !== null) {
      if (keyword === 'stop')
        await trx
          .insertInto('messaging.consents')
          .values({
            business_id: businessId,
            contact_id: contactId,
            channel: 'sms',
            purpose,
            status: 'withdrawn',
            address_normalized: address,
            source: 'keyword',
            proof: sql`${JSON.stringify({ keyword: proof.word, ...message })}::jsonb`,
            recorded_at: sql`clock_timestamp()`,
            recorded_by_kind: 'contact',
            recorded_by_id: contactId,
          })
          .execute();
      continue;
    }
    if (keyword === 'start') {
      // Held from the check to the entry, so a withdrawal can't slip between them.
      await lockContactConsent(trx, contactId);
      await lockAddressConsent(trx, businessId, 'sms', address);
      // START undoes only a STOP: the latest change that counts for this number must be a
      // keyword's withdrawal (the rule in consent-state.ts).
      const {
        rows: [latest],
      } = await sql<{ status: string; source: string }>`
        select status, source from (
          (select status, source, recorded_at, id from messaging.consents
            where business_id = ${businessId}::uuid and contact_id = ${contactId}::uuid
              and channel = 'sms' and purpose = ${purpose}
              and (status = 'withdrawn' or address_normalized is null or address_normalized = ${address})
            order by ${latestConsentFirst} limit 1)
          union all
          (select status, source, recorded_at, id from messaging.consents
            where business_id = ${businessId}::uuid and address_normalized = ${address}
              and channel = 'sms' and purpose = ${purpose} and status = 'withdrawn'
            order by ${latestConsentFirst} limit 1)
        ) latest order by ${latestConsentFirst} limit 1
      `.execute(trx);
      if (latest?.status !== 'withdrawn' || latest.source !== 'keyword') continue;
    }
    await recordConsent(trx, command, {
      contactId,
      channel: 'sms',
      purpose,
      status: keyword === 'stop' ? 'withdrawn' : 'granted',
      address,
      evidence,
    });
  }
}

/** The keyword itself, as the proof keeps it: Twilio's verdict when it gave one. */
const keywordWord = (
  input: { readonly body: string; readonly optOutType: string | null },
  keyword: SmsKeyword,
): string =>
  // Never a whole message.
  (input.optOutType ?? keywordText(input.body)).slice(0, 40) || keyword;

/**
 * A message inbound do not disturb keeps out does only what compliance needs. STOP and
 * START change consent, with the message's SID as proof; nothing is stored in the
 * conversation, nobody is told and nothing starts. HELP changes no consent, so nothing is
 * kept of it. No reply is sent from here for any of them, as for anyone: Twilio answers
 * the keywords itself. The same keyword delivered again changes nothing more.
 */
async function blockedKeyword(
  trx: DatabaseTransaction,
  command: CommandContext,
  businessId: string,
  input: z.output<typeof receiveInput>,
  keyword: SmsKeyword | null,
): Promise<void> {
  if (keyword === null || keyword === 'help') return;
  const kept = await trx
    .selectFrom('messaging.consents')
    .select('id')
    .where('business_id', '=', businessId)
    .where('channel', '=', 'sms')
    .where(sql<boolean>`proof ->> 'providerMessageId' = ${input.messageSid}`)
    .executeTakeFirst();
  if (kept !== undefined) return;
  // A number inbound do not disturb blocks is a contact's already: nobody new is made.
  const holder = await trx
    .selectFrom('crm.contact_identities')
    .select('contact_id')
    .where('business_id', '=', businessId)
    .where('kind', '=', 'phone')
    .where('value_normalized', '=', input.from)
    .executeTakeFirst();
  if (holder === undefined) return;
  await applyKeyword(trx, command, businessId, keyword, {
    contactId: holder.contact_id,
    address: input.from,
    messageId: undefined,
    messageSid: input.messageSid,
    word: keywordWord(input, keyword),
  });
}

/**
 * Stores one verified inbound SMS and acts on its keyword, all or nothing. Only the
 * worker's system actor runs it. The Twilio Message SID makes it safe to repeat: a
 * message already stored is left alone, and so is everything it caused.
 */
export const receiveSmsCommand: Command<typeof receiveInput, ReceiveSmsOutcome> = defineCommand({
  name: 'sms.receive',
  permission: 'sms.manage',
  input: receiveInput,
  // Identifiers only: no number and no text reaches the audit log.
  audit: ({ webhookId, messageSid }) => ({ webhookId, messageSid }),
  async handle(trx, input, command): Promise<ReceiveSmsOutcome> {
    if (command.context.actorKind !== 'system')
      throw new ForbiddenError('Only the SMS worker records inbound messages.');
    const businessId = requireBusiness(command.context);
    // Taken first, as queueing and dispatch do: a send waits for this withdrawal, or this
    // waits for a send that then went out before the STOP was known.
    await trx
      .selectFrom('tenancy.businesses')
      .select('id')
      .where('id', '=', businessId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const webhook = await verifiedSmsWebhook(trx, businessId, input.webhookId);
    if (webhook === undefined) return { outcome: 'ignored' };
    const ignore = async (note: string): Promise<ReceiveSmsOutcome> => {
      await finishSmsWebhook(trx, businessId, webhook.id, note);
      return { outcome: 'ignored' };
    };
    if (input.accountSid !== webhook.accountSid) return ignore('account_mismatch');
    // The number it was sent to must be one this business registered on this connection.
    const number = await trx
      .selectFrom('messaging.phone_numbers')
      .select('id')
      .where('business_id', '=', businessId)
      .where('e164', '=', input.to)
      .where('provider_connection_id', '=', webhook.connectionId)
      .executeTakeFirst();
    if (number === undefined) return ignore('number_not_registered');
    // Twilio sends E.164 "if possible"; a sender it couldn't normalise can't be a contact.
    if (!E164.test(input.from)) return ignore('sender_unresolved');

    const stored = await trx
      .selectFrom('messaging.messages')
      .select('id')
      .where('channel_account_id', '=', number.id)
      .where('provider_message_id', '=', input.messageSid)
      .executeTakeFirst();
    if (stored !== undefined) {
      await finishSmsWebhook(trx, businessId, webhook.id, null);
      return { outcome: 'duplicate', messageId: stored.id };
    }

    const keyword = smsKeyword(input.body, input.optOutType ?? undefined);
    if (await inboundDoNotDisturbFrom(trx, businessId, input.from)) {
      await blockedKeyword(trx, command, businessId, input, keyword);
      await finishSmsWebhook(trx, businessId, webhook.id, 'inbound_dnd');
      return { outcome: 'blocked' };
    }

    // Unknown senders are looked up and created one at a time per business (as inbound
    // email does), so two webhooks can't create the same contact at once.
    await sql`select pg_advisory_xact_lock(hashtextextended(${`inbound-senders:${businessId}`}, 0))`.execute(
      trx,
    );
    const contactId = await senderContact(trx, command, input.from);
    if (contactId === null) return ignore('sender_unresolved');
    const conversation = await trx
      .insertInto('messaging.conversations')
      .values({ business_id: businessId, contact_id: contactId })
      .onConflict((oc) =>
        oc.columns(['business_id', 'contact_id']).doUpdateSet({ contact_id: contactId }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    const message = await trx
      .insertInto('messaging.messages')
      .values({
        business_id: businessId,
        conversation_id: conversation.id,
        channel: 'sms',
        channel_account_id: number.id,
        direction: 'inbound',
        status: 'received',
        body_text: input.body,
        from_address: input.from,
        to_addresses: [input.to],
        provider_message_id: input.messageSid,
        author_kind: 'contact',
        author_id: contactId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // A new message reopens the conversation, and wakes a snoozed one.
    await trx
      .updateTable('messaging.conversations')
      .set((eb) => ({
        status: 'open',
        snoozed_until: null,
        needs_reply: true,
        unread_count: eb('unread_count', '+', 1),
        last_message_at: sql<Date>`now()`,
        last_inbound_at: sql<Date>`now()`,
      }))
      .where('id', '=', conversation.id)
      .execute();
    await command.emit({
      type: 'message.received',
      subject: { kind: 'message', id: message.id },
      payload: {
        conversationId: conversation.id,
        channel: 'sms',
        phoneNumberId: number.id,
        keyword,
      },
      records: [contactId],
    });
    if (keyword === 'help')
      await command.emit({
        type: 'sms.help_requested',
        subject: { kind: 'message', id: message.id },
        records: [contactId],
      });
    else if (keyword !== null)
      await applyKeyword(trx, command, businessId, keyword, {
        contactId,
        address: input.from,
        messageId: message.id,
        messageSid: input.messageSid,
        word: keywordWord(input, keyword),
      });
    await finishSmsWebhook(trx, businessId, webhook.id, null);
    await sql`select pg_notify('crm_business_changed', ${businessId})`.execute(trx);
    return { outcome: 'stored', messageId: message.id, keyword };
  },
});
