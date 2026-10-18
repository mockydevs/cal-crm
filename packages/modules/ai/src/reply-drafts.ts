// Reply drafts as the product keeps them. The app cannot open a provider's key, so a draft
// is a row the app or an arriving message asks for and a job the worker runs:
//
//   1. one transaction reads the conversation, for the one business the job runs in, and
//      takes the request over;
//   2. the model is asked, through the gateway, outside any transaction (reply-draft.ts);
//   3. one transaction stores the answer as a proposal, if the thread is still the one the
//      draft was written for.
//
// The job only ever writes two things: the request's row and a proposal. It sends nothing.
// Where the business has told the inbox agent to act on its own, the job then applies its
// own proposal through the command layer as the assistant, which checks that rule itself.
import {
  defineCommand,
  defineTask,
  readAutonomy,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
  type Task,
  type TaskReference,
} from '@repo/commands';
import {
  draftOutcomes,
  draftReplyJob,
  requestReplyDraft,
  type ConversationAssistant,
  type DraftOutcome,
  type DraftRequest,
  type ReplyChannel,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { AppError, NotFoundError, toPublicId, type TenantContext } from '@repo/kernel';
import { randomUUID } from 'node:crypto';

import { aiReadiness } from './assistant-threads.js';
import { readAutonomySetting } from './autonomy-settings.js';
import type { AiGateway } from './gateway.js';
import { STANDING } from './memory.js';
import { factForPrompt } from './memory-rules.js';
import {
  applyProposal,
  PROPOSAL_TTL_MS,
  readConversationProposals,
  storeProposal,
  type ProposalOptions,
} from './proposals.js';
import {
  draftReply,
  type ReplyDraftKnowledge,
  type ReplyDraftMessage,
  type ReplyDraftResult,
} from './reply-draft.js';
import { oneOf } from './stored-words.js';

export const draftReplyReference = {
  name: 'ai.draft_reply',
  data: draftReplyJob,
} satisfies TaskReference<typeof draftReplyJob>;

/** How long a worker has to write a draft before the request is shown as expired. */
export const DRAFT_WINDOW_MS = 180_000;
/** How long a request that ended without a draft still says so beside the thread. */
const NOTICE_MS = 3_600_000;
/** The most of what the assistant knows about a contact that a draft is given. */
export const MEMORY_LIMITS = { facts: 20, summaryLength: 2000 } as const;

/** One conversation as the Inbox shows it to an assistant (messaging's readReplyContext). */
export interface DraftConversation {
  readonly conversationId: string;
  readonly contactId: string;
  readonly contactFirstName: string | null;
  readonly contactLocale: string | null;
  readonly businessName: string;
  readonly businessLocale: string;
  /** Oldest first. */
  readonly messages: readonly (Omit<ReplyDraftMessage, 'at'> & { readonly at: Date })[];
  readonly state: 'needs_reply' | 'answered' | 'automated' | 'cannot_reply';
  /** The thread's fingerprint. */
  readonly revision: string;
  readonly reply: {
    readonly channel: ReplyChannel;
    readonly accountId: string;
    readonly to: string | null;
    readonly subject: string | null;
  } | null;
}

/**
 * Finds a conversation of the request's business by its public id, through the module that
 * owns conversations: this module does not read another module's tables.
 */
export type FindConversation = (
  trx: DatabaseTransaction,
  publicConversationId: string,
) => Promise<{ readonly id: string; readonly contactId: string } | undefined>;

/** What a draft job came to, for the server's log: ids and categories, never words. */
export interface DraftEvent {
  readonly businessId: string;
  readonly conversationId: string;
  readonly outcome: DraftOutcome;
  readonly reason: string | null;
}

/** Where the job reads what is not the AI module's own. Each read is in the job's business. */
export interface ReplyDraftSources {
  /** One conversation, by its stored id, or undefined when it is not there. */
  conversation(
    trx: DatabaseTransaction,
    invocation: Invocation,
    conversationId: string,
  ): Promise<DraftConversation | undefined>;
  /**
   * What the business has written down for the assistant to draw on. The knowledge base
   * arrives in phase 2; until then this is what the server gives.
   */
  knowledge(
    trx: DatabaseTransaction,
    context: TenantContext,
  ): Promise<readonly ReplyDraftKnowledge[]>;
}

export interface ReplyDraftOptions extends ProposalOptions {
  readonly sources: ReplyDraftSources;
  /** Told how each request ended, to log it. */
  readonly onDraft?: (event: DraftEvent) => void;
  /** How long the model is waited for, in milliseconds: a minute unless said otherwise. */
  readonly timeoutMs?: number;
}

const columns = [
  'id',
  'conversation_id',
  'origin',
  'status',
  'outcome',
  'reason',
  'claim',
  'created_at',
  'expires_at',
  'finished_at',
] as const;

interface RequestRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly origin: string;
  readonly status: string;
  readonly outcome: string | null;
  readonly reason: string | null;
  readonly claim: string | null;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly finished_at: Date | null;
}

