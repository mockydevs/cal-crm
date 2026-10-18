// The Inbox's conversation list, one conversation, and the sidebar's counts.
import { createHash } from 'node:crypto';

import { requireBusiness, type Invocation } from '@repo/commands';
import {
  conversation,
  conversationChannels,
  messageStatuses,
  PREVIEW_MAX_LENGTH,
  INBOX_PAGE_SIZE,
  type Conversation,
  type ConversationAssigneeList,
  type ConversationList,
  type InboxSummary,
  type listConversationAssignees,
  type listConversations,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import type { ActorNames } from '@repo/module-crm';
import { sql } from 'kysely';
import * as z from 'zod';

import { decodeCursor, effectiveStatus, encodeCursor, previewOf } from './inbox-rules.js';

/** What the Inbox needs from the modules that own memberships, names and channels. */
export interface InboxOptions {
  readonly actorNames: ActorNames;
  /** Who a conversation can be assigned to: tenancy's rules for task assignees. */
  readonly assignees: {
    readonly resolve: (
      trx: DatabaseTransaction,
      context: TenantContext,
      selection: string | null,
    ) => Promise<string | null>;
    readonly read: (
      trx: DatabaseTransaction,
      context: TenantContext,
      after?: string,
    ) => Promise<{
      readonly items: readonly { readonly id: string; readonly userId: string }[];
      readonly nextCursor: string | null;
    }>;
    readonly memberships: (
      trx: DatabaseTransaction,
      context: TenantContext,
      userIds: readonly string[],
    ) => Promise<ReadonlyMap<string, string>>;
  };
  /** Whether this install can deliver text messages. Until it can, SMS replies are refused. */
  readonly smsAvailable: boolean;
}

/** Whether the caller's role allows managing conversations, or replying. */
export const allows = (
  invocation: Invocation,
  permission: 'conversations.manage' | 'conversations.reply',
): boolean => invocation.permissions === 'all' || invocation.permissions.has(permission);

// A snooze ends by itself, so "open" includes a snoozed conversation whose time has come.
const isOpen = sql<boolean>`(c.status = 'open' or (c.status = 'snoozed' and c.snoozed_until <= now()))`;
const activityAt = sql<Date>`coalesce(c.last_message_at, c.created_at)`;

function conversations(trx: DatabaseTransaction) {
  return trx
    .selectFrom('messaging.conversations as c')
    .innerJoin('crm.contacts as k', (join) =>
      join.onRef('k.business_id', '=', 'c.business_id').onRef('k.id', '=', 'c.contact_id'),
    )
    .select([
      'c.id',
      'c.contact_id',
      'c.status',
      'c.snoozed_until',
      'c.assignee_user_id',
      'c.needs_reply',
      'c.unread_count',
      'c.starred_at',
      activityAt.as('activity_at'),
      // Kept in PostgreSQL's precision: a Date would drop the microseconds a cursor needs.
      sql<string>`to_char(coalesce(c.last_message_at, c.created_at) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('position'),
      sql<string>`coalesce(k.display_name, (
        select i.value_normalized from crm.contact_identities i
        where i.business_id = k.business_id and i.contact_id = k.id and i.is_primary
        order by i.kind limit 1), '')`.as('contact_name'),
      sql<boolean>`k.deleted_at is not null`.as('contact_trashed'),
      sql<Date>`now()`.as('now'),
    ]);
}

/** A conversation as this module reads it, with its contact's name. */
export interface ConversationRow {
  readonly id: string;
  readonly contact_id: string;
  readonly status: string;
  readonly snoozed_until: Date | null;
  readonly assignee_user_id: string | null;
  readonly needs_reply: boolean;
  readonly unread_count: number;
  /** When the team starred it; null when it has no star (migration 0057). */
  readonly starred_at: Date | null;
  readonly activity_at: Date;
  /** The activity time in PostgreSQL's precision, for a cursor. */
  readonly position: string;
  /** Empty when the contact has neither a name nor a primary address. */
  readonly contact_name: string;
  readonly contact_trashed: boolean;
  /** The database's clock when the row was read. */
  readonly now: Date;
}

/** Changes when what a person decides on changes: status, snooze or assignment. */
function revisionOf(row: ConversationRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.id,
        row.status,
        row.snoozed_until?.toISOString() ?? null,
        row.assignee_user_id,
      ]),
    )
    .digest('hex');
}

/** A channel account, with what decides whether it can send a reply now. */
export interface SendingAccount {
  readonly id: string;
  readonly channel: string;
  readonly name: string;
  readonly status: string;
  readonly email_address: string | null;
  readonly e164: string | null;
  /** A mailbox the business uses for conversations. */
  readonly for_conversations: boolean;
  /** A number registered for text messages whose provider is connected. */
  readonly sms_ready: boolean;
}

/**
 * Channel accounts with what decides whether each can send a reply: a mailbox by its
 * conversations switch, a number by its text message capability and its provider's
 * connection, read as the delivery's own admission reads them (sms-send.ts).
 */
export function readSendingAccounts(
  trx: DatabaseTransaction,
  accountId?: string,
): Promise<SendingAccount[]> {
  let query = trx
    .selectFrom('messaging.channel_accounts as a')
    .leftJoin('messaging.mailboxes as mailbox', (join) =>
      join.onRef('mailbox.business_id', '=', 'a.business_id').onRef('mailbox.id', '=', 'a.id'),
    )
    .leftJoin('messaging.phone_numbers as phone', (join) =>
      join.onRef('phone.business_id', '=', 'a.business_id').onRef('phone.id', '=', 'a.id'),
    )
    .leftJoin('messaging.provider_connections as connection', (join) =>
      join
        .onRef('connection.id', '=', 'phone.provider_connection_id')
        // The number's own business must own the connection it names.
        .onRef('connection.business_id', '=', 'phone.business_id')
        .on('connection.provider', '=', 'twilio'),
    )
    .select([
      'a.id',
      'a.channel',
      'a.name',
      'a.status',
      'mailbox.email_address',
      'phone.e164',
      // Only a mailbox has the switch; an email account without one can't send.
      sql<boolean>`coalesce(mailbox.use_for_conversations, false)`.as('for_conversations'),
      sql<boolean>`coalesce('sms' = any(phone.capabilities) and connection.status = 'connected',
        false)`.as('sms_ready'),
    ])
    .orderBy('a.created_at')
    .orderBy('a.id');
  if (accountId !== undefined) query = query.where('a.id', '=', accountId);
  return query.execute();
}

/**
 * Takes the business before a conversation is held. The outbound worker holds the business
 * FOR UPDATE while a message's new status reaches its conversation, and a command's event
 * needs the business too (its foreign key, FOR KEY SHARE); taking it only then, with the
 * conversation already held, could deadlock with the worker. Commands don't block each
 * other on it.
 */
export async function holdBusiness(
  trx: DatabaseTransaction,
  context: TenantContext,
): Promise<void> {
  const businessId = requireBusiness(context);
  const business = await trx
    .selectFrom('tenancy.businesses')
    .select('id')
    .where('id', '=', businessId)
    .where('agency_id', '=', context.agencyId)
    .forKeyShare()
    .executeTakeFirst();
  if (business === undefined) throw new NotFoundError('business', businessId);
}

/** A conversation of this business, optionally held for a write. */
export async function requireConversation(
  trx: DatabaseTransaction,
  id: string,
  lock = false,
): Promise<ConversationRow> {
  const uuid = parsePublicId('conversation', id);
  if (uuid === undefined) throw new NotFoundError('Conversation', id);
  let query = conversations(trx).where('c.id', '=', uuid);
  if (lock) query = query.forUpdate('c');
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Conversation', id);
  return row;
}

/** Refuses a write made from a view that someone else has since changed. */
export function requireRevision(row: ConversationRow, revision: string): void {
  if (revisionOf(row) !== revision)
    throw new ConflictError('This conversation changed. Refresh it, then try again.');
}

async function lastMessages(trx: DatabaseTransaction, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, NonNullable<Conversation['lastMessage']>>();
  const rows = await trx
    .selectFrom('messaging.conversations as c')
    .innerJoinLateral(
      (eb) =>
        eb
          .selectFrom('messaging.messages as m')
          .select([
            'm.id as message_id',
            'm.direction',
            'm.channel',
            'm.status',
            'm.created_at',
            'm.subject',
            // A preview needs only the start of a long message.
            sql<string>`left(m.body_text, 2000)`.as('text'),
          ])
          .whereRef('m.business_id', '=', 'c.business_id')
          .whereRef('m.conversation_id', '=', 'c.id')
          // A note is the team's own: it never stands in for the conversation's last message.
          .where('m.direction', '<>', 'internal')
          .orderBy('m.created_at', 'desc')
          .orderBy('m.id', 'desc')
          .limit(1)
          .as('last'),
      (join) => join.onTrue(),
    )
    .select([
      'c.id',
      'last.message_id',
      'last.direction',
      'last.channel',
      'last.status',
      'last.created_at',
      'last.subject',
      'last.text',
    ])
    .where('c.id', 'in', [...ids])
    .execute();
  return new Map(
    rows.map((row) => {
      const text = previewOf(row.text, PREVIEW_MAX_LENGTH);
      return [
        row.id,
        {
          // What marking read from the list reads up to (bulkUpdateConversations).
          id: toPublicId('message', row.message_id),
          preview: text === '' ? previewOf(row.subject ?? '', PREVIEW_MAX_LENGTH) : text,
          // The table's own constraints allow nothing else for a message that isn't a note.
          direction: z.enum(['inbound', 'outbound']).parse(row.direction),
          channel: z.enum(conversationChannels).parse(row.channel),
          status: z.enum(messageStatuses).parse(row.status),
          at: row.created_at.toISOString(),
        },
      ];
    }),
  );
}

interface WebchatMark {
  readonly claimedContact: Conversation['claimedContact'];
}

/**
 * The conversations that came through web chat, and whose address each visitor claimed. A
 * conversation has at most one session, and a session that became a chat is never removed
 * (migration 0047), so the mark stays for as long as the conversation does.
 */
async function webchatMarks(
  trx: DatabaseTransaction,
  ids: readonly string[],
): Promise<Map<string, WebchatMark>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('messaging.webchat_sessions as s')
    .leftJoin('crm.contacts as k', (join) =>
      join.onRef('k.business_id', '=', 's.business_id').onRef('k.id', '=', 's.claimed_contact_id'),
    )
    .select([
      's.conversation_id',
      's.claimed_contact_id',
      sql<string>`coalesce(k.display_name, (
        select i.value_normalized from crm.contact_identities i
        where i.business_id = k.business_id and i.contact_id = k.id and i.is_primary
        order by i.kind limit 1), '')`.as('claimed_name'),
      sql<boolean>`k.deleted_at is not null`.as('claimed_trashed'),
    ])
    .where('s.conversation_id', 'in', [...ids])
    .execute();
  return new Map(
    rows.flatMap((row) =>
      row.conversation_id === null
        ? []
        : [
            [
              row.conversation_id,
              {
                claimedContact:
                  row.claimed_contact_id === null
                    ? null
                    : {
                        id: toPublicId('contact', row.claimed_contact_id),
                        name: row.claimed_name,
                        trashed: row.claimed_trashed,
                      },
              },
            ] as const,
          ],
    ),
  );
}

/** Conversations as the API shows them, with names from the modules that own them. */
export async function presentConversations(
  trx: DatabaseTransaction,
  invocation: Invocation,
  rows: readonly ConversationRow[],
  options: InboxOptions,
): Promise<Conversation[]> {
  const userIds = [
    ...new Set(
      rows.flatMap((row) => (row.assignee_user_id === null ? [] : [row.assignee_user_id])),
    ),
  ];
  const memberships = await options.assignees.memberships(trx, invocation.context, userIds);
  const lookup = options.actorNames.user;
  const names =
    lookup === undefined || userIds.length === 0
      ? new Map<string, string>()
      : await lookup(trx, userIds);
  const last = await lastMessages(
    trx,
    rows.map((row) => row.id),
  );
  const marks = await webchatMarks(
    trx,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const status = effectiveStatus(row.status, row.snoozed_until, row.now);
    return {
      id: toPublicId('conversation', row.id),
      contact: {
        id: toPublicId('contact', row.contact_id),
        name: row.contact_name,
        trashed: row.contact_trashed,
      },
      status,
      snoozedUntil: status === 'snoozed' ? (row.snoozed_until?.toISOString() ?? null) : null,
      assignee:
        row.assignee_user_id === null
          ? null
          : {
              membershipId: memberships.get(row.assignee_user_id) ?? null,
              name: names.get(row.assignee_user_id) ?? null,
              you:
                invocation.context.actorKind === 'user' &&
                row.assignee_user_id === invocation.context.userId,
            },
      needsReply: status === 'open' && row.needs_reply,
      unreadCount: row.unread_count,
      // Nothing a web chat visitor typed proves who they are.
      unverified: marks.has(row.id),
      claimedContact: marks.get(row.id)?.claimedContact ?? null,
      starred: row.starred_at !== null,
      lastActivityAt: row.activity_at.toISOString(),
      lastMessage: last.get(row.id) ?? null,
      canManage: allows(invocation, 'conversations.manage'),
      canReply: allows(invocation, 'conversations.reply'),
      revision: revisionOf(row),
    };
  });
}

export async function presentConversation(
  trx: DatabaseTransaction,
  invocation: Invocation,
  row: ConversationRow,
  options: InboxOptions,
): Promise<Conversation> {
  const presented = await presentConversations(trx, invocation, [row], options);
  return conversation.parse(presented[0]);
}

export async function readConversations(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof listConversations.query>,
  options: InboxOptions,
): Promise<ConversationList> {
  requireBusiness(invocation.context);
  let selection = conversations(trx);
  if (query.status === 'open') selection = selection.where(isOpen);
  if (query.status === 'snoozed')
    selection = selection
      .where('c.status', '=', 'snoozed')
      .where('c.snoozed_until', '>', sql<Date>`now()`);
  if (query.status === 'closed') selection = selection.where('c.status', '=', 'closed');
  if (query.assignee === 'unassigned')
    selection = selection.where('c.assignee_user_id', 'is', null);
  else if (query.assignee === 'me')
    selection =
      invocation.context.actorKind === 'user' && invocation.context.userId !== undefined
        ? selection.where('c.assignee_user_id', '=', invocation.context.userId)
        : selection.where(sql<boolean>`false`);
  else if (query.assignee !== 'anyone') {
    // Tenancy decides who is on this team; someone who isn't reads as an invalid choice.
    // A membership always resolves to its person, or is refused.
    const userId = z
      .uuid()
      .parse(await options.assignees.resolve(trx, invocation.context, query.assignee));
    selection = selection.where('c.assignee_user_id', '=', userId);
  }
  // Only an open conversation is waiting for a reply.
  if (query.reply === 'needed')
    selection = selection.where('c.needs_reply', '=', true).where(isOpen);
  if (query.unread === 'unread') selection = selection.where('c.unread_count', '>', 0);
  // The Starred tab: read from the index that holds starred conversations only (0057).
  if (query.starred === 'only') selection = selection.where('c.starred_at', 'is not', null);
  if (query.channel !== undefined) {
    const { channel } = query;
    selection = selection.where((eb) =>
      eb.exists(
        eb
          .selectFrom('messaging.messages as m')
          .select('m.id')
          .whereRef('m.business_id', '=', 'c.business_id')
          .whereRef('m.conversation_id', '=', 'c.id')
          .where('m.channel', '=', channel),
      ),
    );
  }
  if (query.contactId === undefined) selection = selection.where('k.deleted_at', 'is', null);
  else {
    // A contact this business doesn't have matches nothing, like any other filter.
    selection = selection.where(
      'c.contact_id',
      '=',
      z.uuid().parse(parsePublicId('contact', query.contactId)),
    );
  }
  if (query.after !== undefined) {
    const position = decodeCursor(query.after);
    if (position === undefined)
      throw new ValidationError([
        { path: '/after', code: 'unknown_cursor', message: 'Start after a page of this list.' },
      ]);
    // Where the earlier page ended, by value: a conversation that has moved to the top
    // since is not repeated, and the realtime refresh shows it there.
    selection = selection.where(
      sql<boolean>`(coalesce(c.last_message_at, c.created_at), c.id)
        < (${position.at}::timestamptz, ${position.id}::uuid)`,
    );
  }
  const rows = await selection
    .orderBy(activityAt, 'desc')
    .orderBy('c.id', 'desc')
    .limit(INBOX_PAGE_SIZE + 1)
    .execute();
  const page = rows.slice(0, INBOX_PAGE_SIZE);
  const last = page.at(-1);
  return {
    canManage: allows(invocation, 'conversations.manage'),
    canReply: allows(invocation, 'conversations.reply'),
    items: await presentConversations(trx, invocation, page, options),
    nextCursor:
      rows.length > INBOX_PAGE_SIZE && last !== undefined
        ? encodeCursor({ at: last.position, id: last.id })
        : null,
  };
}

export async function readConversation(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  options: InboxOptions,
): Promise<Conversation> {
  requireBusiness(invocation.context);
  return presentConversation(trx, invocation, await requireConversation(trx, id), options);
}

/** Who a conversation can be assigned to: tenancy's members, with names from auth. */
export async function readConversationAssignees(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof listConversationAssignees.query>,
  options: InboxOptions,
): Promise<ConversationAssigneeList> {
  requireBusiness(invocation.context);
  const page = await options.assignees.read(trx, invocation.context, query.after);
  const lookup = options.actorNames.user;
  const names =
    lookup === undefined || page.items.length === 0
      ? new Map<string, string>()
      : await lookup(trx, [...new Set(page.items.map((item) => item.userId))]);
  return {
    items: page.items.map((item) => ({
      id: item.id,
      name: names.get(item.userId) ?? null,
      you: invocation.context.actorKind === 'user' && item.userId === invocation.context.userId,
    })),
    nextCursor: page.nextCursor,
  };
}

/** The sidebar's counts: open conversations of contacts that aren't in the trash. */
export async function readInboxSummary(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<InboxSummary> {
  requireBusiness(invocation.context);
  const row = await trx
    .selectFrom('messaging.conversations as c')
    .innerJoin('crm.contacts as k', (join) =>
      join.onRef('k.business_id', '=', 'c.business_id').onRef('k.id', '=', 'c.contact_id'),
    )
    .select([
      sql<number>`(count(*) filter (where c.unread_count > 0))::integer`.as('unread_conversations'),
      sql<number>`coalesce(sum(c.unread_count), 0)::integer`.as('unread_messages'),
      sql<number>`(count(*) filter (where c.needs_reply))::integer`.as('needs_reply'),
    ])
    // The two partial indexes hold exactly these rows.
    .where((eb) => eb.or([eb('c.unread_count', '>', 0), eb('c.needs_reply', '=', true)]))
    .where(isOpen)
    .where('k.deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  return {
    unreadConversations: row.unread_conversations,
    unreadMessages: row.unread_messages,
    needsReply: row.needs_reply,
  };
}
