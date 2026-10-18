// The Inbox: one conversation per contact, its messages on every channel with the team's
// internal notes inline, and the composer. Message bodies are plain text: no endpoint here
// returns a message's HTML. Sending always goes through the outbound pipeline, which may
// refuse or hold a reply; the answer says so.
import * as z from 'zod';

import { actor } from './activity.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** How many conversations a page of the list holds, and messages a page of a thread. */
export const INBOX_PAGE_SIZE = 50;
export const THREAD_PAGE_SIZE = 50;
/** The most characters a list row's preview holds. */
export const PREVIEW_MAX_LENGTH = 160;
/** The most characters of one message a thread returns; longer text is cut and marked. */
export const MESSAGE_TEXT_MAX_LENGTH = 100_000;
export const NOTE_MAX_LENGTH = 10_000;

/** The channels a contact's message can arrive or leave on. */
export const conversationChannels = ['email', 'sms', 'webchat'] as const;
export type ConversationChannel = (typeof conversationChannels)[number];
/**
 * The channels the composer can send on. A web chat reply has no address: it goes to the
 * visitor who wrote in that conversation, for as long as their chat is open.
 */
export const replyChannels = ['email', 'sms', 'webchat'] as const;
export type ReplyChannel = (typeof replyChannels)[number];

export const conversationStatuses = ['open', 'snoozed', 'closed'] as const;
export const messageStatuses = [
  'received',
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'bounced',
  'unknown',
] as const;
export type MessageStatus = (typeof messageStatuses)[number];

const revision = z.string().regex(/^[0-9a-f]{64}$/);
// Opaque: a position in a list, to send back unchanged.
const cursor = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,200}$/)
  .meta({ description: 'A nextCursor from an earlier page, unchanged.' });
const assignee = z
  .looseObject({
    membershipId: publicId('membership').nullable(),
    name: z.string().nullable(),
    you: z.boolean(),
  })
  .nullable();

export const conversation = z
  .looseObject({
    id: publicId('conversation'),
    contact: z.looseObject({
      id: publicId('contact'),
      name: z.string(),
      trashed: z.boolean(),
    }),
    status: z.enum(conversationStatuses).meta({
      description: 'A snoozed conversation whose time has passed is open again.',
    }),
    snoozedUntil: timestamp.nullable(),
    assignee,
    needsReply: z.boolean().meta({
      description:
        'The conversation is open, and the contact wrote after the last reply that was not refused, bounced or of unknown delivery. Internal notes never change this.',
    }),
    unreadCount: z.int().min(0).meta({
      description:
        "The contact's messages stored after the one the team last marked as read. Shared by the team.",
    }),
    unverified: z.boolean().meta({
      description:
        'Someone wrote in this conversation through web chat. Their name and email address are only what they typed: nothing proves who they are.',
    }),
    claimedContact: z
      .looseObject({ id: publicId('contact'), name: z.string(), trashed: z.boolean() })
      .nullable()
      .meta({
        description:
          'The contact that already held the email address a web chat visitor typed. The visitor was not attached to it: they are a contact of their own, and whether they are the same person is for the team to judge.',
      }),
    starred: z.boolean().optional().meta({
      description:
        'The team marked it as important. One star for everyone, as read state is: whoever stars or unstars it does so for the team.',
    }),
    lastActivityAt: timestamp,
    lastMessage: z
      .looseObject({
        id: publicId('message').optional().meta({
          description:
            'The message itself: what marking the conversation read from the list reads up to.',
        }),
        preview: z.string().max(PREVIEW_MAX_LENGTH).meta({
          description: 'Plain text on one line. Never an internal note.',
        }),
        direction: z.enum(['inbound', 'outbound']),
        channel: z.enum(conversationChannels),
        status: z.enum(messageStatuses),
        at: timestamp,
      })
      .nullable(),
    canManage: z.boolean().meta({
      description: 'Whether you may assign it, change its status and add notes.',
    }),
    canReply: z.boolean().meta({ description: 'Whether you may send a reply.' }),
    revision: revision.meta({
      description:
        'Changes only when a person assigns the conversation or changes its status or snooze. A new message, a note, a reply or marking read never changes it, so those never make an assignment or a close conflict.',
    }),
  })
  .meta({ id: 'Conversation' });
