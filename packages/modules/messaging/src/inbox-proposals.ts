// What the Inbox lets an assistant propose, and what it shows an assistant of a
// conversation to draft a reply from.
//
// A proposal holds one of this module's own commands, with that command's input. Applying
// it runs the command through the command layer as the person who applies it: the reply
// command still checks the account, the address and the contact, and the outbound pipeline
// still decides consent, do-not-contact, quiet hours and limits. Nothing here sends.
//
// What an assistant is shown is one conversation: its contact, its messages without the
// team's internal notes, and where a reply would go. Every read here runs in the caller's
// tenant transaction, so row-level security holds it to the one business, and each is
// keyed by the one conversation.
import { defineProposable, type Invocation, type Proposable } from '@repo/commands';
import { conversationChannels, type ConversationChannel, type ReplyChannel } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { setConversationStatusCommand } from './inbox-commands.js';
import { requireConversation, type InboxOptions } from './inbox-list.js';
import { sendConversationReplyCommand } from './inbox-reply.js';
import { effectiveStatus } from './inbox-rules.js';
import { readComposer } from './inbox-thread.js';

/**
 * A fingerprint of a conversation's thread: the number of its newest message that is not
 * an internal note. A message from the contact, or a reply from anyone on the team, moves
 * it; a note does not.
 */
async function threadRevision(trx: DatabaseTransaction, conversationId: string): Promise<string> {
  const newest = await trx
    .selectFrom('messaging.messages')
    .select('seq')
    .where('conversation_id', '=', conversationId)
    .where('direction', '<>', 'internal')
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  return `thread:${newest?.seq ?? '0'}`;
}

/** The conversation's own row, as it is stored, without its contact. */
async function stateOf(trx: DatabaseTransaction, conversationId: string) {
  return trx
    .selectFrom('messaging.conversations')
    .select(['status', 'snoozed_until', sql<Date>`now()`.as('now')])
    .where('id', '=', conversationId)
    .executeTakeFirstOrThrow();
}

/**
 * The Inbox's commands an assistant may propose: a reply, and opening, snoozing or closing
 * a conversation. The inbox agent is the only assistant that works conversations.
 */
export function createInboxProposables(options: InboxOptions): readonly Proposable[] {
  const reply = sendConversationReplyCommand(options);
  const setStatus = setConversationStatusCommand(options);
  return [
    defineProposable({
      kind: 'reply',
      command: reply,
      agents: ['inbox'],
      async subject(trx, { id }) {
        const conversation = await requireConversation(trx, id);
        return { conversationId: conversation.id, contactId: conversation.contact_id };
      },
      // Made on the thread as it was: a new message from the contact, or a reply someone
      // else sent meanwhile, makes the draft an answer to a thread that has moved on.
      revision: async (trx, { id }) => threadRevision(trx, (await requireConversation(trx, id)).id),
      // Everything the composer chooses can be changed. The retry key stays the proposal's
      // own, whatever is sent with the changes, so applying twice never sends twice.
      change: (input, changes) => ({
        id: input.id,
        reply: { ...changes, idempotencyKey: input.reply.idempotencyKey },
      }),
      present: (_trx, { reply: content }) =>
        Promise.resolve({
          kind: 'reply',
          channel: content.channel,
          accountId: content.accountId,
          to: content.to,
          subject: content.subject,
          text: content.text,
        }),
      capture: () => Promise.resolve(null),
      result: (message) => ({ messageId: message.id }),
      // A reply the pipeline refused never left, so there is nothing to take back; one it
      // took is on its way, and a sent message cannot be unsent.
      undo: (_captured, message) => ({
        impossible: message.status === 'failed' ? 'not_sent' : 'message_sent',
      }),
    }),
    defineProposable({
      kind: 'conversation_status',
      command: setStatus,
      agents: ['inbox'],
      async subject(trx, { id }) {
        const conversation = await requireConversation(trx, id);
        return { conversationId: conversation.id, contactId: conversation.contact_id };
      },
      // The revision the command itself checks: it changes when a person assigns the
      // conversation or changes its status or snooze, and with nothing else.
      revision: (_trx, { change }) => Promise.resolve(change.revision),
      async present(trx, { id, change }) {
        const conversation = await requireConversation(trx, id);
        return {
          kind: 'conversation_status',
          from: effectiveStatus(conversation.status, conversation.snoozed_until, conversation.now),
          to: change.status,
          until: change.status === 'snoozed' ? new Date(change.until).toISOString() : null,
        };
      },
      async capture(trx, { id }) {
        const conversation = await requireConversation(trx, id);
        const state = await stateOf(trx, conversation.id);
        const status = effectiveStatus(state.status, state.snoozed_until, state.now);
        return {
          status,
          until: status === 'snoozed' ? (state.snoozed_until?.toISOString() ?? null) : null,
        };
      },
      result: () => ({}),
      // Back to how it was, from the conversation as the command left it: if someone
      // changes it again first, the command's own revision check refuses the undo.
      undo: (before, conversation, { id }) => ({
        kind: 'conversation_status',
        input: {
          id,
          change:
            before.status === 'snoozed' && before.until !== null
              ? { status: 'snoozed', until: before.until, revision: conversation.revision }
              : {
                  status: before.status === 'closed' ? 'closed' : 'open',
                  revision: conversation.revision,
                },
        },
      }),
    }),
  ];
}

