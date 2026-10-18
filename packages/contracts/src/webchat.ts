// Web chat: the widget a business embeds on its own website. The admin endpoints manage a
// widget; the public ones are called by the widget from an allowed website, with no
// sign-in, and have their own transport. Every limit of the public surface is here.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** The limits of the public surface. A request past one is refused, never cut short. */
export const WEBCHAT_LIMITS = {
  /** Characters in one message, either way. */
  messageLength: 2000,
  /** Messages a visitor may send in one session. */
  messagesPerSession: 200,
  /** Messages a visitor may send in one session in any one minute. */
  messagesPerMinute: 10,
  /** Sessions one widget starts in an hour and in a day, whoever asks. */
  sessionsPerHour: 120,
  sessionsPerDay: 1000,
  /** How long a session's token works, from the moment it is issued. */
  sessionDays: 30,
  /** Messages in one page of a session's transcript. */
  pageSize: 50,
  nameLength: 80,
  emailLength: 320,
  allowedOrigins: 20,
  originLength: 255,
  titleLength: 60,
  greetingLength: 300,
  consentWordingLength: 300,
} as const;

/**
 * A website's address as someone types it: a scheme, a host, an optional port and nothing
 * after it. This is a first, portable check with no URL parser. The server then stores the
 * origin's one canonical form (canonicalWebOrigin in the messaging module) and refuses
 * what has none, such as plain HTTP outside a developer's own machine.
 *
 * Refused here already: whitespace and control characters, a backslash, user information
 * (@), a path, a query, a fragment, a percent escape and a wildcard. A URL parser would
 * silently drop, decode or reinterpret each of them.
 */
