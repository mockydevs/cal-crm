// A conversation's thread: its messages on every channel with internal notes inline, and
// what the composer can send from and to. Bodies are returned as plain text only: a
// message's stored HTML never leaves through here.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  conversationChannels,
  messageHoldCodes,
  messageProblemCodes,
  messageStatuses,
  MESSAGE_TEXT_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  replyChannels,
  THREAD_PAGE_SIZE,
  threadItem,
  type ConversationComposer,
  type ConversationThread,
  type listConversationMessages,
  type ThreadItem,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { actorKinds, toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { readWebchatTarget, webchatDoNotDisturb } from './webchat-reply.js';

import {
  allows,
  requireConversation,
  readSendingAccounts,
  type ConversationRow,
  type InboxOptions,
} from './inbox-list.js';
import {
  boundText,
  decodeCursor,
  encodeCursor,
  heldReason,
  problemReason,
  replySubject,
  suggestedChannel,
  WEBCHAT_DO_NOT_DISTURB,
} from './inbox-rules.js';

function messages(trx: DatabaseTransaction, conversationId: string) {
  return trx
    .selectFrom('messaging.messages as m')
    .leftJoin('messaging.channel_accounts as a', (join) =>
      join.onRef('a.business_id', '=', 'm.business_id').onRef('a.id', '=', 'm.channel_account_id'),
    )
    .leftJoin('messaging.mailboxes as mailbox', (join) =>
      join.onRef('mailbox.business_id', '=', 'a.business_id').onRef('mailbox.id', '=', 'a.id'),
    )
    .leftJoin('messaging.phone_numbers as phone', (join) =>
      join.onRef('phone.business_id', '=', 'a.business_id').onRef('phone.id', '=', 'a.id'),
    )
    .select([
      'm.id',
      'm.direction',
      'm.channel',
      'm.channel_account_id',
      'a.name as account_name',
      'mailbox.email_address',
      'phone.e164',
      'm.author_kind',
      'm.author_id',
      'm.status',
      'm.error_code',
      'm.error_detail',
      'm.scheduled_for',
      'm.subject',
      'm.from_address',
      'm.to_addresses',
      'm.cc_addresses',
      'm.automated',
      'm.parent_message_id',
      'm.created_at',
      'm.sent_at',
      // Only as much of a very long message as a thread shows.
      sql<string>`left(m.body_text, ${MESSAGE_TEXT_MAX_LENGTH})`.as('text'),
      sql<boolean>`char_length(m.body_text) > ${MESSAGE_TEXT_MAX_LENGTH}`.as('longer'),
      sql<string>`to_char(m.created_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('position'),
    ])
    .where('m.conversation_id', '=', conversationId);
}

type MessageRow = Awaited<ReturnType<ReturnType<typeof messages>['executeTakeFirstOrThrow']>>;

async function attachmentsOf(trx: DatabaseTransaction, messageIds: readonly string[]) {
  const found = new Map<string, Extract<ThreadItem, { kind: 'message' }>['attachments']>();
  if (messageIds.length === 0) return found;
  const rows = await trx
    .selectFrom('messaging.message_attachments as attachment')
    .innerJoin('files.files as file', (join) =>
      join
        .onRef('file.business_id', '=', 'attachment.business_id')
        .onRef('file.id', '=', 'attachment.file_id'),
    )
    .select([
      'attachment.message_id',
      'attachment.content_id',
      'file.id',
      'file.filename',
      'file.content_type',
      'file.size_bytes',
    ])
    .where('attachment.message_id', 'in', [...messageIds])
    .where('file.deleted_at', 'is', null)
    .orderBy('attachment.id')
    .execute();
  for (const row of rows)
    found.set(row.message_id, [
      ...(found.get(row.message_id) ?? []),
      {
        id: toPublicId('file', row.id),
        name: row.filename,
        contentType: row.content_type,
        sizeBytes: Number(row.size_bytes),
        inline: row.content_id !== null,
      },
    ]);
  return found;
}

/** Each author's name, from the module that owns that kind of actor. */
async function authorNames(
  trx: DatabaseTransaction,
  rows: readonly MessageRow[],
  conversation: ConversationRow,
  options: InboxOptions,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  // The contact's own messages carry the conversation's contact.
  if (conversation.contact_name !== '')
    names.set(`contact:${conversation.contact_id}`, conversation.contact_name);
  for (const kind of actorKinds) {
    const lookup = options.actorNames[kind];
    const ids = [
      ...new Set(
        rows.flatMap((row) =>
          row.author_kind === kind && row.author_id !== null ? [row.author_id] : [],
        ),
      ),
    ];
    if (lookup !== undefined && ids.length > 0)
      for (const [id, name] of await lookup(trx, ids)) names.set(`${kind}:${id}`, name);
  }
  return names;
}

/** Messages as the API shows them. A note is a different shape: it has no delivery at all. */
async function presentMessages(
  trx: DatabaseTransaction,
  invocation: Invocation,
  conversation: ConversationRow,
  rows: readonly MessageRow[],
  options: InboxOptions,
): Promise<ThreadItem[]> {
  const names = await authorNames(trx, rows, conversation, options);
  const attachments = await attachmentsOf(
    trx,
    rows.flatMap((row) => (row.channel === 'note' ? [] : [row.id])),
  );
  return rows.map((row): ThreadItem => {
    // The table's own constraints allow no other kind of author, direction, channel or status.
    const kind = z.enum(actorKinds).parse(row.author_kind);
    const author = {
      kind,
      name: row.author_id === null ? null : (names.get(`${kind}:${row.author_id}`) ?? null),
      you:
        kind === 'user' &&
        invocation.context.actorKind === 'user' &&
        row.author_id === invocation.context.userId,
    };
    if (row.channel === 'note')
      return {
        kind: 'note',
        id: toPublicId('message', row.id),
        author,
        text: boundText(row.text, NOTE_MAX_LENGTH).text,
        createdAt: row.created_at.toISOString(),
      };
    const direction = z.enum(['inbound', 'outbound']).parse(row.direction);
    const channel = z.enum(conversationChannels).parse(row.channel);
    const status = z.enum(messageStatuses).parse(row.status);
    const body = boundText(row.text, MESSAGE_TEXT_MAX_LENGTH);
    const problem = problemReason(status, row.error_code, row.error_detail);
    const held = heldReason(status, row.error_code);
    return {
      kind: 'message',
      id: toPublicId('message', row.id),
      direction,
      channel,
      account:
        row.channel_account_id === null || row.account_name === null
          ? null
          : {
              id: toPublicId('channel_account', row.channel_account_id),
              name: row.account_name,
              address: row.email_address ?? row.e164,
            },
      author,
      status,
      problem:
        problem === null
          ? null
          : // The rules give only the reasons the contract lists (inbox-codes.test.ts).
            { code: z.enum(messageProblemCodes).parse(problem.code), message: problem.message },
      held:
        held === null
          ? null
          : {
              code: z.enum(messageHoldCodes).parse(held.code),
              message: held.message,
              until: row.scheduled_for?.toISOString() ?? null,
            },
      subject: row.subject,
      text: body.text,
      textTruncated: row.longer || body.truncated,
      from: row.from_address,
      to: row.to_addresses,
      cc: row.cc_addresses,
      automated: row.automated,
      replyTo: row.parent_message_id === null ? null : toPublicId('message', row.parent_message_id),
      attachments: attachments.get(row.id) ?? [],
      createdAt: row.created_at.toISOString(),
      sentAt: row.sent_at?.toISOString() ?? null,
    };
  });
}

/** One stored message of a conversation, as the thread shows it. */
export async function readThreadItem(
  trx: DatabaseTransaction,
  invocation: Invocation,
  conversation: ConversationRow,
  messageId: string,
  options: InboxOptions,
): Promise<ThreadItem> {
  const row = await messages(trx, conversation.id)
    .where('m.id', '=', messageId)
    .executeTakeFirstOrThrow();
  const items = await presentMessages(trx, invocation, conversation, [row], options);
  return threadItem.parse(items[0]);
}

export async function readThread(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  query: z.output<typeof listConversationMessages.query>,
  options: InboxOptions,
): Promise<ConversationThread> {
  requireBusiness(invocation.context);
  const conversation = await requireConversation(trx, id);
  let selection = messages(trx, conversation.id);
  if (query.before !== undefined) {
    const position = decodeCursor(query.before);
    if (position === undefined)
      throw new ValidationError([
        { path: '/before', code: 'unknown_cursor', message: 'Start before a page of this thread.' },
      ]);
    selection = selection.where(
      sql<boolean>`(m.created_at, m.id) < (${position.at}::timestamptz, ${position.id}::uuid)`,
    );
  }
  const rows = await selection
    .orderBy('m.created_at', 'desc')
    .orderBy('m.id', 'desc')
    .limit(THREAD_PAGE_SIZE + 1)
    .execute();
  const page = rows.slice(0, THREAD_PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: await presentMessages(trx, invocation, conversation, page, options),
    nextCursor:
      rows.length > THREAD_PAGE_SIZE && last !== undefined
        ? encodeCursor({ at: last.position, id: last.id })
        : null,
  };
}

const UNAVAILABLE = {
  channel_unavailable: "Text messages can't be sent: this install isn't set up to deliver them.",
  contact_inactive: 'This contact is in the trash.',
  no_account: {
    email: 'Connect a mailbox and use it for conversations in Settings.',
    sms: 'Connect a phone number in Settings.',
    webchat: 'The chat widget is turned off. Turn it on in Settings to answer.',
  },
  no_recipient: {
    email: 'This contact has no email address.',
    sms: 'This contact has no phone number.',
    webchat: 'This contact has not written through web chat.',
  },
  visitor_left: 'The visitor has left the chat, so a reply would reach nobody.',
} as const;

type ComposerChannel = ConversationComposer['channels'][number];

/**
 * What the composer offers for web chat: the widget the visitor wrote through and no
 * address, since the reply goes to that visitor's own chat while it is open.
 */
async function webchatChoice(
  trx: DatabaseTransaction,
  businessId: string,
  conversation: ConversationRow,
): Promise<ComposerChannel> {
  const chat = await readWebchatTarget(trx, conversation.id);
  const doNotDisturb =
    chat === undefined
      ? undefined
      : await webchatDoNotDisturb(trx, businessId, conversation.contact_id);
  // First whether anyone chatted here at all: a conversation nobody chatted in has no web
  // chat to answer, in the trash or not, and the Inbox leaves the channel out for it.
  const unavailable =
    chat === undefined
      ? { code: 'no_recipient' as const, message: UNAVAILABLE.no_recipient.webchat }
      : conversation.contact_trashed
        ? { code: 'contact_inactive' as const, message: UNAVAILABLE.contact_inactive }
        : doNotDisturb !== undefined
          ? { code: 'do_not_contact' as const, message: WEBCHAT_DO_NOT_DISTURB[doNotDisturb] }
          : chat.silence === 'visitor_left'
            ? { code: 'visitor_left' as const, message: UNAVAILABLE.visitor_left }
            : chat.silence === 'widget_off'
              ? { code: 'no_account' as const, message: UNAVAILABLE.no_account.webchat }
              : null;
  return {
    channel: 'webchat',
    available: unavailable === null,
    unavailable,
    accounts:
      chat === undefined || chat.silence === 'widget_off'
        ? []
        : [
            {
              id: toPublicId('channel_account', chat.widgetId),
              name: chat.widgetName,
              address: null,
            },
          ],
    recipients: [],
  };
}

/** What a reply can be sent from and to now. The reply command checks it all again. */
export async function readComposer(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  options: InboxOptions,
): Promise<ConversationComposer> {
  const businessId = requireBusiness(invocation.context);
  const conversation = await requireConversation(trx, id);
  // Offered only when the reply command would take it: a mailbox kept for campaigns, or a
  // number that can't send text messages now, is left out.
  const accounts = (await readSendingAccounts(trx)).filter(
    (account) =>
      account.status === 'active' &&
      (account.channel === 'email' ? account.for_conversations : account.sms_ready),
  );
  const identities = await trx
    .selectFrom('crm.contact_identities')
    .select(['id', 'kind', 'value_normalized', 'is_primary'])
    .where('contact_id', '=', conversation.contact_id)
    .where('kind', 'in', ['email', 'phone'])
    .orderBy('is_primary', 'desc')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const lastEmail = await trx
    .selectFrom('messaging.messages')
    .select('subject')
    .where('conversation_id', '=', conversation.id)
    .where('channel', '=', 'email')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  // What the contact last wrote on, whatever it was: the reply starts there if it can.
  const lastInbound = await trx
    .selectFrom('messaging.messages')
    .select('channel')
    .where('conversation_id', '=', conversation.id)
    .where('direction', '=', 'inbound')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const chat = await webchatChoice(trx, businessId, conversation);
  const channels = replyChannels.map((channel) => {
    if (channel === 'webchat') return chat;
    const from =
      channel === 'sms' && !options.smsAvailable
        ? []
        : accounts
            .filter((account) => account.channel === channel)
            .map((account) => ({
              id: toPublicId('channel_account', account.id),
              name: account.name,
              address: account.email_address ?? account.e164,
            }));
    const to = identities
      .filter((identity) => identity.kind === (channel === 'email' ? 'email' : 'phone'))
      .map((identity) => ({
        id: toPublicId('contact_identity', identity.id),
        address: identity.value_normalized,
        primary: identity.is_primary,
      }));
    const unavailable =
      channel === 'sms' && !options.smsAvailable
        ? { code: 'channel_unavailable' as const, message: UNAVAILABLE.channel_unavailable }
        : conversation.contact_trashed
          ? { code: 'contact_inactive' as const, message: UNAVAILABLE.contact_inactive }
          : from.length === 0
            ? { code: 'no_account' as const, message: UNAVAILABLE.no_account[channel] }
            : to.length === 0
              ? { code: 'no_recipient' as const, message: UNAVAILABLE.no_recipient[channel] }
              : null;
    return {
      channel,
      available: unavailable === null,
      unavailable,
      accounts: from,
      recipients: to,
    };
  });
  return {
    canReply: allows(invocation, 'conversations.reply'),
    channels,
    suggestedSubject: replySubject(lastEmail?.subject ?? null),
    suggestedChannel: suggestedChannel(lastInbound?.channel ?? null, channels),
  };
}