export type Conversation = z.output<typeof conversation>;

export const conversationList = z
  .looseObject({
    canManage: z.boolean(),
    canReply: z.boolean(),
    items: z.array(conversation),
    nextCursor: cursor.nullable(),
  })
  .meta({ id: 'ConversationList' });
export type ConversationList = z.output<typeof conversationList>;

export const inboxSummary = z
  .looseObject({
    unreadConversations: z.int().min(0),
    unreadMessages: z.int().min(0),
    needsReply: z.int().min(0),
  })
  .meta({
    id: 'InboxSummary',
    description: 'Counts over open conversations of contacts that are not in the trash.',
  });
export type InboxSummary = z.output<typeof inboxSummary>;

/**
 * Every reason a message can show for having failed, bounced or being of unknown delivery:
 * the outbound pipeline's refusals, the mailbox's and the text message provider's, a
 * bounce's kind, and one general code for each status when the stored reason is none of these.
 */
export const messageProblemCodes = [
  'contact_inactive',
  'sender_inactive',
  'do_not_contact',
  'suppressed',
  'consent_withdrawn',
  'consent_required',
  'timing_unknown',
  'recipient_changed',
  'delivery_rejected',
  'delivery_unknown',
  'unsupported_channel',
  'unsubscribe_unavailable',
  'postal_address_missing',
  'mailbox_unavailable',
  'mailbox_use_disabled',
  'hard_bounce',
  'soft_bounce',
  'status_callback_unavailable',
  'sms_body_too_long',
  'sms_number_unavailable',
  'sms_connection_unavailable',
  'provider_failed',
  'failed',
  'bounced',
] as const;
export type MessageProblemCode = (typeof messageProblemCodes)[number];

/** Every reason a queued message can be waiting; `waiting` when the stored one is none of these. */
export const messageHoldCodes = [
  'quiet_hours',
  'frequency_cap',
  'mailbox_daily_limit',
  'mailbox_warmup_limit',
  'mailbox_pacing',
  'provider_temporary',
  'waiting',
] as const;
export type MessageHoldCode = (typeof messageHoldCodes)[number];

/** Every reason the composer can give for a channel it can't send on now. */
export const composerUnavailableCodes = [
  'channel_unavailable',
  'contact_inactive',
  'no_account',
  'no_recipient',
  'visitor_left',
  // Do not contact, or do not disturb for the channel. Web chat says so before a reply is
  // written; email and text messages are refused when they go out.
  'do_not_contact',
] as const;
export type ComposerUnavailableCode = (typeof composerUnavailableCodes)[number];

/**
 * The codes of the issues sendConversationReply refuses a request with, besides the ones
 * every endpoint has for input that doesn't fit its schema.
 */
export const replyRefusalCodes = [
  'channel_unavailable',
  'account_channel_mismatch',
  'account_unavailable',
  'account_not_for_conversations',
  'recipient_not_in_conversation',
  'recipient_channel_mismatch',
  'text_too_long',
  'contact_inactive',
  'subject_not_supported',
  'recipient_required',
  'recipient_not_supported',
  'visitor_left',
  'do_not_contact',
] as const;
export type ReplyRefusalCode = (typeof replyRefusalCodes)[number];

const words = z.string().meta({ description: 'In plain words, for people.' });