export const WEB_ORIGIN_INPUT = /^https?:\/\/[^\p{Cc}\s\\/@?#%*]+\/?$/iu;

const webOrigin = z
  .string()
  .max(WEBCHAT_LIMITS.originLength, { error: 'Use at most 255 characters.' })
  .regex(WEB_ORIGIN_INPUT, {
    error: 'Enter a website address with nothing after the host, such as https://www.example.com.',
  })
  .meta({ examples: ['https://www.example.com'] });

// Text people read: one line, no control characters (Unicode category Cc: C0, DEL and C1).
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Use at most ${String(max)} characters.` })
    .regex(/^\P{Cc}*$/u, { error: 'Use one line of plain text.' });

export const webchatWidgetSettings = z
  .strictObject({
    /** The heading of the chat panel. */
    title: line(WEBCHAT_LIMITS.titleLength).min(1, { error: 'Enter a title.' }),
    /** Shown above the first message. */
    greeting: line(WEBCHAT_LIMITS.greetingLength),
    /** Whether a visitor must give an email address before the first message. */
    emailRequired: z.boolean(),
    /**
     * The wording of the marketing box, unticked by default. Null shows no box, and then a
     * chat can never record marketing consent.
     */
    marketingConsentWording: line(WEBCHAT_LIMITS.consentWordingLength)
      .min(1, { error: 'Enter the wording, or leave it out to show no box.' })
      .nullable(),
  })
  .meta({ id: 'WebchatWidgetSettings' });
export type WebchatWidgetSettings = z.output<typeof webchatWidgetSettings>;

export const DEFAULT_WEBCHAT_SETTINGS: WebchatWidgetSettings = {
  title: 'Chat with us',
  greeting: 'Hello. How can we help?',
  emailRequired: true,
  marketingConsentWording: null,
};

export const webchatWidgetInput = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1, { error: 'Enter a name.' })
      .max(120, { error: 'Use at most 120 characters.' }),
    /** The websites that may show this widget. The server stores each once, canonically. */
    allowedOrigins: z
      .array(webOrigin)
      .max(WEBCHAT_LIMITS.allowedOrigins, { error: 'Add at most 20 websites.' }),
    /** A widget that is off refuses every public request. */
    enabled: z.boolean(),
    settings: webchatWidgetSettings,
  })
  .meta({ id: 'WebchatWidgetInput' });
export type WebchatWidgetInput = z.output<typeof webchatWidgetInput>;

const widgetId = publicId('webchat_widget');

/** 24 random bytes in unpadded base64url. Public: it is in the page source of every site. */
export const webchatWidgetKey = z.string().regex(/^[A-Za-z0-9_-]{32}$/);

export const webchatWidget = z
  .strictObject({
    id: widgetId,
    name: z.string(),
    publicKey: webchatWidgetKey,
    enabled: z.boolean(),
    allowedOrigins: z.array(z.string()),
    settings: webchatWidgetSettings,
    /** The one line a website needs. */
    embedSnippet: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'WebchatWidget' });
export type WebchatWidget = z.output<typeof webchatWidget>;

const widgetParams = z.strictObject({ id: widgetId });

export const listWebchatWidgets = defineEndpoint({
  operationId: 'listWebchatWidgets',
  method: 'get',
  path: '/webchat/widgets',
  summary: "List the business's web chat widgets",
  group: 'Web chat',
  response: {
    status: 200,
    description: 'The widgets, oldest first.',
    schema: z.strictObject({ data: z.array(webchatWidget) }),
  },
});
export const createWebchatWidget = defineEndpoint({
  operationId: 'createWebchatWidget',
  method: 'post',
  path: '/webchat/widgets',
  summary: 'Create a web chat widget',
  group: 'Web chat',
  body: webchatWidgetInput,
  response: { status: 201, description: 'The new widget, with its key.', schema: webchatWidget },
});
export const updateWebchatWidget = defineEndpoint({
  operationId: 'updateWebchatWidget',
  method: 'put',
  path: '/webchat/widgets/{id}',
  summary: 'Change a web chat widget, or turn it on or off',
  group: 'Web chat',
  params: widgetParams,
  body: webchatWidgetInput,
  response: { status: 200, description: 'The saved widget.', schema: webchatWidget },
});
export const rotateWebchatWidgetKey = defineEndpoint({
  operationId: 'rotateWebchatWidgetKey',
  method: 'post',
  path: '/webchat/widgets/{id}/rotate-key',
  summary: 'Replace a widget key; the old key and every open chat stop working at once',
  group: 'Web chat',
  params: widgetParams,
  response: { status: 200, description: 'The widget with its new key.', schema: webchatWidget },
});
export const webchatAdminEndpoints = [
  listWebchatWidgets,
  createWebchatWidget,
  updateWebchatWidget,
  rotateWebchatWidgetKey,
] as const;

// The public surface -----------------------------------------------------------------

/** Exactly 32 random bytes in canonical unpadded base64url (the final two bits are zero). */
export const webchatSessionToken = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);

const publicParams = z.strictObject({ widgetKey: webchatWidgetKey });

/**
 * A chat message as typed: plain text, kept exactly, line breaks included. NUL and the
 * other control characters (Unicode category Cc) are refused; a tab or a line break is not
 * one of them here.
 */
export const webchatMessageText = z
  .string()
  .min(1)
  .max(WEBCHAT_LIMITS.messageLength)
  .regex(/^[\P{Cc}\t\n\r]*$/u)
  .refine((value) => value.trim() !== '');

export const publicWebchatConfig = z.strictObject({
  title: z.string().min(1).max(WEBCHAT_LIMITS.titleLength),
  greeting: z.string().max(WEBCHAT_LIMITS.greetingLength),
  emailRequired: z.boolean(),
  marketingConsentWording: z.string().min(1).max(WEBCHAT_LIMITS.consentWordingLength).nullable(),
  messageLength: z.literal(WEBCHAT_LIMITS.messageLength),
});

export const publicWebchatSessionInput = z.strictObject({
  name: line(WEBCHAT_LIMITS.nameLength).optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(WEBCHAT_LIMITS.emailLength)
    .regex(z.regexes.email)
    .optional(),
  /** True only when the visitor ticked the box. It never defaults to true. */
  marketingConsent: z.boolean(),
});
export const publicWebchatSession = z.strictObject({
  /** Shown once. The server keeps only a digest of it. */
  token: webchatSessionToken,
  expiresAt: timestamp,
});

export const publicWebchatMessageInput = z.strictObject({
  /** Chosen by the widget for each message, so a request sent twice is stored once. */
  clientMessageId: z.uuid(),
  text: webchatMessageText,
});
export const publicWebchatMessage = z.strictObject({
  /** The message's place in this session: 1, 2, 3 and so on, with no gaps. */
  seq: z.int().min(1).max(2_147_483_647),
  from: z.enum(['visitor', 'team']),
  /** Plain text. Whoever shows it must show it as text, never as HTML. */
  text: z.string().max(WEBCHAT_LIMITS.messageLength),
  sentAt: timestamp,
});
export const publicWebchatMessagesQuery = z.strictObject({
  /** Messages after this place; 0 or nothing reads from the start. */
  after: z.coerce.number().int().min(0).max(2_147_483_647).default(0),
});
export const publicWebchatMessages = z.strictObject({
  messages: z.array(publicWebchatMessage).max(WEBCHAT_LIMITS.pageSize),
  /** The place to read after next time. */
  cursor: z.int().min(0).max(2_147_483_647),
  /** Whether another page is waiting. */
  more: z.boolean(),
});

const publicPath = '/public/webchat/{widgetKey}';

export const getPublicWebchat = defineEndpoint({
  audience: 'public',
  operationId: 'getPublicWebchat',
  method: 'get',
  path: publicPath,
  summary: 'Read what a web chat widget shows',
  group: 'Public web chat',
  params: publicParams,
  response: { status: 200, description: 'Title, greeting and form.', schema: publicWebchatConfig },
});
export const startPublicWebchatSession = defineEndpoint({
  audience: 'public',
  operationId: 'startPublicWebchatSession',
  method: 'post',
  path: `${publicPath}/sessions`,
  summary: "Start a visitor's chat session",
  group: 'Public web chat',
  params: publicParams,
  body: publicWebchatSessionInput,
  response: {
    status: 201,
    description: 'The session token, returned this once.',
    schema: publicWebchatSession,
  },
});
export const sendPublicWebchatMessage = defineEndpoint({
  audience: 'public',
  operationId: 'sendPublicWebchatMessage',
  method: 'post',
  path: `${publicPath}/messages`,
  summary: 'Send a chat message in a session',
  group: 'Public web chat',
  params: publicParams,
  body: publicWebchatMessageInput,
  response: {
    status: 200,
    description: 'The stored message; the same one when the request is repeated.',
    schema: publicWebchatMessage,
  },
});
export const listPublicWebchatMessages = defineEndpoint({
  audience: 'public',
  operationId: 'listPublicWebchatMessages',
  method: 'get',
  path: `${publicPath}/messages`,
  summary: "Read a session's messages after a place",
  group: 'Public web chat',
  params: publicParams,
  query: publicWebchatMessagesQuery,
  response: {
    status: 200,
    description: 'Messages of this session only, oldest first.',
    schema: publicWebchatMessages,
  },
});
export const endPublicWebchatSession = defineEndpoint({
  audience: 'public',
  operationId: 'endPublicWebchatSession',
  method: 'post',
  path: `${publicPath}/session/end`,
  summary: 'End a session, so its token stops working',
  group: 'Public web chat',
  params: publicParams,
  response: { status: 204, description: 'The session has ended.' },
});
export const publicWebchatEndpoints = [
  getPublicWebchat,
  startPublicWebchatSession,
  sendPublicWebchatMessage,
  listPublicWebchatMessages,
  endPublicWebchatSession,
] as const;

export type PublicWebchatConfig = z.output<typeof publicWebchatConfig>;
export type PublicWebchatSessionInput = z.output<typeof publicWebchatSessionInput>;
export type PublicWebchatSession = z.output<typeof publicWebchatSession>;
export type PublicWebchatMessageInput = z.output<typeof publicWebchatMessageInput>;
export type PublicWebchatMessage = z.output<typeof publicWebchatMessage>;
export type PublicWebchatMessages = z.output<typeof publicWebchatMessages>;
