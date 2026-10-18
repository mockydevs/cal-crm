import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[^\s/\\@\p{Cc}]+$/u);
const port = z.number().int().min(1).max(65_535);
const security = z.enum(['tls', 'starttls']);
const serverFields = {
  host,
  port,
  security,
  username: z
    .string()
    .min(1)
    .max(320)
    .regex(/^[^\p{Cc}]+$/u),
};
export const mailServerLogin = z
  .strictObject({
    ...serverFields,
    password: z.string().min(1).max(4096).meta({ writeOnly: true }),
  })
  .meta({ id: 'MailServerLogin' });

export const connectMailboxInput = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    email: z.email().max(320),
    displayName: z.string().trim().max(120).default(''),
    smtp: mailServerLogin,
    imap: mailServerLogin,
  })
  .meta({ id: 'ConnectMailboxInput' });
export type ConnectMailboxInput = z.output<typeof connectMailboxInput>;

const connectionCheck = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pass'), code: z.literal('connected'), port }),
  z.strictObject({
    status: z.literal('fail'),
    code: z.enum([
      'private_address',
      'dns',
      'timeout',
      'invalid_host',
      'authentication',
      'certificate',
      'tls_required',
      'unreachable',
      'connection',
    ]),
    port,
  }),
]);
export const mailboxConnectionResult = z
  .strictObject({ smtp: connectionCheck, imap: connectionCheck })
  .meta({ id: 'MailboxConnectionResult' });
export type MailboxConnectionResult = z.output<typeof mailboxConnectionResult>;

const attemptCommon = { id: publicId('mailbox_attempt'), createdAt: timestamp };
export const mailboxConnectionAttempt = z
  .discriminatedUnion('status', [
    z.strictObject({
      ...attemptCommon,
      status: z.literal('pending'),
      mailboxId: z.null(),
      result: z.null(),
    }),
    z.strictObject({
      ...attemptCommon,
      status: z.literal('connected'),
      mailboxId: publicId('mailbox'),
      result: mailboxConnectionResult,
    }),
    z.strictObject({
      ...attemptCommon,
      status: z.literal('failed'),
      mailboxId: z.null(),
      failure: z.enum(['connection_failed', 'expired', 'credentials_unreadable']),
      result: mailboxConnectionResult.nullable(),
    }),
  ])
  .meta({ id: 'MailboxConnectionAttempt' });
export type MailboxConnectionAttempt = z.output<typeof mailboxConnectionAttempt>;

export const mailbox = z
  .strictObject({
    id: publicId('mailbox'),
    name: z.string(),
    email: z.email(),
    displayName: z.string(),
    smtp: z.strictObject(serverFields),
    imap: z.strictObject(serverFields),
    status: z.enum(['active', 'paused', 'failing', 'disconnected']),
    createdAt: timestamp,
  })
  .meta({ id: 'Mailbox' });
export type Mailbox = z.output<typeof mailbox>;
export const mailboxList = z.strictObject({ data: z.array(mailbox) }).meta({ id: 'MailboxList' });

const suggestion = z.strictObject({
  host,
  port,
  security,
  source: z.enum(['srv', 'provider', 'mx']),
  requiresConfirmation: z.boolean(),
});
export const mailboxDiscovery = z
  .strictObject({
    domain: z.string(),
    smtp: suggestion.nullable(),
    imap: suggestion.nullable(),
    detectedProvider: z.enum(['google', 'microsoft']).nullable(),
    authentication: z.enum(['password', 'app_password_or_oauth', 'oauth_required']),
    warnings: z.array(z.literal('dns_unavailable')),
  })
  .meta({ id: 'MailboxDiscovery' });
export type MailboxDiscovery = z.output<typeof mailboxDiscovery>;

export const discoverMailboxServers = defineEndpoint({
  operationId: 'discoverMailboxServers',
  method: 'post',
  path: '/mailboxes/discovery',
  summary: 'Suggest SMTP and IMAP servers for a mailbox address.',
  group: 'Email',
  body: z.strictObject({ email: z.email().max(320) }),
  response: {
    status: 200,
    description: 'Suggested server settings; no sign-in attempted.',
    schema: mailboxDiscovery,
  },
});
export const connectMailbox = defineEndpoint({
  operationId: 'connectMailbox',
  method: 'post',
  path: '/mailbox-connection-attempts',
  summary: 'Test SMTP and IMAP credentials and connect the mailbox if both pass.',
  group: 'Email',
  body: connectMailboxInput,
  response: {
    status: 201,
    description: 'The connection attempt was queued; poll its status.',
    schema: mailboxConnectionAttempt,
  },
});
export const getMailboxConnectionAttempt = defineEndpoint({
  operationId: 'getMailboxConnectionAttempt',
  method: 'get',
  path: '/mailbox-connection-attempts/{id}',
  summary: 'Read the status of a mailbox connection attempt.',
  group: 'Email',
  params: z.strictObject({ id: publicId('mailbox_attempt') }),
  response: {
    status: 200,
    description: 'The connection attempt.',
    schema: mailboxConnectionAttempt,
  },
});
export const listMailboxes = defineEndpoint({
  operationId: 'listMailboxes',
  method: 'get',
  path: '/mailboxes',
  summary: 'List the business’s connected mailboxes.',
  group: 'Email',
  response: {
    status: 200,
    description: 'The connected mailboxes, without credentials.',
    schema: mailboxList,
  },
});