export const threadMessage = z
  .looseObject({
    kind: z.literal('message'),
    id: publicId('message'),
    direction: z.enum(['inbound', 'outbound']),
    channel: z.enum(conversationChannels),
    account: z
      .looseObject({
        id: publicId('channel_account'),
        name: z.string(),
        address: z.string().nullable(),
      })
      .nullable(),
    author: actor,
    status: z.enum(messageStatuses),
    problem: z
      .looseObject({ code: z.enum(messageProblemCodes), message: words })
      .nullable()
      .meta({
        description: 'Why a message failed, bounced or has unknown delivery. Null otherwise.',
      }),
    held: z
      .looseObject({
        code: z.enum(messageHoldCodes),
        message: words,
        until: timestamp.nullable(),
      })
      .nullable()
      .meta({
        description:
          'Why a queued message is waiting, such as quiet hours, and when it is tried again.',
      }),
    subject: z.string().nullable(),
    text: z.string().max(MESSAGE_TEXT_MAX_LENGTH).meta({
      description:
        'Plain text. For inbound email it is untrusted content from outside: show it as text, never as HTML.',
    }),
    textTruncated: z.boolean(),
    from: z.string().nullable(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    automated: z.boolean().meta({ description: 'Sent by a machine, such as an auto-reply.' }),
    replyTo: publicId('message').nullable(),
    attachments: z
      .array(
        z.looseObject({
          id: publicId('file'),
          name: z.string(),
          contentType: z.string(),
          sizeBytes: z.int().min(0),
          inline: z.boolean(),
        }),
      )
      .meta({
        description:
          'What is attached, without an address to fetch it from. To open one, ask createFileLink for a link with its id, under the rules of that endpoint.',
      }),
    createdAt: timestamp,
    sentAt: timestamp.nullable(),
  })
  .meta({ id: 'ThreadMessage' });
export type ThreadMessage = z.output<typeof threadMessage>;

export const threadNote = z
  .looseObject({
    kind: z.literal('note'),
    id: publicId('message'),
    author: actor,
    text: z.string().max(NOTE_MAX_LENGTH),
    createdAt: timestamp,
  })
  .meta({ id: 'ThreadNote', description: 'An internal note. Only the team ever sees it.' });
export type ThreadNote = z.output<typeof threadNote>;

export const threadItem = z.discriminatedUnion('kind', [threadMessage, threadNote]);
export type ThreadItem = z.output<typeof threadItem>;

export const conversationThread = z
  .looseObject({
    items: z.array(threadItem).meta({ description: 'Newest first.' }),
    nextCursor: cursor.nullable(),
  })
  .meta({ id: 'ConversationThread' });
export type ConversationThread = z.output<typeof conversationThread>;

const composerAccount = z.looseObject({
  id: publicId('channel_account'),
  name: z.string(),
  address: z.string().nullable(),
});
const composerRecipient = z.looseObject({
  id: publicId('contact_identity'),
  address: z.string(),
  primary: z.boolean(),
});
export const conversationComposer = z
  .looseObject({
    canReply: z.boolean(),
    channels: z.array(
      z.looseObject({
        channel: z.enum(replyChannels),
        available: z.boolean(),
        unavailable: z
          .looseObject({ code: z.enum(composerUnavailableCodes), message: words })
          .nullable()
          .meta({
            description: 'Why nothing can be sent on this channel now. Null when it can.',
          }),
        accounts: z.array(composerAccount),
        recipients: z.array(composerRecipient),
      }),
    ),
    suggestedSubject: z.string().nullable(),
    suggestedChannel: z.enum(replyChannels).nullable().meta({
      description:
        'The channel to start a reply on: the one the contact last wrote on when a reply can go that way now, otherwise the first channel that can send. Null when none can.',
    }),
  })
  .meta({ id: 'ConversationComposer' });
export type ConversationComposer = z.output<typeof conversationComposer>;

export const assignConversationInput = z
  .strictObject({
    assignee: z.union([z.literal('me'), publicId('membership')]).nullable(),
    revision,
  })
  .meta({ id: 'AssignConversationInput' });

export const setConversationStatusInput = z
  .discriminatedUnion('status', [
    z.strictObject({ status: z.literal('open'), revision }),
    z.strictObject({ status: z.literal('closed'), revision }),
    z.strictObject({
      status: z.literal('snoozed'),
      until: z.iso.datetime({ offset: true }),
      revision,
    }),
  ])
  .meta({ id: 'SetConversationStatusInput' });

export const markConversationReadInput = z
  .strictObject({
    through: publicId('message').meta({
      description: 'The newest message or note on screen. Later messages stay unread.',
    }),
  })
  .meta({ id: 'MarkConversationReadInput' });

// Made by the client once for each thing a person writes.
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

export const addConversationNoteInput = z
  .strictObject({
    text: z.string().trim().min(1).max(NOTE_MAX_LENGTH),
    idempotencyKey: idempotencyKey.meta({
      description:
        'Made once for each note the person writes, and sent again unchanged on a retry, so a retry never stores the note twice.',
    }),
  })
  .meta({ id: 'AddConversationNoteInput' });

export const conversationAssigneeList = z
  .looseObject({
    items: z.array(
      z.looseObject({ id: publicId('membership'), name: z.string().nullable(), you: z.boolean() }),
    ),
    nextCursor: publicId('membership').nullable(),
  })
  .meta({ id: 'ConversationAssigneeList' });
export type ConversationAssigneeList = z.output<typeof conversationAssigneeList>;

export const sendConversationReplyInput = z
  .strictObject({
    channel: z.enum(replyChannels),
    accountId: publicId('channel_account'),
    to: publicId('contact_identity').nullable().default(null).meta({
      description:
        "One of the contact's own addresses or numbers. Email and text messages need one; a web chat reply takes none.",
    }),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(998)
      .regex(/^[^\r\n]*$/, { error: 'Keep the subject on one line.' })
      .nullable()
      .default(null),
    text: z.string().trim().min(1).max(MESSAGE_TEXT_MAX_LENGTH),
    idempotencyKey: idempotencyKey.meta({
      description:
        'Made once for each message the person writes, and sent again unchanged on a retry, so a double click or a retry never sends twice.',
    }),
  })
  .refine((input) => input.channel === 'email' || input.subject === null, {
    path: ['subject'],
    error: 'Only email has a subject.',
    params: { code: 'subject_not_supported' },
  })
  .refine((input) => input.channel === 'webchat' || input.to !== null, {
    path: ['to'],
    error: "Choose one of this contact's addresses or numbers.",
    params: { code: 'recipient_required' },
  })
  .refine((input) => input.channel !== 'webchat' || input.to === null, {
    path: ['to'],
    error: 'A web chat reply goes to the visitor in the chat: it takes no address.',
    params: { code: 'recipient_not_supported' },
  })
  .meta({ id: 'SendConversationReplyInput' });

const conversationParams = z.strictObject({ id: publicId('conversation') });

export const listConversations = defineEndpoint({
  operationId: 'listConversations',
  method: 'get',
  path: '/conversations',
  summary: 'Read the inbox',
  group: 'Inbox',
  query: z.strictObject({
    status: z.enum([...conversationStatuses, 'all']).default('open'),
    assignee: z
      .union([z.enum(['anyone', 'me', 'unassigned']), publicId('membership')])
      .default('anyone'),
    reply: z.enum(['any', 'needed']).default('any'),
    unread: z.enum(['any', 'unread']).default('any'),
    starred: z.enum(['any', 'only']).default('any').meta({
      description: 'only: the conversations the team starred, in the same order.',
    }),
    channel: z.enum(conversationChannels).optional(),
    contactId: publicId('contact').optional(),
    after: cursor.optional(),
  }),
  response: {
    status: 200,
    description: 'Conversations with the latest activity first.',
    schema: conversationList,
  },
});
export const listConversationAssignees = defineEndpoint({
  operationId: 'listConversationAssignees',
  method: 'get',
  path: '/inbox/assignees',
  summary: 'Read the people a conversation can be assigned to',
  group: 'Inbox',
  query: z.strictObject({ after: publicId('membership').optional() }),
  response: {
    status: 200,
    description: 'Business and agency members, one entry per person.',
    schema: conversationAssigneeList,
  },
});
export const getInboxSummary = defineEndpoint({
  operationId: 'getInboxSummary',
  method: 'get',
  path: '/inbox/summary',
  summary: 'Read the unread and needs-reply counts',
  group: 'Inbox',
  response: { status: 200, description: 'The counts the sidebar shows.', schema: inboxSummary },
});
export const getConversation = defineEndpoint({
  operationId: 'getConversation',
  method: 'get',
  path: '/conversations/{id}',
  summary: 'Read one conversation',
  group: 'Inbox',
  params: conversationParams,
  response: { status: 200, description: 'The conversation.', schema: conversation },
});
export const listConversationMessages = defineEndpoint({
  operationId: 'listConversationMessages',
  method: 'get',
  path: '/conversations/{id}/messages',
  summary: "Read a conversation's messages and internal notes",
  group: 'Inbox',
  params: conversationParams,
  query: z.strictObject({ before: cursor.optional() }),
  response: {
    status: 200,
    description: 'Messages on every channel and notes, newest first, as plain text.',
    schema: conversationThread,
  },
});
export const getConversationComposer = defineEndpoint({
  operationId: 'getConversationComposer',
  method: 'get',
  path: '/conversations/{id}/composer',
  summary: 'Read what a reply can be sent from and to',
  group: 'Inbox',
  params: conversationParams,
  response: {
    status: 200,
    description: "Each channel's usable accounts and the contact's addresses on it.",
    schema: conversationComposer,
  },
});
export const assignConversation = defineEndpoint({
  operationId: 'assignConversation',
  method: 'put',
  path: '/conversations/{id}/assignee',
  summary: 'Assign a conversation, or leave it unassigned',
  group: 'Inbox',
  params: conversationParams,
  body: assignConversationInput,
  response: { status: 200, description: 'The conversation.', schema: conversation },
});
export const setConversationStatus = defineEndpoint({
  operationId: 'setConversationStatus',
  method: 'put',
  path: '/conversations/{id}/status',
  summary: 'Open, snooze or close a conversation',
  group: 'Inbox',
  params: conversationParams,
  body: setConversationStatusInput,
  response: { status: 200, description: 'The conversation.', schema: conversation },
});
export const markConversationRead = defineEndpoint({
  operationId: 'markConversationRead',
  method: 'post',
  path: '/conversations/{id}/read',
  summary: 'Mark a conversation read up to a message',
  group: 'Inbox',
  params: conversationParams,
  body: markConversationReadInput,
  response: {
    status: 200,
    description:
      'The conversation, counting only messages stored after that one. Read state belongs to the team, not to each person, so it needs the right to manage conversations or to reply; someone who may only look does not change it.',
    schema: conversation,
  },
});
export const addConversationNote = defineEndpoint({
  operationId: 'addConversationNote',
  method: 'post',
  path: '/conversations/{id}/notes',
  summary: 'Add an internal note',
  group: 'Inbox',
  params: conversationParams,
  body: addConversationNoteInput,
  response: {
    status: 201,
    description:
      'The note. It is never sent to the contact. Sending the same idempotencyKey again returns the same note.',
    schema: threadNote,
  },
});
export const sendConversationReply = defineEndpoint({
  operationId: 'sendConversationReply',
  method: 'post',
  path: '/conversations/{id}/replies',
  summary: 'Send a reply through the outbound pipeline',
  group: 'Inbox',
  params: conversationParams,
  body: sendConversationReplyInput,
  response: {
    status: 201,
    description:
      'The message as the pipeline left it: queued, held with a reason, or failed with the reason it was refused. Sending the same idempotencyKey again returns the same message.',
    schema: threadMessage,
  },
});

/** The most conversations one bulk request names. */
export const CONVERSATION_BULK_LIMIT = 100;

/** What can be done to many conversations at once, from the list's selection. */
export const conversationBulkActions = ['mark_read', 'mark_unread', 'star', 'unstar'] as const;
export type ConversationBulkAction = (typeof conversationBulkActions)[number];

const once = <Item>(key: (item: Item) => string) =>
  [
    (items: readonly Item[]) => new Set(items.map(key)).size === items.length,
    { error: 'Name each conversation once.', params: { code: 'repeated' } },
  ] as const;
const bulkIds = z
  .array(publicId('conversation'))
  .min(1, { error: 'Select at least one conversation.' })
  .max(CONVERSATION_BULK_LIMIT, {
    error: `Select at most ${String(CONVERSATION_BULK_LIMIT)} conversations at a time.`,
  })
  .refine(...once<string>((id) => id));

export const bulkConversationsInput = z
  .discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('mark_read'),
      items: z
        .array(
          z.strictObject({
            id: publicId('conversation'),
            through: publicId('message').meta({
              description:
                "The newest message of the conversation the person saw: its lastMessage's id. What was stored after it stays unread.",
            }),
          }),
        )
        .min(1, { error: 'Select at least one conversation.' })
        .max(CONVERSATION_BULK_LIMIT, {
          error: `Select at most ${String(CONVERSATION_BULK_LIMIT)} conversations at a time.`,
        })
        .refine(...once<{ id: string }>((item) => item.id)),
    }),
    z.strictObject({ action: z.literal('mark_unread'), ids: bulkIds }),
    z.strictObject({ action: z.literal('star'), ids: bulkIds }),
    z.strictObject({ action: z.literal('unstar'), ids: bulkIds }),
  ])
  .meta({ id: 'BulkConversationsInput' });
