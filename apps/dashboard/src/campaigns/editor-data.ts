// What the editor reads of the saved draft: who would get it, and what stands in the way
// of sending it. Both are the server's, read again after each save; what the save before
// said stays on screen meanwhile.
import {
  getEmailCampaignAudience,
  getEmailCampaignChecks,
  type EmailCampaignAudiencePreview,
  type EmailCampaignChecks,
} from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { campaignKeys, retryFaults } from './data';

/** The saved draft's audience as the server counts it now. */
export function useAudiencePreview(
  client: Client,
  businessId: string,
  campaign: { readonly id: string; readonly revision: number; readonly audience: unknown },
  enabled: boolean,
): UseQueryResult<EmailCampaignAudiencePreview> {
  return useQuery({
    queryKey: campaignKeys.audience(businessId, campaign.id, campaign.revision),
    queryFn: () => client.request(getEmailCampaignAudience, { params: { id: campaign.id } }),
    enabled: enabled && campaign.audience !== null,
    retry: retryFaults,
    // The count of the save before stays on screen while the new one is read.
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useCampaignChecks(
  client: Client,
  businessId: string,
  campaign: { readonly id: string; readonly revision: number },
  enabled: boolean,
): UseQueryResult<EmailCampaignChecks> {
  return useQuery({
    queryKey: campaignKeys.checks(businessId, campaign.id, campaign.revision),
    queryFn: () => client.request(getEmailCampaignChecks, { params: { id: campaign.id } }),
    enabled,
    retry: retryFaults,
    // The checks of the save before stay on screen while the new ones are read.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