/**
 * A conversation of the request's business by its public id, with its contact, or
 * undefined: what another module needs to hang something of its own on a conversation.
 */
export async function findConversation(
  trx: DatabaseTransaction,
  publicConversationId: string,
): Promise<{ readonly id: string; readonly contactId: string } | undefined> {
  const id = parsePublicId('conversation', publicConversationId);
  if (id === undefined) return undefined;
  const row = await trx
    .selectFrom('messaging.conversations')
    .select(['id', 'contact_id'])
    .where('id', '=', id)
    .executeTakeFirst();
  return row === undefined ? undefined : { id: row.id, contactId: row.contact_id };
}

/** How much of a conversation an assistant is shown. */
export const REPLY_CONTEXT_LIMITS = {
  /** The newest messages of the thread, notes left out. */
  messages: 20,
  /** The most characters of one message. */
  messageLength: 2000,
} as const;

export interface ReplyContextMessage {
  /** The message's stored id: the subject of the event that says it arrived or was sent. */
  readonly id: string;
  /** Its number in the conversation: a later message has a higher one. */
  readonly seq: number;
  /** Sent by a machine, such as an auto-reply or a bounce notice. */
  readonly automated: boolean;
  /** Who wrote it: the contact, or the business (a person, an automation or an assistant). */
  readonly from: 'contact' | 'business';
  readonly channel: ConversationChannel;
  readonly subject: string | null;
  /** Plain text, cut to REPLY_CONTEXT_LIMITS.messageLength. */
  readonly text: string;
  readonly at: Date;
}

/** One conversation, as an assistant is shown it to draft a reply. */
export interface ReplyContext {
  /** The conversation's stored id, and its contact's. */
  readonly conversationId: string;
  readonly contactId: string;
  /** The contact's given name, when they have one. */
  readonly contactFirstName: string | null;
  /** The contact's own language, as a BCP 47 tag, when it is known. */
  readonly contactLocale: string | null;
  /** The business's name, and its language as a BCP 47 tag. */
  readonly businessName: string;
  readonly businessLocale: string;
  /** Oldest first. */
  readonly messages: readonly ReplyContextMessage[];
  /** What the thread is waiting for, or why no draft is wanted. */
  readonly state:
    | 'needs_reply'
    /** The last message is the business's own: there is nothing new to answer. */
    | 'answered'
    /** The contact's last message was sent by a machine, such as an auto-reply. */
    | 'automated'
    /** The contact is in the trash or asked not to be contacted, or no channel can reply. */
    | 'cannot_reply';
  /** The thread's fingerprint: what a draft is made on. */
  readonly revision: string;
  /**
   * Where a reply would go by default, as the composer would choose: the channel the
   * contact last wrote on when it can send, the account they wrote to, and their address.
   */
  readonly reply: {
    readonly channel: ReplyChannel;
    readonly accountId: string;
    readonly to: string | null;
    readonly subject: string | null;
  } | null;
}

