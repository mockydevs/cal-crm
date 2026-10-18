// Applying one of the assistant's proposals, and putting what that changed into what the
// Inbox shows. It is fetched with the assistant's own code (inbox-assistant.tsx), or the
// first time a draft changed in the reply box is sent, so the Inbox itself carries none of
// the proposals' contract.
import {
  applyProposal,
  type ConversationThread,
  type Proposal,
  type ThreadMessage,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import type { QueryClient } from '@tanstack/react-query';
import { inboxKeys } from './inbox-data';
import type { Pages, ReplyContent } from './inbox-rules';

export interface AppliedProposal {
  readonly proposal: Proposal;
  /** The reply that applying it made, as the thread now has it. Undefined for any other
   * kind of proposal, and when the thread couldn't be read afterwards. */
  readonly message: ThreadMessage | undefined;
}

/**
 * Applies one of the assistant's proposals as the person, with their changes if they made
 * any, then reads the Inbox again, since applying changed it: the thread has a new message,
 * or the conversation a new status. The proposal is what makes this safe to try twice:
 * applying one that is already applied runs nothing again.
 *
 * A refusal means the page was out of date (the proposal went stale, or the person's role
 * changed), so what the assistant proposes is read again before the refusal is passed on.
 */
export async function applyProposalIn(
  cache: QueryClient,
  client: Client,
  place: { readonly businessId: string; readonly conversationId: string },
  proposalId: string,
  changes?: ReplyContent,
): Promise<AppliedProposal> {
  let proposal: Proposal;
  try {
    proposal = await client.request(applyProposal, {
      params: { id: proposalId },
      body: changes === undefined ? {} : { changes: { ...changes } },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      await cache.invalidateQueries({
        queryKey: inboxKeys.assistant(place.businessId, place.conversationId),
      });
    }
    throw error;
  }
  await cache.invalidateQueries({ queryKey: inboxKeys.all(place.businessId) });
  const messageId = proposal.result?.messageId;
  const message = cache
    .getQueryData<Pages<ConversationThread>>(
      inboxKeys.thread(place.businessId, place.conversationId),
    )
    ?.pages.flatMap((page) => page.items)
    .find((item): item is ThreadMessage => item.kind === 'message' && item.id === messageId);
  return { proposal, message };
}
