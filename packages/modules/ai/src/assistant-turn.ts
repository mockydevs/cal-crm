// The worker's side of the in-app assistant: the job that runs one turn. Only the worker
// has a gateway that can open a provider's key.
//
//   1. one transaction takes the turn over, reads the person's permissions as they are
//      now, and reads what was said before and what the page shows;
//   2. the loop runs outside any transaction (assistant-loop.ts): each model call goes
//      through the gateway, each tool call runs one of the API's own routes as the
//      assistant, for that person and with their permissions, and each step writes its
//      message in a short transaction of its own;
//   3. one transaction records how the turn ended.
//
// Who does what:
//   * the job itself (the system) reads and writes the conversation: row-level security
//     lets nobody else but the person;
//   * a tool runs as actor `ai_agent`, agent `copilot`, carrying the person's id and their
//     permissions, under the correlation id of the request that sent the message. The
//     command layer then holds it to the business's autonomy rules, like any assistant;
//   * a tool that would make something live is never run: a proposal is stored, which the
//     person applies through the API, as themselves.
//
// A job can run twice. A turn found running was being run when a worker died: it is ended
// as interrupted, never run again, since what its tools did cannot be undone or repeated.
import {
  defineTask,
  proposableOf,
  readAutonomy,
  requireBusiness,
  type Invocation,
  type JsonRecord,
  type Proposable,
  type Task,
} from '@repo/commands';
import {
  ASSISTANT_LIMITS,
  assistantToolEffects,
  type AssistantCheck,
  type AssistantChip,
  type AssistantContext,
  type AssistantPageContext,
  type AssistantTurnOutcome,
  type Permission,
  type ProposalKind,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction, type Json } from '@repo/db';
import { AppError, ForbiddenError, toPublicId, type TenantContext } from '@repo/kernel';

import {
  ASSISTANT_MAX_OUTPUT_TOKENS,
  ASSISTANT_PROMPT_VERSION,
  ASSISTANT_SYSTEM,
  assistantData,
  assistantUserMessage,
  runAssistantLoop,
  type AssistantLoopResult,
  type LoopTool,
  type ToolOutcome,
} from './assistant-loop.js';
import {
  appendMessage,
  assistantTurnReference,
  finishTurn,
  pageOf,
  type NewMessage,
  type TurnRow,
} from './assistant-threads.js';
import { refusalText, type AssistantToolbox } from './assistant-toolbox.js';
import type { AiGateway, AiJob } from './gateway.js';
import { dollarsToMicros, microsToDollars } from './pricing.js';
import { PROPOSAL_TTL_MS, storeProposal } from './proposals.js';
import type { AiMessage, JsonObject } from './provider.js';
import { advanceCheckpoint, checkpointData, readCheckpoint } from './assistant-checkpoint.js';
import { withAssistantCancellation } from './assistant-cancellation.js';
import { refreshAssistantInvocation } from './assistant-permissions.js';

/**
 * The job whose model the assistant uses: the one chosen for building, which is the most
 * capable a business has configured. Its calls are told apart in ai.requests by their
 * prompt version.
 */
export const ASSISTANT_JOB: AiJob = 'automation_builder';

/** What was said before that a turn is given: so many messages, each cut to so long. */
export const HISTORY_LIMITS = { messages: 30, length: 4000 } as const;

/** How a tool that makes something live becomes a proposal. */
export interface AssistantConfirmation {
  /** The kind of proposal it stores, which names the command a person's Apply runs. */
  readonly kind: ProposalKind;
  /** That command's input, from the tool's path parameters and body. */
  input(call: { readonly params: JsonRecord; readonly body: JsonRecord }): JsonRecord;
  /** One line for the card, from what the proposal would do. Never the model's words. */
  summary(change: JsonRecord): string;
}

/** What the server read about a page for the person: its record, and what is missing. */
export interface AssistantPage {
  readonly subject: AssistantContext['subject'];
  readonly checks: readonly AssistantCheck[];
  /** Things to ask from this page. Left out, the panel offers the general ones. */
  readonly chips?: readonly AssistantChip[] | undefined;
}

