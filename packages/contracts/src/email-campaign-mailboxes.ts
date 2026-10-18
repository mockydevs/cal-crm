// The mailboxes a campaign may be sent from, read with campaigns.manage: whoever may write
// a campaign may choose its mailbox. Apart from email-campaigns.ts so that only the screen
// that chooses a mailbox downloads it.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';

export const emailCampaignMailbox = z
  .looseObject({
    id: publicId('mailbox'),
    name: z.string(),
    email: z.string(),
    displayName: z.string(),
    // A mailbox's status as GET /mailboxes says it (mailboxes.ts), written out here so the
    // campaign screens do not download the mailbox contracts.
    status: z.enum(['active', 'paused', 'failing', 'disconnected']),
    useForCampaigns: z.boolean(),
  })
  .meta({
    id: 'EmailCampaignMailbox',
    description: 'A mailbox as the campaign screens need it: no servers, sign-ins or limits.',
  });
export type EmailCampaignMailbox = z.output<typeof emailCampaignMailbox>;

export const emailCampaignMailboxList = z
  .looseObject({ items: z.array(emailCampaignMailbox) })
  .meta({ id: 'EmailCampaignMailboxList' });
export type EmailCampaignMailboxList = z.output<typeof emailCampaignMailboxList>;

export const listEmailCampaignMailboxes = defineEndpoint({
  operationId: 'listEmailCampaignMailboxes',
  method: 'get',
  path: '/email-campaign-mailboxes',
  summary: 'Read the mailboxes a campaign may be sent from',
  group: 'Email campaigns',
  response: {
    status: 200,
    description: 'Every mailbox, oldest first. Needs campaigns.manage, not mailboxes.manage.',
    schema: emailCampaignMailboxList,
  },
});
