import { requireBusiness, type ApiRoute, type Route } from '@repo/commands';
export { aiContactMerge } from './contact-merge.js';
export { createContactJourneyRoute } from './assistant-journey.js';
import { getContactMemory, parseInput, type ContactMemory } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { requireRecord } from '@repo/module-crm';

export {
  checkBaseUrl,
  parseLocalServers,
  type LocalServer,
  type ServerUrlCheck,
  type ServerUrlProblem,
} from './addresses.js';
export { createAssistantRoutes, type AssistantOptions } from './assistant-routes.js';
// The in-app assistant: its conversations' routes, the job that runs a turn, and the tools
// it runs, which are the API's own routes.
export { createAssistantChatRoutes, type AssistantChatOptions } from './assistant-chat-routes.js';
export type { LoopTool } from './assistant-loop.js';
export {
  createAssistantToolbox,
  type AssistantToolbox,
  type AssistantToolboxOptions,
  type ToolRun,
} from './assistant-toolbox.js';
export {
  createAssistantTurnTask,
  type AssistantConfirmation,
  type AssistantPage,
  type AssistantTurnEvent,
  type AssistantTurnOptions,
} from './assistant-turn.js';
export { createTestAiConnectionTask } from './connection-tests.js';
export { readAiModelsIntegration } from './integration-reading.js';
export type { PeopleNames, SecretSealer } from './connections.js';
export {
  AI_JOBS,
  AI_KEY_PURPOSE,
  CONNECTION_TEST_JOB,
  createAiGateway,
  DEFAULT_JOB_MODELS,
  type AiGateway,
  type AiGatewayOptions,
  type AiJob,
  type ConnectionProblem,
  type ConnectionTestResult,
  type GatewayCallOptions,
  type GatewayEvent,
  type GatewayRequest,
  type GatewayResult,
  type KeyCheckResult,
  type RecordedJob,
  type SecretReader,
} from './gateway.js';
export {
  createExtractContactTask,
  type ExtractionConversation,
  type ExtractionEvent,
  type ExtractionOptions,
  type ExtractionSourceMessage,
  type ExtractionSources,
} from './extractions.js';
export { expireAiProposals, expireAiRequestLogs, expireAssistantThreads } from './maintenance.js';
// Contact memory's facts: the routes people read and correct them by, and the one command
// an assistant may propose. No route writes a new fact.
export {
  createMemoryProposables,
  createMemoryRoutes,
  type FindFactConversation,
  type MemoryOptions,
} from './memory.js';
// What an assistant in any module needs to propose: storing one. Applying, dismissing and
// undoing are the routes' (assistant-routes.ts), and run the proposal's own command.
export { storeProposal, type ProposalDraft, type ProposalOptions } from './proposals.js';
export type { ReplyDraftKnowledge } from './reply-draft.js';
export {
  createDraftReplyTask,
  type DraftConversation,
  type DraftEvent,
  type FindConversation,
  type ReplyDraftOptions,
  type ReplyDraftSources,
} from './reply-drafts.js';
export { createAiSettingsRoutes, type AiSettingsOptions } from './settings-routes.js';
export { maskContactDetails } from './masking.js';
export {
  BUILT_IN_PRICES,
  dollarsToMicros,
  estimateCostMicros,
  microsToDollars,
  priceKey,
  type PriceSource,
} from './pricing.js';
export {
  AI_PROVIDERS,
  PROVIDER_ERROR_CODES,
  textOf,
  toolCallsOf,
  type AiMessage,
  type AiProvider,
  type AiProviderName,
  type AssistantPart,
  type JsonObject,
  type ModelList,
  type ModelPrices,
  type ProviderCallOptions,
  type ProviderErrorCode,
  type ProviderRequest,
  type ProviderResponse,
  type StopReason,
  type TokenUsage,
  type ToolDefinition,
  type ToolResult,
} from './provider.js';
export type { AiTransport } from './transport.js';

/** AI owns saved memory; reading it never starts generation or a provider request. */
export const aiRoutes: readonly ApiRoute[] = [
  {
    endpoint: getContactMemory,
    async run({ invocation, params }, { db }): Promise<ContactMemory> {
      const businessId = requireBusiness(invocation.context);
      const { id } = parseInput(getContactMemory.params, params);
      return withTenant(db, invocation.context, async (trx) => {
        // CRM's public reader applies its visibility rules, including retained trash.
        const record = await requireRecord(trx, id);
        const row = await trx
          .selectFrom('ai.contact_summaries')
          .select(['summary', 'updated_at', 'through_event_id'])
          .where('business_id', '=', businessId)
          .where('contact_id', '=', record.id)
          .executeTakeFirst();
        return {
          summary:
            row === undefined
              ? null
              : {
                  text: row.summary,
                  updatedAt: row.updated_at.toISOString(),
                  throughEventId:
                    row.through_event_id === null
                      ? null
                      : toPublicId('event', row.through_event_id),
                },
        };
      });
    },
  } satisfies Route<typeof getContactMemory>,
];