/**
 * Reads one conversation for an assistant, or undefined when it is not there to be read.
 * `conversationId` is the stored id, as a job carries it.
 */
export async function readReplyContext(
  trx: DatabaseTransaction,
  invocation: Invocation,
  conversationId: string,
  options: InboxOptions,
): Promise<ReplyContext | undefined> {
  const found = await trx
    .selectFrom('messaging.conversations as c')
    .innerJoin('crm.contacts as k', (join) =>
      join.onRef('k.business_id', '=', 'c.business_id').onRef('k.id', '=', 'c.contact_id'),
    )
    .innerJoin('tenancy.businesses as b', 'b.id', 'c.business_id')
    .select([
      'c.id',
      'c.contact_id',
      'k.first_name',
      'k.locale as contact_locale',
      'k.do_not_contact',
      sql<boolean>`k.deleted_at is not null`.as('trashed'),
      'b.name as business_name',
      'b.locale as business_locale',
    ])
    .where('c.id', '=', conversationId)
    .executeTakeFirst();
  if (found === undefined) return undefined;

  const rows = await trx
    .selectFrom('messaging.messages')
    .select([
      'id',
      'seq',
      'direction',
      'channel',
      'channel_account_id',
      'from_address',
      'subject',
      'automated',
      'created_at',
      sql<string>`left(body_text, ${REPLY_CONTEXT_LIMITS.messageLength})`.as('text'),
    ])
    .where('conversation_id', '=', found.id)
    // Internal notes are the team's own words to each other: an assistant that never
    // reads them can never repeat them to the contact.
    .where('direction', '<>', 'internal')
    .orderBy('seq', 'desc')
    .limit(REPLY_CONTEXT_LIMITS.messages)
    .execute();
  const newest = rows[0];
  const lastInbound = rows.find((row) => row.direction === 'inbound');

  const composer = await readComposer(
    trx,
    invocation,
    toPublicId('conversation', found.id),
    options,
  );
  const offered = composer.channels.find(
    (each) => each.channel === composer.suggestedChannel && each.available,
  );
  // The account the contact wrote to, and the address they wrote from, when the reply
  // goes back the way their message came; otherwise the first the composer offers.
  const wroteTo =
    lastInbound?.channel_account_id === null || lastInbound?.channel_account_id === undefined
      ? undefined
      : toPublicId('channel_account', lastInbound.channel_account_id);
  const account =
    offered?.accounts.find(
      (each) => lastInbound?.channel === offered.channel && each.id === wroteTo,
    ) ?? offered?.accounts[0];
  const recipient =
    offered?.recipients.find(
      (each) =>
        lastInbound?.channel === offered.channel && each.address === lastInbound.from_address,
    ) ?? offered?.recipients[0];
  const reply =
    offered === undefined ||
    account === undefined ||
    (offered.channel !== 'webchat' && recipient === undefined)
      ? null
      : {
          channel: offered.channel,
          accountId: account.id,
          to: offered.channel === 'webchat' ? null : (recipient?.id ?? null),
          subject: offered.channel === 'email' ? composer.suggestedSubject : null,
        };

  const state: ReplyContext['state'] =
    found.trashed || found.do_not_contact || reply === null
      ? 'cannot_reply'
      : newest?.direction !== 'inbound'
        ? 'answered'
        : newest.automated
          ? 'automated'
          : 'needs_reply';

  return {
    conversationId: found.id,
    contactId: found.contact_id,
    contactFirstName: found.first_name,
    contactLocale: found.contact_locale,
    businessName: found.business_name,
    businessLocale: found.business_locale,
    messages: rows.reverse().map((row) => ({
      id: row.id,
      // A conversation's own count of its messages: far inside what a number holds.
      seq: Number(row.seq),
      automated: row.automated,
      from: row.direction === 'inbound' ? 'contact' : 'business',
      // The table's own constraints allow no other channel for a message that isn't a note.
      channel: z.enum(conversationChannels).parse(row.channel),
      subject: row.subject,
      text: row.text,
      at: row.created_at,
    })),
    state,
    revision: await threadRevision(trx, found.id),
    reply,
  };
}