/** What a turn came to, for the server's log: ids, counts and categories, never words. */
export interface AssistantTurnEvent {
  readonly businessId: string;
  readonly turnId: string;
  readonly outcome: AssistantTurnOutcome;
  readonly reason: string | null;
  readonly steps: number;
}

export interface AssistantTurnOptions {
  /** The tools, as the API's own routes. */
  readonly toolbox: AssistantToolbox;
  /** Every command that can be proposed, from the modules that own them. */
  readonly proposables: readonly Proposable[];
  /** By operation: the tools that make something live, and the proposal each stores. */
  readonly confirmations: Readonly<Record<string, AssistantConfirmation>>;
  /**
   * What the person's role allows in the job's business now, or undefined when they no
   * longer work there: from the module that owns memberships.
   */
  grants(
    trx: DatabaseTransaction,
    context: TenantContext,
    userId: string,
  ): Promise<ReadonlySet<Permission> | undefined>;
  /** What a page shows, read for the person, with no model. */
  page(
    trx: DatabaseTransaction,
    invocation: Invocation,
    page: AssistantPageContext,
  ): Promise<AssistantPage>;
  readonly now?: () => Date;
  readonly onTurn?: (event: AssistantTurnEvent) => void;
  /** A fault of the server's own while a turn ran: for the log. */
  readonly onFault?: (turnId: string, error: unknown) => void;
  /** The turn's limits. The product's own unless a test hands shorter ones. */
  readonly limits?: Partial<{ steps: number; durationMs: number; callMs: number }>;
}

/** What the model is told when a tool that makes something live was called. */
const PROPOSED = assistantData({
  proposed: true,
  message:
    'Nothing was published. A card is now waiting in the conversation for the person to confirm or dismiss. Tell them it is waiting.',
});