const FAILED: Readonly<Record<string, string>> = {
  timeout: 'The AI provider took too long to answer. Try again, or write your own reply.',
  rate_limited: 'The AI provider is busy right now. Try again shortly, or write your own reply.',
  unavailable: 'The AI provider is busy right now. Try again shortly, or write your own reply.',
  authentication:
    'The AI provider refused the key. Someone who manages AI can check it in Settings.',
  billing: 'The AI provider refused the account. Someone who manages AI can check it in Settings.',
};

/** Why there is no draft, in plain words. The Inbox has its own, translated; this is the API's. */
function wordsFor(outcome: DraftOutcome, reason: string | null): string | null {
  switch (outcome) {
    case 'drafted':
      return null;
    case 'refused':
      return 'The assistant declined to draft a reply to this. You can write your own.';
    case 'failed':
      return (
        FAILED[reason ?? ''] ?? 'The draft couldn’t be written. Try again, or write your own reply.'
      );
    case 'paused':
      return reason === 'price_unknown'
        ? 'The model chosen for replies has no price, so the spending limit can’t be kept. No draft was written.'
        : 'This month’s AI spending limit is reached, so no draft was written. You can still write your own reply.';
    case 'ai_off':
      return 'AI is turned off for this business.';
    case 'not_configured':
      return 'No AI provider is connected that can write replies.';
    case 'nothing_to_answer':
      return reason === 'automated'
        ? 'The last message was sent by a machine, such as an auto-reply, so no draft was written.'
        : 'There is nothing new to answer: the last message in this conversation is your own.';
    case 'cannot_reply':
      return 'No reply can be sent to this contact right now, so no draft was written.';
    case 'superseded':
      return 'The conversation moved on while the draft was being written.';
    case 'expired':
      return 'No draft was written: nothing picked the request up. Try again.';
  }
}

function asRequest(row: RequestRow, at: Date): DraftRequest {
  // A request nobody wrote in its window: no worker took the job.
  const expired = row.status === 'pending' && row.expires_at.getTime() <= at.getTime();
  const outcome: DraftOutcome | null = expired
    ? 'expired'
    : row.outcome === null
      ? null
      : oneOf(draftOutcomes, row.outcome);
  return {
    id: toPublicId('draft_request', row.id),
    status: outcome === null ? 'pending' : 'finished',
    outcome,
    reason: row.reason,
    message: outcome === null ? null : wordsFor(outcome, row.reason),
    origin: oneOf(['person', 'message'], row.origin),
    createdAt: row.created_at.toISOString(),
    finishedAt: expired ? row.expires_at.toISOString() : (row.finished_at?.toISOString() ?? null),
  };
}

const pendingOf = (trx: DatabaseTransaction, conversationId: string) =>
  trx
    .selectFrom('ai.draft_requests')
    .select(columns)
    .where('conversation_id', '=', conversationId)
    .where('status', '=', 'pending');

/** How a request ends, and when. Only a pending one is ended, so a request ends once. */
async function finish(
  trx: DatabaseTransaction,
  id: string,
  at: Date,
  outcome: DraftOutcome,
  more: {
    readonly reason?: string | undefined;
    readonly proposalId?: string | undefined;
    readonly requestId?: string | undefined;
  } = {},
): Promise<void> {
  await trx
    .updateTable('ai.draft_requests')
    .set({
      status: 'finished',
      outcome,
      reason: more.reason ?? null,
      proposal_id: more.proposalId ?? null,
      request_id: more.requestId ?? null,
      finished_at: at,
    })
    .where('id', '=', id)
    .where('status', '=', 'pending')
    .execute();
}

/** Tells open Inboxes of this business to read again. No row data is sent. */
async function notify(trx: DatabaseTransaction, businessId: string): Promise<void> {
  await trx
    .selectNoFrom((eb) =>
      eb.fn<null>('pg_notify', [eb.val('crm_business_changed'), eb.val(businessId)]).as('told'),
    )
    .execute();
}

