// What the Inbox's address says: which conversation is open, and the list's filters. The
// route validates its search with inboxSearch, so this file stays small: it is loaded with
// the app, while the page itself is the route's own chunk.
import type { ConversationChannel, EndpointInput, listConversations } from '@repo/contracts';

export interface InboxSearch {
  /** The open conversation's id. */
  readonly conversation?: string;
  /** Open conversations unless the address says otherwise. */
  readonly status?: 'snoozed' | 'closed' | 'all';
  /** Anyone's unless the address says me, unassigned, or a teammate's membership id. */
  readonly assignee?: string;
  readonly reply?: 'needed';
  readonly unread?: 'unread';
  /** Only the conversations the team starred. */
  readonly starred?: 'only';
  readonly channel?: ConversationChannel;
  /** Only this contact's conversations: a contact id. */
  readonly contact?: string;
}

export type InboxFilters = Omit<InboxSearch, 'conversation'>;

export type ConversationQuery = NonNullable<EndpointInput<typeof listConversations>['query']>;

// A public id's shape: a prefix, then a UUIDv7 in TypeID's base32. The server decides
// whether it names a conversation; this only keeps other text out of requests.
const PUBLIC_ID = /^[a-z][a-z_]{0,30}_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

const SUFFIX = '_[0-7][0-9a-hjkmnp-tv-z]{25}$';
const MEMBERSHIP_ID = new RegExp(`^mem${SUFFIX}`);
const CONTACT_ID = new RegExp(`^con${SUFFIX}`);

/** Whether an assignee filter names one teammate, by membership id. */
export function isTeammate(assignee: string | undefined): boolean {
  return assignee !== undefined && MEMBERSHIP_ID.test(assignee);
}

const channels = {
  email: true,
  sms: true,
  webchat: true,
} satisfies Record<ConversationChannel, true>;

function isChannel(value: unknown): value is ConversationChannel {
  return typeof value === 'string' && Object.hasOwn(channels, value);
}

/** The page's search parameters, for the route to validate: anything else is dropped. */
export function inboxSearch(search: Record<string, unknown>): InboxSearch {
  const conversation = search['conversation'];
  const status = search['status'];
  const assignee = search['assignee'];
  const channel = search['channel'];
  const contact = search['contact'];
  return {
    ...(typeof conversation === 'string' && PUBLIC_ID.test(conversation) ? { conversation } : {}),
    ...(status === 'snoozed' || status === 'closed' || status === 'all' ? { status } : {}),
    ...(typeof assignee === 'string' &&
    (assignee === 'me' || assignee === 'unassigned' || isTeammate(assignee))
      ? { assignee }
      : {}),
    ...(search['reply'] === 'needed' ? { reply: 'needed' as const } : {}),
    ...(search['unread'] === 'unread' ? { unread: 'unread' as const } : {}),
    ...(search['starred'] === 'only' ? { starred: 'only' as const } : {}),
    ...(isChannel(channel) ? { channel } : {}),
    ...(typeof contact === 'string' && CONTACT_ID.test(contact) ? { contact } : {}),
  };
}

/** The filters alone, in a fixed order, so equal filters make equal cache keys. */
export function filtersOf(search: InboxSearch): InboxFilters {
  return {
    ...(search.status === undefined ? {} : { status: search.status }),
    ...(search.assignee === undefined ? {} : { assignee: search.assignee }),
    ...(search.reply === undefined ? {} : { reply: search.reply }),
    ...(search.unread === undefined ? {} : { unread: search.unread }),
    ...(search.starred === undefined ? {} : { starred: search.starred }),
    ...(search.channel === undefined ? {} : { channel: search.channel }),
    ...(search.contact === undefined ? {} : { contact: search.contact }),
  };
}

/** What listConversations is asked: only what differs from its defaults, and the cursor. */
export function conversationQueryOf(filters: InboxFilters, after?: string): ConversationQuery {
  return {
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.assignee === undefined ? {} : { assignee: filters.assignee }),
    ...(filters.reply === undefined ? {} : { reply: filters.reply }),
    ...(filters.unread === undefined ? {} : { unread: filters.unread }),
    ...(filters.starred === undefined ? {} : { starred: filters.starred }),
    ...(filters.channel === undefined ? {} : { channel: filters.channel }),
    ...(filters.contact === undefined ? {} : { contactId: filters.contact }),
    ...(after === undefined ? {} : { after }),
  };
}

/** The address's query string for a search, for a real link's href. */
export function searchStringOf(search: InboxSearch): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries({
    ...(search.conversation === undefined ? {} : { conversation: search.conversation }),
    ...filtersOf(search),
  })) {
    query.set(name, value);
  }
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}
