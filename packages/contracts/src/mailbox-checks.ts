import * as z from 'zod';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';
import { defineEndpoint } from './endpoints.js';

export const requestMailboxCheckInput = z
  .strictObject({ id: publicId('mailbox') })
  .meta({ id: 'RequestMailboxCheckInput' });

export const mailboxCheckKey = z.enum([
  'connection',
  'encryption',
  'spf',
  'dkim',
  'dmarc',
  'dmarc_enforcement',
  'reverse_dns',
  'mx',
  'blocklists',
  'unsubscribe',
]);
export const mailboxCheckPoints = {
  connection: 0,
  encryption: 10,
  spf: 15,
  dkim: 20,
  dmarc: 14,
  dmarc_enforcement: 4,
  reverse_dns: 10,
  mx: 6,
  blocklists: 15,
  unsubscribe: 6,
} as const satisfies Readonly<Record<z.output<typeof mailboxCheckKey>, number>>;
const mailboxCheckFix = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('record'),
    type: z.literal('TXT'),
    name: z.string().min(1).max(253),
    value: z.string().min(1).max(4096),
    exceedsLookupLimit: z.literal(true).optional(),
  }),
  z.strictObject({
    kind: z.literal('ask'),
    who: z.literal('ip_owner'),
    ip: z.string().min(1).max(45),
    ptr: z.string().min(1).max(253).optional(),
  }),
]);
export const mailboxSetupCheck = z
  .strictObject({
    key: mailboxCheckKey,
    status: z.enum(['pass', 'fail', 'not_applicable', 'could_not_check']),
    reason: z
      .string()
      .max(80)
      .regex(/^[a-z][a-z0-9_]*$/),
    pointsPossible: z.number().int().min(0).max(20),
    pointsAwarded: z.number().int().min(0).max(20),
    fix: mailboxCheckFix.optional(),
  })
  .refine((check) => check.pointsPossible === mailboxCheckPoints[check.key], {
    message: 'Use the defined point weight for each setup check.',
  })
  .refine(
    (check) =>
      check.pointsAwarded ===
      (check.status === 'pass' || check.status === 'not_applicable' ? check.pointsPossible : 0),
    { message: 'Award points only for passed or inapplicable evidence.' },
  )
  .meta({ id: 'MailboxSetupCheck' });
export type MailboxSetupCheck = z.output<typeof mailboxSetupCheck>;

const setupCommon = {
  mailboxId: publicId('mailbox'),
  method: z.enum(['self', 'dns_only', 'check_mailbox']),
  trigger: z.enum(['connect', 'manual', 'scheduled', 'bounce_spike']),
  startedAt: timestamp,
};
export const mailboxSetup = z
  .discriminatedUnion('state', [
    z.strictObject({
      ...setupCommon,
      state: z.literal('pending'),
      finishedAt: z.null(),
      score: z.null(),
      checks: z.array(mailboxSetupCheck).max(0),
    }),
    z.strictObject({
      ...setupCommon,
      state: z.literal('finished'),
      finishedAt: timestamp,
      score: z.number().int().min(0).max(100),
      checks: z.array(mailboxSetupCheck).length(10),
    }),
  ])
  .refine(
    (setup) =>
      setup.state === 'pending' ||
      (new Set(setup.checks.map((check) => check.key)).size === 10 &&
        setup.checks.reduce((total, check) => total + check.pointsPossible, 0) === 100 &&
        setup.checks.reduce((total, check) => total + check.pointsAwarded, 0) === setup.score),
    { message: 'A finished score needs all ten checks and their exact point total.' },
  )
  .meta({ id: 'MailboxSetup' });
export type MailboxSetup = z.output<typeof mailboxSetup>;

export const requestMailboxCheck = defineEndpoint({
  operationId: 'requestMailboxCheck',
  method: 'post',
  path: '/mailboxes/{id}/checks',
  summary: 'Queue a setup check for a connected mailbox.',
  group: 'Email',
  params: requestMailboxCheckInput,
  response: { status: 201, description: 'The queued setup check.', schema: mailboxSetup },
});
export const getMailboxSetup = defineEndpoint({
  operationId: 'getMailboxSetup',
  method: 'get',
  path: '/mailboxes/{id}/setup',
  summary: 'Read the latest mailbox setup score, checks and fixes.',
  group: 'Email',
  params: requestMailboxCheckInput,
  response: {
    status: 200,
    description: 'Latest setup check, or null before the first check.',
    schema: mailboxSetup.nullable(),
  },
});
export const mailboxSetupAlerts = z
  .strictObject({
    data: z
      .array(
        z.strictObject({
          mailboxId: publicId('mailbox'),
          name: z.string().max(120),
          checkKey: mailboxCheckKey,
          failedAt: timestamp,
        }),
      )
      .max(100),
    hasMore: z.boolean(),
  })
  .meta({ id: 'MailboxSetupAlerts' });
export type MailboxSetupAlerts = z.output<typeof mailboxSetupAlerts>;
export const getMailboxSetupAlerts = defineEndpoint({
  operationId: 'getMailboxSetupAlerts',
  method: 'get',
  path: '/mailbox-setup-alerts',
  summary: 'List previously passing mailbox checks that now need attention.',
  group: 'Email',
  response: {
    status: 200,
    description: 'Unresolved setup regressions in this business.',
    schema: mailboxSetupAlerts,
  },
});