/** Runs the turn a person's message started. */
export function createAssistantTurnTask(
  gateway: Pick<AiGateway, 'generate'>,
  options: AssistantTurnOptions,
): Task<typeof assistantTurnReference.data> {
  const now = options.now ?? (() => new Date());
  const { toolbox } = options;
  const limits = {
    steps: options.limits?.steps ?? ASSISTANT_LIMITS.stepsPerTurn,
    durationMs: options.limits?.durationMs ?? ASSISTANT_LIMITS.turnMinutes * 60_000,
    // A step is a person waiting at a panel: two minutes for one answer, at most.
    callMs: options.limits?.callMs ?? 120_000,
  };

  return defineTask({
    ...assistantTurnReference,
    async run({ turnId }, { invocation: job, services }) {
      const businessId = requireBusiness(job.context);
      const { db } = services;
      // Asked for first: a worker that does not have its tools yet fails here, before the
      // turn is touched, so the job is tried again and the turn is still there to run.
      const { tools } = toolbox;
      const tell = (outcome: AssistantTurnOutcome, reason: string | null, steps: number): void => {
        options.onTurn?.({ businessId, turnId, outcome, reason, steps });
      };
      /** One short transaction as the job: the conversation is the system's to write. */
      const write = <Answer>(work: (trx: DatabaseTransaction) => Promise<Answer>) =>
        withTenant(db, job.context, work);
      const markUncertain = async (trx: DatabaseTransaction, turn: TurnRow): Promise<void> => {
        const unfinished = await trx
          .selectFrom('ai.assistant_tool_calls')
          .select(['call_id', 'operation_id', 'effect', 'command_name'])
          .where('turn_id', '=', turn.id)
          .where('state', '=', 'started')
          .execute();
        for (const call of unfinished) {
          const tool = tools.find((each) => each.operationId === call.operation_id);
          const effect = assistantToolEffects.find((value) => value === call.effect);
          if (effect === undefined) throw new Error('Invalid stored tool effect.');
          const committed =
            call.command_name === null
              ? undefined
              : await trx
                  .selectFrom('audit.commands')
                  .select('outcome')
                  .where('business_id', '=', businessId)
                  .where('assistant_tool_call_id', '=', call.call_id)
                  .where('command', '=', call.command_name)
                  .orderBy('recorded_at', 'desc')
                  .orderBy('id', 'desc')
                  .executeTakeFirst();
          const state =
            committed === undefined
              ? 'uncertain'
              : committed.outcome === 'ok'
                ? 'completed'
                : 'failed';
          await appendMessage(
            trx,
            businessId,
            {
              threadId: turn.thread_id,
              turnId: turn.id,
              userId: turn.user_id,
              kind: 'activity',
              text:
                state === 'completed'
                  ? `Confirmed recorded completion: ${tool?.definition.description.split('. ')[0] ?? 'the operation'}.`
                  : state === 'failed'
                    ? 'The command audit confirms this operation did not succeed.'
                    : `Could not confirm completion: ${tool?.definition.description.split('. ')[0] ?? 'an interrupted operation'}. Review the record before continuing.`,
              activity: {
                operationId: call.operation_id,
                effect,
                ok: state === 'completed',
                target: null,
                callId: call.call_id,
                state,
              },
            },
            now(),
          );
          await trx
            .updateTable('ai.assistant_tool_calls')
            .set({ state, finished_at: now() })
            .where('turn_id', '=', turn.id)
            .where('call_id', '=', call.call_id)
            .where('state', '=', 'started')
            .execute();
        }
      };

      const prepared = await write(async (trx) => {
        const turn: TurnRow | undefined = await trx
          .selectFrom('ai.assistant_turns')
          .select([
            'id',
            'thread_id',
            'user_id',
            'status',
            'outcome',
            'reason',
            'page',
            'cancel_requested_at',
            'steps',
            'cost_estimate',
            'correlation_id',
            'created_at',
            'started_at',
            'finished_at',
          ])
          .where('id', '=', turnId)
          .forUpdate()
          .executeTakeFirst();
        // Deleted with its thread, cancelled before a worker took it, or already run.
        if (turn === undefined || turn.status === 'finished') return undefined;
        const end = async (outcome: AssistantTurnOutcome): Promise<undefined> => {
          await finishTurn(trx, businessId, turn, { outcome }, now());
          tell(outcome, null, turn.steps);
          return undefined;
        };
        // A worker died while it ran. What its tools did stays done, so it is not run again.
        if (turn.status === 'running') {
          await markUncertain(trx, turn);
          return end('interrupted');
        }
        if (turn.cancel_requested_at !== null) return end('cancelled');
        // The person's role as it is now, not as it was when they wrote.
        const grants = await options.grants(trx, job.context, turn.user_id);
        if (grants?.has('assistant.use') !== true) return end('no_access');

        await trx
          .updateTable('ai.assistant_turns')
          .set({ status: 'running', started_at: now() })
          .where('id', '=', turn.id)
          .execute();
        // The assistant, for this person: their permissions and no more, and the id of
        // the request that asked, which every command a tool runs is audited under.
        const agent: Invocation = {
          context: {
            agencyId: job.context.agencyId,
            businessId,
            userId: turn.user_id,
            actorKind: 'ai_agent',
            correlationId: turn.correlation_id,
          },
          permissions: grants,
          agent: 'copilot',
          ...(job.causationId === undefined ? {} : { causationId: job.causationId }),
        };
        const said = await trx
          .selectFrom('ai.assistant_messages')
          .select(['turn_id', 'kind', 'text', 'seq'])
          .where('thread_id', '=', turn.thread_id)
          .where('kind', 'in', ['user', 'assistant'])
          .orderBy('seq', 'desc')
          .limit(HISTORY_LIMITS.messages + 1)
          .execute();
        const asked = said.find((row) => row.turn_id === turn.id && row.kind === 'user');
        const saved = await trx
          .selectFrom('ai.assistant_threads')
          .select('checkpoint')
          .where('id', '=', turn.thread_id)
          .executeTakeFirstOrThrow();
        const previous = readCheckpoint(saved.checkpoint);
        const additions = await trx
          .selectFrom('ai.assistant_messages')
          .select(['seq', 'kind', 'text', 'activity', 'proposal_id'])
          .where('thread_id', '=', turn.thread_id)
          .where('seq', '>', previous.throughSeq)
          .orderBy('seq')
          .limit(1000)
          .execute();
        const checkpoint = advanceCheckpoint(
          previous,
          additions.map((row) => ({
            ...row,
            proposal_id: row.proposal_id === null ? null : toPublicId('proposal', row.proposal_id),
          })),
        );
        await trx
          .updateTable('ai.assistant_threads')
          .set({ checkpoint: JSON.parse(JSON.stringify(checkpoint)) as Json })
          .where('id', '=', turn.thread_id)
          .execute();
        const page = pageOf(turn);
        let shown: AssistantPage = { subject: null, checks: [] };
        try {
          shown = await options.page(trx, agent, page);
        } catch (error) {
          // A record that is gone, or not this person's to read, is simply not shown.
          if (!(error instanceof AppError)) throw error;
        }
        return {
          turn,
          agent,
          grants,
          checkpoint,
          message: asked?.text ?? '',
          history: said
            .filter((row) => row.turn_id !== turn.id)
            .slice(0, HISTORY_LIMITS.messages)
            .reverse(),
          data: {
            page,
            subject: shown.subject,
            checks: shown.checks.map(({ severity, code, message }) => ({
              severity,
              code,
              message,
            })),
            today: now().toISOString().slice(0, 10),
          },
        };
      });
      if (prepared === undefined) return;
      const { turn, agent } = prepared;
      const currentAgent = () =>
        refreshAssistantInvocation(agent, () =>
          write((trx) => options.grants(trx, job.context, turn.user_id)),
        );

      const say = (message: Omit<NewMessage, 'threadId' | 'turnId' | 'userId'>) =>
        write((trx) =>
          appendMessage(
            trx,
            businessId,
            { ...message, threadId: turn.thread_id, turnId: turn.id, userId: turn.user_id },
            now(),
          ),
        );

      /** A tool that reads or drafts: the API's own route, as the assistant. */
      const run = async (
        tool: LoopTool,
        input: JsonObject,
        identity: { requestId: string; toolCallId: string },
      ): Promise<ToolOutcome> => {
        const ran = await toolbox.run(tool, input, {
          ...(await currentAgent()),
          assistantToolCallId: `${identity.requestId}:${identity.toolCallId}`,
        });
        await say({
          kind: 'activity',
          text: ran.activity.text,
          activity: {
            operationId: tool.operationId,
            effect: tool.effect,
            ok: ran.ok,
            callId: `${identity.requestId}:${identity.toolCallId}`,
            state: ran.ok ? 'completed' : 'failed',
            target: ran.activity.target,
          },
        });
        return { ok: ran.ok, text: ran.text };
      };

      /** A tool that makes something live: stored as a proposal, for the person to decide. */
      const propose = async (
        tool: LoopTool,
        input: JsonObject,
        identity: { requestId: string; toolCallId: string },
      ): Promise<ToolOutcome> => {
        const proposalAgent = await currentAgent();
        const refused = async (text: string): Promise<ToolOutcome> => {
          await say({
            kind: 'activity',
            text: `Could not propose: ${tool.definition.description.split('. ')[0]?.toLowerCase() ?? tool.operationId}`,
            activity: {
              operationId: tool.operationId,
              effect: tool.effect,
              ok: false,
              target: null,
            },
          });
          return { ok: false, text };
        };
        const confirmation = options.confirmations[tool.operationId];
        const proposable =
          confirmation === undefined
            ? undefined
            : proposableOf(options.proposables, confirmation.kind);
        if (confirmation === undefined || proposable === undefined)
          return refused(
            assistantData({ error: 'unavailable', message: 'This cannot be proposed here.' }),
          );
        const call = toolbox.check(tool, input);
        if (!call.ok) return refused(call.text);
        // A card the person could not press is no use to them: said now, to the model.
        if (!proposalAgent.permissions.has(proposable.permission))
          return refused(
            refusalText(
              new ForbiddenError(
                `The person's role doesn't allow this: it needs ${proposable.permission}.`,
                proposable.permission,
              ),
            ),
          );
        try {
          const proposed = confirmation.input(call);
          await write(async (trx) => {
            // What it would do, read now: its problems, if it has any, are the answer.
            const change = await proposable.present(trx, proposed, proposalAgent);
            const summary = confirmation.summary(change);
            const { level } = await readAutonomy(trx, {
              agent: 'copilot',
              action: proposable.action,
            });
            const { id } = await storeProposal(trx, proposalAgent, options.proposables, {
              agent: 'copilot',
              kind: confirmation.kind,
              input: proposed,
              summary,
              autonomy: level,
              expiresAt: new Date(now().getTime() + PROPOSAL_TTL_MS),
            });
            await appendMessage(
              trx,
              businessId,
              {
                threadId: turn.thread_id,
                turnId: turn.id,
                userId: turn.user_id,
                kind: 'proposal',
                text: summary,
                proposalId: id,
              },
              now(),
            );
            await trx
              .updateTable('ai.assistant_tool_calls')
              .set({ state: 'completed', finished_at: now() })
              .where('turn_id', '=', turn.id)
              .where('call_id', '=', `${identity.requestId}:${identity.toolCallId}`)
              .where('state', 'in', ['started', 'uncertain'])
              .execute();
          });
          return { ok: true, text: PROPOSED };
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          return refused(refusalText(error));
        }
      };

      const history: AiMessage[] = [];
      for (const row of prepared.history) {
        const text = row.text.slice(0, HISTORY_LIMITS.length);
        // What the assistant said before goes back as its own words, and nothing else of
        // an earlier turn does: its tool calls are done, and their results may be stale.
        history.push(
          row.kind === 'user'
            ? { role: 'user', text }
            : { role: 'assistant', parts: [{ type: 'text', text }] },
        );
      }
      // A provider's conversation starts with a person and alternates: what does not is
      // left out from the front, and two in a row from the same side are joined.
      const messages = alternating([
        ...history,
        {
          role: 'user',
          text: `${checkpointData(prepared.checkpoint)}\n\n${assistantUserMessage(prepared.data, prepared.message)}`,
        },
      ]);

      const cancelled = () =>
        write(async (trx) => {
          const row = await trx
            .selectFrom('ai.assistant_turns')
            .select(['cancel_requested_at', 'status'])
            .where('id', '=', turn.id)
            .executeTakeFirst();
          return row === undefined || row.status === 'finished' || row.cancel_requested_at !== null;
        });

      let result: AssistantLoopResult;
      const deadline = now().getTime() + limits.durationMs;
      try {
        result = await runAssistantLoop({
          messages,
          tools,
          onProgress: (progress) =>
            write(async (trx) => {
              await trx
                .updateTable('ai.assistant_turns')
                .set({
                  steps: progress.steps,
                  cost_estimate:
                    progress.costMicros === null ? null : microsToDollars(progress.costMicros),
                })
                .where('id', '=', turn.id)
                .where('status', '=', 'running')
                .execute();
            }),
          onTool: (event) =>
            write(async (trx) => {
              const callId = `${event.requestId}:${event.toolCallId}`;
              if (event.state === 'started') {
                await trx
                  .insertInto('ai.assistant_tool_calls')
                  .values({
                    business_id: businessId,
                    thread_id: turn.thread_id,
                    turn_id: turn.id,
                    user_id: turn.user_id,
                    call_id: callId,
                    operation_id: event.tool.operationId,
                    command_name: event.tool.commandName ?? null,
                    effect: event.tool.effect,
                    started_at: now(),
                    state: 'started',
                    finished_at: null,
                  })
                  .execute();
                await appendMessage(
                  trx,
                  businessId,
                  {
                    threadId: turn.thread_id,
                    turnId: turn.id,
                    userId: turn.user_id,
                    kind: 'activity',
                    text: `Working: ${event.tool.definition.description.split('. ')[0] ?? event.tool.operationId}`,
                    activity: {
                      operationId: event.tool.operationId,
                      effect: event.tool.effect,
                      ok: true,
                      target: null,
                      callId,
                      state: 'started',
                    },
                  },
                  now(),
                );
              } else {
                await trx
                  .updateTable('ai.assistant_tool_calls')
                  .set({ state: event.state, finished_at: now() })
                  .where('turn_id', '=', turn.id)
                  .where('call_id', '=', callId)
                  .where('state', 'in', ['started', 'uncertain'])
                  .execute();
                if (
                  event.tool.effect === 'confirm' ||
                  event.outcome?.text === 'Stopped before this tool ran.'
                ) {
                  await appendMessage(
                    trx,
                    businessId,
                    {
                      threadId: turn.thread_id,
                      turnId: turn.id,
                      userId: turn.user_id,
                      kind: 'activity',
                      text:
                        event.outcome?.text === 'Stopped before this tool ran.'
                          ? event.outcome.text
                          : event.state === 'completed'
                            ? 'Prepared a confirmation card. Nothing was made live.'
                            : 'Could not prepare this confirmation.',
                      activity: {
                        operationId: event.tool.operationId,
                        effect: event.tool.effect,
                        ok: event.state === 'completed',
                        target: null,
                        callId,
                        state: event.state,
                      },
                    },
                    now(),
                  );
                }
              }
            }),
          generate: async (conversation, timeoutMs) => {
            const invocation = await currentAgent();
            return withAssistantCancellation(
              async () => (await cancelled()) || now().getTime() >= deadline,
              (signal) =>
                gateway.generate(
                  invocation.context,
                  {
                    job: ASSISTANT_JOB,
                    promptVersion: ASSISTANT_PROMPT_VERSION,
                    system: ASSISTANT_SYSTEM,
                    messages: conversation,
                    tools: tools.map((tool) => tool.definition),
                    maxOutputTokens: ASSISTANT_MAX_OUTPUT_TOKENS,
                  },
                  { timeoutMs, signal },
                ),
            );
          },
          run,
          propose,
          say: async (text, requestId) => {
            await say({ kind: 'assistant', text, requestId });
          },
          cancelled,
          now: () => now().getTime(),
          limits,
        });
      } catch (error) {
        // A fault of the server's own. The turn ends saying so, and is not run again.
        const stopped = await cancelled();
        const expired = now().getTime() >= deadline;
        const revoked = error instanceof ForbiddenError;
        if (!stopped && !expired && !revoked) options.onFault?.(turnId, error);
        const progress = await write((trx) =>
          trx
            .selectFrom('ai.assistant_turns')
            .select(['steps', 'cost_estimate'])
            .where('id', '=', turn.id)
            .executeTakeFirstOrThrow(),
        );
        result = {
          outcome: stopped
            ? 'cancelled'
            : expired
              ? 'time_limit'
              : revoked
                ? 'no_access'
                : 'failed',
          reason: stopped || expired || revoked ? null : 'internal',
          steps: progress.steps,
          costMicros:
            progress.cost_estimate === null ? null : dollarsToMicros(progress.cost_estimate),
        };
      }

      await write(async (trx) => {
        await markUncertain(trx, turn);
        return finishTurn(
          trx,
          businessId,
          turn,
          {
            outcome: result.outcome,
            reason: result.reason,
            steps: result.steps,
            costEstimate: result.costMicros === null ? null : microsToDollars(result.costMicros),
          },
          now(),
        );
      });
      tell(result.outcome, result.reason, result.steps);
    },
  });
}

/**
 * A conversation as a provider takes one: it starts with the person, and the two sides
 * take turns. Earlier turns that ended without an answer leave two messages from the
 * person in a row; those are joined, and anything of the assistant's before the person's
 * first is left out.
 */
export function alternating(messages: readonly AiMessage[]): AiMessage[] {
  const out: AiMessage[] = [];
  for (const message of messages) {
    const last = out.at(-1);
    if (last === undefined) {
      if (message.role === 'user') out.push(message);
      continue;
    }
    if (message.role === 'user' && last.role === 'user')
      out[out.length - 1] = { role: 'user', text: `${last.text}\n\n${message.text}` };
    else if (message.role === 'assistant' && last.role === 'assistant')
      out[out.length - 1] = { role: 'assistant', parts: [...last.parts, ...message.parts] };
    else out.push(message);
  }
  return out;
}