/** A conversation of this business, or a NotFoundError. */
async function requireConversation(
  trx: DatabaseTransaction,
  find: FindConversation,
  publicConversationId: string,
): Promise<{ readonly id: string; readonly contactId: string }> {
  const found = await find(trx, publicConversationId);
  if (found === undefined) throw new NotFoundError('Conversation', publicConversationId);
  return found;
}

/**
 * Queues a draft for a conversation, in the command's transaction. A request that is
 * still being written is given back instead: asking twice asks the model once.
 */
async function startDraft(
  trx: DatabaseTransaction,
  command: CommandContext,
  conversationId: string,
  now: () => Date,
): Promise<DraftRequest> {
  const at = now();
  const waiting = await pendingOf(trx, conversationId).forUpdate().executeTakeFirst();
  if (waiting !== undefined) {
    if (waiting.expires_at.getTime() > at.getTime()) return asRequest(waiting, at);
    // Its window passed with no worker: closed, so that a new one can be asked for.
    await finish(trx, waiting.id, at, 'expired');
  }
  const row = await trx
    .insertInto('ai.draft_requests')
    .values({
      business_id: requireBusiness(command.context),
      conversation_id: conversationId,
      origin: 'person',
      requested_by_id: command.context.userId ?? null,
      created_at: at,
      expires_at: new Date(at.getTime() + DRAFT_WINDOW_MS),
    })
    .returning(columns)
    .executeTakeFirstOrThrow();
  command.enqueue(draftReplyReference, { conversationId });
  return asRequest(row, at);
}

/**
 * Asking for a draft needs the right to reply: a draft is a reply somebody may send, and
 * each one is a model call the business pays for.
 */
export function createRequestDraftCommand(
  now: () => Date,
  find: FindConversation,
): Command<typeof requestReplyDraft.params, DraftRequest> {
  return defineCommand({
    name: 'ai.request_reply_draft',
    permission: 'conversations.reply',
    input: requestReplyDraft.params,
    async handle(trx, { id }, command): Promise<DraftRequest> {
      const conversation = await requireConversation(trx, find, id);
      return startDraft(trx, command, conversation.id, now);
    },
  });
}

/** The outcomes of a draft nobody asked for that are not worth a word beside the thread. */
const QUIET: readonly DraftOutcome[] = [
  'nothing_to_answer',
  'cannot_reply',
  'ai_off',
  'not_configured',
];

/** What the Inbox shows of the assistant for one conversation. Reading calls no model. */
export async function readConversationAssistant(
  trx: DatabaseTransaction,
  invocation: Invocation,
  options: ProposalOptions,
  find: FindConversation,
  publicConversationId: string,
): Promise<ConversationAssistant> {
  const { context, permissions } = invocation;
  const at = (options.now ?? (() => new Date()))();
  const conversation = await requireConversation(trx, find, publicConversationId);
  const latest = await trx
    .selectFrom('ai.draft_requests')
    .select(columns)
    .where('conversation_id', '=', conversation.id)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const request = latest === undefined ? undefined : asRequest(latest, at);
  const { outcome } = request ?? { outcome: null };
  const draft =
    request === undefined
      ? null
      : outcome === null
        ? request
        : // A draft that was written speaks for itself, as a proposal; one that was
          // overtaken has another request after it or nothing left to say.
          outcome === 'drafted' ||
            outcome === 'superseded' ||
            (request.origin === 'message' && QUIET.includes(outcome)) ||
            new Date(request.finishedAt ?? request.createdAt).getTime() <= at.getTime() - NOTICE_MS
          ? null
          : request;
  return {
    ai: await aiReadiness(trx, context),
    canDraft: permissions === 'all' || permissions.has('conversations.reply'),
    autonomy: {
      ...(await readAutonomySetting(
        trx,
        { agent: 'inbox', action: 'send_message' },
        conversation.contactId,
      )),
      canChange: permissions === 'all' || permissions.has('ai.manage'),
    },
    draft,
    proposals: await readConversationProposals(trx, invocation, options, conversation.id),
  };
}

