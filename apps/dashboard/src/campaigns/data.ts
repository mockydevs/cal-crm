// Where the campaign screens keep what they read, and the reads several of them share: the
// folders, the names an audience is worded with (smart lists, tags), and the mailboxes a
// campaign may be sent from. Every key starts with the business, so the realtime hint
// (realtime.ts) reads them again when something in the business changes.
import {
  getTagConfiguration,
  listEmailCampaignFolders,
  type EmailCampaignFolderList,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiIn } from '../api';
import type { AudienceNames } from './rules';

export const campaignKeys = {
  all: (businessId: string) => ['b', businessId, 'email-campaigns'] as const,
  list: (businessId: string, filters: unknown) =>
    ['b', businessId, 'email-campaigns', 'list', filters] as const,
  one: (businessId: string, id: string) => ['b', businessId, 'email-campaigns', 'one', id] as const,
  audience: (businessId: string, id: string, revision: number) =>
    ['b', businessId, 'email-campaigns', 'audience', id, revision] as const,
  checks: (businessId: string, id: string, revision: number) =>
    ['b', businessId, 'email-campaigns', 'checks', id, revision] as const,
  stats: (businessId: string, id: string) =>
    ['b', businessId, 'email-campaigns', 'stats', id] as const,
  recipients: (businessId: string, id: string, filters: unknown) =>
    ['b', businessId, 'email-campaigns', 'recipients', id, filters] as const,
  folders: (businessId: string) => ['b', businessId, 'email-campaign-folders'] as const,
  settings: (businessId: string) => ['b', businessId, 'email-campaign-settings'] as const,
  mailboxes: (businessId: string) => ['b', businessId, 'email-campaign-mailboxes'] as const,
  views: (businessId: string) => ['b', businessId, 'views', 'contact'] as const,
  tags: (businessId: string) => ['b', businessId, 'tags'] as const,
};

/**
 * Whether a read is asked for again after it failed: twice for a fault of the server or
 * the connection, never for an answer that would be the same again, such as "you may not".
 */
export const retryFaults = (failures: number, error: Error): boolean =>
  !(error instanceof ApiError && error.status < 500) && failures < 2;

/** What the server said, or the page's own words when no answer came. */
export const saidBy = (error: unknown, fallback: string): string =>
  error instanceof ApiError
    ? (error.problem.errors?.[0]?.message ?? error.problem.detail ?? error.message)
    : fallback;

export const isRefusal = (error: unknown, status: number): boolean =>
  error instanceof ApiError && error.status === status;

export function useCampaignFolders(businessId: string): UseQueryResult<EmailCampaignFolderList> {
  return useQuery({
    queryKey: campaignKeys.folders(businessId),
    queryFn: () => apiIn(businessId).request(listEmailCampaignFolders, {}),
    retry: retryFaults,
    staleTime: 30_000,
  });
}

/**
 * The names an audience is said with. A person whose role cannot read smart lists or tags
 * gets the audience worded without their names.
 */
export function useAudienceNames(businessId: string, enabled = true): AudienceNames {
  const views = useQuery({
    queryKey: campaignKeys.views(businessId),
    // The contract arrives with the first read, not with the page (saved-view-api.ts).
    queryFn: async () =>
      apiIn(businessId).request((await import('../saved-view-api')).listViews, {
        query: { object: 'contact' },
      }),
    enabled,
    retry: retryFaults,
    staleTime: 60_000,
  });
  const tags = useQuery({
    queryKey: campaignKeys.tags(businessId),
    queryFn: () => apiIn(businessId).request(getTagConfiguration, {}),
    enabled,
    retry: retryFaults,
    staleTime: 60_000,
  });
  return {
    views:
      views.data === undefined
        ? undefined
        : new Map(views.data.items.map((view) => [view.id, view.name])),
    tags:
      tags.data === undefined
        ? undefined
        : new Map(tags.data.items.map((tag) => [tag.id, tag.name])),
  };
}
