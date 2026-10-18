// The mailboxes a campaign may be sent from: the business's mailboxes, each with whether it
// is switched on for campaigns (Settings → Email Services). Read with campaigns.manage, so
// whoever may write a campaign may choose its mailbox (GET /email-campaign-mailboxes).
import { listEmailCampaignMailboxes, type EmailCampaignMailbox } from '@repo/contracts';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiIn } from '../api';
import { campaignKeys, retryFaults } from './data';

export interface CampaignMailboxes {
  /** Every connected mailbox, with whether it is for campaigns. */
  readonly all: readonly EmailCampaignMailbox[];
  /** The ones a campaign may be sent from. */
  readonly offered: readonly EmailCampaignMailbox[];
}

/** The business's mailboxes with their use for campaigns. */
export function useCampaignMailboxes(
  businessId: string,
  enabled = true,
): UseQueryResult<CampaignMailboxes> {
  return useQuery({
    queryKey: campaignKeys.mailboxes(businessId),
    queryFn: async (): Promise<CampaignMailboxes> => {
      const { items } = await apiIn(businessId).request(listEmailCampaignMailboxes, {});
      return { all: items, offered: items.filter((mailbox) => mailbox.useForCampaigns) };
    },
    enabled,
    retry: retryFaults,
    staleTime: 30_000,
  });
}