export type BulkConversationsInput = z.output<typeof bulkConversationsInput>;

/** Why a conversation of a bulk request was left as it was. */
export const conversationBulkSkipCodes = [
  'not_found',
  'unknown_message',
  'nothing_to_mark_unread',
] as const;
export type ConversationBulkSkipCode = (typeof conversationBulkSkipCodes)[number];

export const bulkConversationsResult = z
  .looseObject({
    action: z.enum(conversationBulkActions),
    results: z
      .array(
        z.looseObject({
          id: publicId('conversation'),
          outcome: z.enum(['done', 'unchanged', 'skipped']).meta({
            description:
              'done: it was changed. unchanged: it was already as asked, so nothing was written. skipped: it could not be, for the reason given.',
          }),
          reason: z
            .looseObject({ code: z.enum(conversationBulkSkipCodes), message: words })
            .nullable(),
        }),
      )
      .meta({ description: 'One entry for each conversation named, in the order named.' }),
    done: z.int().min(0),
    unchanged: z.int().min(0),
    skipped: z.int().min(0),
  })
  .meta({ id: 'BulkConversationsResult' });
export type BulkConversationsResult = z.output<typeof bulkConversationsResult>;

export const bulkUpdateConversations = defineEndpoint({
  operationId: 'bulkUpdateConversations',
  method: 'post',
  path: '/conversations/bulk',
  summary: 'Mark read or unread, star or unstar many conversations at once',
  group: 'Inbox',
  body: bulkConversationsInput,
  response: {
    status: 200,
    description:
      'What became of each conversation. All that can be changed are, in one step; one that is not found, or cannot be marked, is skipped with its reason and never stops the others. Sending the same request again changes nothing and answers unchanged. Read state and stars belong to the team, so this needs the right to manage conversations or to reply.',
    schema: bulkConversationsResult,
  },
});

/** Every operation of the Inbox, as the API registers them. */
export const inboxEndpoints = [
  getInboxSummary,
  listConversationAssignees,
  listConversations,
  getConversation,
  listConversationMessages,
  getConversationComposer,
  assignConversation,
  setConversationStatus,
  markConversationRead,
  bulkUpdateConversations,
  addConversationNote,
  sendConversationReply,
] as const;
