import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

export const mailboxSendingInput = z
  .strictObject({
    dailyLimit: z.number().int().min(1).max(100_000),
    pacingPerMinute: z.number().int().min(1).max(600),
    warmupEnabled: z.boolean(),
    useForConversations: z.boolean(),
    useForCampaigns: z.boolean(),
  })
  .meta({ id: 'MailboxSendingInput' });
export type MailboxSendingInput = z.output<typeof mailboxSendingInput>;
export const mailboxSendingSettings = mailboxSendingInput
  .extend({
    effectiveAutomatedDailyLimit: z.number().int().min(1).max(100_000),
    warmupStartedAt: timestamp,
    pausedUntil: timestamp.nullable(),
    pauseReason: z.literal('provider_temporary').nullable(),
  })
  .meta({ id: 'MailboxSendingSettings' });
export type MailboxSendingSettings = z.output<typeof mailboxSendingSettings>;
const params = z.strictObject({ id: publicId('mailbox') });
export const updateMailboxSendingInput = z.strictObject({
  id: publicId('mailbox'),
  settings: mailboxSendingInput,
});
export const getMailboxSendingSettings = defineEndpoint({
  operationId: 'getMailboxSendingSettings',
  method: 'get',
  path: '/mailboxes/{id}/sending',
  summary: 'Read mailbox sending limits, use and temporary provider pause.',
  group: 'Email',
  params,
  response: {
    status: 200,
    description: 'The sending settings without credentials.',
    schema: mailboxSendingSettings,
  },
});
export const updateMailboxSendingSettings = defineEndpoint({
  operationId: 'updateMailboxSendingSettings',
  method: 'put',
  path: '/mailboxes/{id}/sending',
  summary: 'Set mailbox limits, warmup and conversation/campaign use.',
  group: 'Email',
  params,
  body: mailboxSendingInput,
  response: {
    status: 200,
    description: 'The saved sending settings; a provider pause remains in force.',
    schema: mailboxSendingSettings,
  },
});