/**
 * What the assistant knows about a contact: the saved summary and the facts that stand,
 * for the one contact named, read under row-level security in the caller's business.
 *
 * A fact was read from what a contact wrote, so it is data wherever it goes next: each is
 * handed on as one line of at most a fact's length (a row written before the limits existed
 * is cut to them here), and the prompt that takes them puts them inside its data document,
 * between markers they cannot contain (reply-draft.ts). What is only proposed is not here
 * at all: a proposal is a row of ai.proposals, never a fact, until a person approves it or
 * the business lets the assistant keep facts on its own.
 */
export async function readContactKnowledge(
  trx: DatabaseTransaction,
  contactId: string,
): Promise<{ readonly summary: string | null; readonly facts: readonly string[] }> {
  const summary = await trx
    .selectFrom('ai.contact_summaries')
    .select('summary')
    .where('contact_id', '=', contactId)
    .executeTakeFirst();
  const facts = await trx
    .selectFrom('ai.contact_facts')
    .select('statement')
    .where('contact_id', '=', contactId)
    // A fact a person rejected, or a newer fact replaced, is no longer known.
    .where('status', 'in', STANDING)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(MEMORY_LIMITS.facts)
    .execute();
  return {
    summary: summary === undefined ? null : summary.summary.slice(0, MEMORY_LIMITS.summaryLength),
    facts: facts
      .map((fact) => factForPrompt(fact.statement))
      .filter((line) => line !== undefined)
      .reverse(),
  };
}

/** What a draft's answer is recorded as when there is none. */
function unfinished(result: Exclude<ReplyDraftResult, { readonly outcome: 'drafted' }>): {
  readonly outcome: DraftOutcome;
  readonly reason?: string;
  readonly requestId?: string;
} {
  switch (result.outcome) {
    case 'refused':
      return { outcome: 'refused', requestId: result.requestId };
    case 'failed':
      return { outcome: 'failed', reason: result.reason, requestId: result.requestId };
    case 'paused':
    case 'not_configured':
      return { outcome: result.outcome, reason: result.reason };
    case 'ai_off':
      return { outcome: 'ai_off' };
  }
}

/**
 * Writes the draft a request or an arriving message asked for. Only the worker has a
 * gateway that can open a key. The model is asked outside any database transaction.
 */
export function createDraftReplyTask(
  gateway: Pick<AiGateway, 'generate'>,
  options: ReplyDraftOptions,
): Task<typeof draftReplyReference.data> {
  const now = options.now ?? (() => new Date());
  return defineTask({
    ...draftReplyReference,
    async run({ conversationId }, { invocation, services }) {
      const businessId = requireBusiness(invocation.context);
      // The inbox agent, with what someone who answers the inbox may do and no more. It
      // reads through this context too, so its reads are this one business's.
      const agent: Invocation = {
        context: {
          agencyId: invocation.context.agencyId,
          businessId,
          actorKind: 'ai_agent',
          correlationId: invocation.context.correlationId,
        },
        permissions: new Set(['conversations.reply']),
        agent: 'inbox',
        ...(invocation.causationId === undefined ? {} : { causationId: invocation.causationId }),
      };
      const claim = randomUUID();
      const tell = (outcome: DraftOutcome, reason?: string): void => {
        options.onDraft?.({ businessId, conversationId, outcome, reason: reason ?? null });
      };

      const prepared = await withTenant(services.db, agent.context, async (trx) => {
        const conversation = await options.sources.conversation(trx, agent, conversationId);
        if (conversation === undefined) return undefined;
        const at = now();
        let waiting = await pendingOf(trx, conversation.conversationId)
          .forUpdate()
          .executeTakeFirst();
        if (waiting !== undefined && waiting.expires_at.getTime() <= at.getTime()) {
          await finish(trx, waiting.id, at, 'expired');
          waiting = undefined;
        }
        const request =
          waiting ??
          (await trx
            .insertInto('ai.draft_requests')
            .values({
              business_id: businessId,
              conversation_id: conversation.conversationId,
              origin: 'message',
              created_at: at,
              expires_at: new Date(at.getTime() + DRAFT_WINDOW_MS),
            })
            .returning(columns)
            .executeTakeFirstOrThrow());
        const end = async (
          outcome: DraftOutcome,
          more: Parameters<typeof finish>[4] = {},
        ): Promise<undefined> => {
          await finish(trx, request.id, at, outcome, more);
          await notify(trx, businessId);
          tell(outcome, more.reason);
          return undefined;
        };
        if (conversation.state === 'cannot_reply' || conversation.reply === null)
          return end('cannot_reply');
        if (conversation.state !== 'needs_reply')
          return end('nothing_to_answer', { reason: conversation.state });
        // A message asks for a draft once: when one written for this very thread already
        // waits, a job run again (after a crash, or a retry) asks the model nothing.
        if (request.origin === 'message') {
          const drafted = await trx
            .selectFrom('ai.proposals')
            .select(['id', 'revision'])
            .where('conversation_id', '=', conversation.conversationId)
            .where('kind', '=', 'reply')
            .where('status', '=', 'pending')
            .executeTakeFirst();
          if (drafted?.revision === conversation.revision)
            return end('drafted', { proposalId: drafted.id });
        }
        // This job's now: another job that took the request first finds this claim when
        // it comes back, and leaves its answer unused.
        await trx
          .updateTable('ai.draft_requests')
          .set({ claim })
          .where('id', '=', request.id)
          .execute();
        await notify(trx, businessId);
        return {
          requestId: request.id,
          conversation,
          reply: conversation.reply,
          memory: await readContactKnowledge(trx, conversation.contactId),
          knowledge: await options.sources.knowledge(trx, agent.context),
        };
      });
      if (prepared === undefined) return;
      const { conversation, reply, memory, knowledge } = prepared;

      const result = await draftReply(
        gateway,
        agent.context,
        {
          business: { name: conversation.businessName, locale: conversation.businessLocale },
          channel: reply.channel,
          contact: {
            firstName: conversation.contactFirstName,
            locale: conversation.contactLocale,
            summary: memory.summary,
            facts: memory.facts,
          },
          knowledge,
          messages: conversation.messages.map((message) => ({
            ...message,
            at: message.at.toISOString(),
          })),
        },
        options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
      );

      const stored = await withTenant(services.db, agent.context, async (trx) => {
        const request = await trx
          .selectFrom('ai.draft_requests')
          .select(columns)
          .where('id', '=', prepared.requestId)
          .forUpdate()
          .executeTakeFirst();
        // Another job took the request over, or it was closed: this answer is not used.
        if (request?.status !== 'pending' || request.claim !== claim) return undefined;
        if (result.outcome !== 'drafted') {
          const ended = unfinished(result);
          await finish(trx, request.id, now(), ended.outcome, ended);
          await notify(trx, businessId);
          tell(ended.outcome, ended.reason);
          return undefined;
        }
        const current = await options.sources.conversation(trx, agent, conversationId);
        // The contact wrote again, or someone answered, while the model was writing: the
        // draft answers a thread that has moved on. A new message has its own job.
        if (current?.revision !== conversation.revision || current.state !== 'needs_reply') {
          await finish(trx, request.id, now(), 'superseded', { requestId: result.requestId });
          await notify(trx, businessId);
          tell('superseded');
          return undefined;
        }
        const { level } = await readAutonomy(trx, {
          agent: 'inbox',
          action: 'send_message',
          contactId: conversation.contactId,
        });
        const proposal = await storeProposal(trx, agent, options.registry, {
          agent: 'inbox',
          kind: 'reply',
          input: {
            id: toPublicId('conversation', conversation.conversationId),
            reply: {
              channel: reply.channel,
              accountId: reply.accountId,
              to: reply.to,
              subject: reply.subject,
              text: result.text,
              // The proposal's own retry key: applying it twice sends once.
              idempotencyKey: `proposal-${randomUUID().replaceAll('-', '')}`,
            },
          },
          summary:
            conversation.contactFirstName === null
              ? 'Reply to this conversation'
              : `Reply to ${conversation.contactFirstName}`.slice(0, 500),
          autonomy: level,
          requestId: result.requestId,
          basis: {
            messages: conversation.messages.length,
            facts: memory.facts.length,
            summary: memory.summary !== null,
            knowledge: knowledge.map((item) => item.title),
          },
          expiresAt: new Date(now().getTime() + PROPOSAL_TTL_MS),
        });
        await finish(trx, request.id, now(), 'drafted', {
          proposalId: proposal.id,
          requestId: result.requestId,
        });
        await notify(trx, businessId);
        tell('drafted');
        return { id: proposal.id, level };
      });

      // "Act": the assistant applies its own proposal, as itself. The command layer reads
      // the rule again and refuses unless it still says act; the reply command and the
      // pipeline refuse what they would refuse anyone. A refusal leaves the draft waiting
      // for a person, which is where it would have been at any other level.
      if (stored?.level !== 'act') return;
      try {
        await applyProposal(services, options, agent, toPublicId('proposal', stored.id));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    },
  });
}
