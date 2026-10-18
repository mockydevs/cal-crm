// The API of the in-app assistant's conversations: a person's own threads, the turns they
// start and stop, the messages a turn writes, and what is missing on a page.
//
//   * no route here calls a model. A message is stored and queued; the worker runs it
//     (assistant-turn.ts);
//   * a thread is its person's alone: row-level security shows it to nobody else, so
//     another person's thread is not found, whatever their role;
//   * starting a turn, stopping one and deleting a thread need `assistant.use`, which every
//     built-in role has. What the assistant then does is held to the rest of the role;
//   * a proposal a turn stored is decided with the proposals' own routes (applyProposal,
//     dismissProposal, undoProposal), which run its command as whoever decides;
//   * the page's checks answer with no model and no provider: they are worked out by the
//     server from the record, as the person may read it.
import {
  requireBusiness,
  runCommand,
  type ApiRoute,
  type Invocation,
  type Proposable,
  type Route,
} from '@repo/commands';
import {
  ASSISTANT_LIMITS,
  cancelAssistantTurn,
  createAssistantThread,
  deleteAssistantThread,
  getAssistantContext,
  getAssistantThread,
  getAssistantTurn,
  listAssistantMessages,
  listAssistantThreads,
  parseInput,
  postAssistantTurn,
  type AssistantChip,
  type AssistantContext,
  type AssistantPageContext,
  type AssistantTurnStarted,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { AppError } from '@repo/kernel';
import type { ActorNames } from '@repo/module-crm';

import {
  aiReadiness,
  cancelTurnCommand,
  deleteThreadCommand,
  readinessWords,
  readMessages,
  readThread,
  readThreads,
  readTurn,
  startTurnCommand,
  type TurnStart,
} from './assistant-threads.js';
import type { AssistantPage } from './assistant-turn.js';
import type { ProposalOptions } from './proposals.js';

export interface AssistantChatOptions {
  /** Every command that can be proposed: a thread shows a proposal as it stands now. */
  readonly proposables: readonly Proposable[];
  /** Who decided a proposal, by name. */
  readonly actorNames: ActorNames;
  /**
   * What a page shows, read for whoever asks, with no model: the record it is about, what
   * is wrong or missing there, and things to ask. From the modules that own the pages.
   */
  page(
    trx: DatabaseTransaction,
    invocation: Invocation,
    page: AssistantPageContext,
  ): Promise<AssistantPage>;
  readonly now?: () => Date;
}

/** What can be asked from any page. */
export const GENERAL_CHIPS: readonly AssistantChip[] = [
  {
    code: 'general.what_can_you_do',
    label: 'What can you help with?',
    prompt: 'What can you help me with here?',
  },
  {
    code: 'general.build_form',
    label: 'Build a form for me',
    prompt: 'Build a form for me. Ask me what it is for and what it should collect.',
  },
];

const NOT_ALLOWED = 'Your role doesn’t include the assistant. Ask someone who manages the team.';

export function createAssistantChatRoutes(options: AssistantChatOptions): readonly ApiRoute[] {
  const now = options.now ?? (() => new Date());
  const proposals: ProposalOptions = {
    registry: options.proposables,
    actorNames: options.actorNames,
    now,
  };
  const start = startTurnCommand({ now });
  const cancel = cancelTurnCommand({ now });
  const remove = deleteThreadCommand();

  /** A turn that was just started, as its routes answer: the thread, the turn, the message. */
  const started = (
    invocation: Invocation,
    { db }: { readonly db: Parameters<typeof withTenant>[0] },
    turn: TurnStart,
  ): Promise<AssistantTurnStarted> =>
    withTenant(db, invocation.context, async (trx) => {
      const thread = await readThread(trx, invocation, turn.threadId);
      const { items } = await readMessages(trx, invocation, proposals, turn.threadId, {
        after: turn.messageSeq - 1,
        limit: 1,
      });
      const [message] = items;
      if (thread.turn === null || message === undefined)
        throw new Error('A turn that was just started cannot be read back.');
      return { thread, turn: thread.turn, message };
    });

  return [
    {
      endpoint: getAssistantContext,
      run({ invocation, body }, { db }) {
        requireBusiness(invocation.context);
        const page = parseInput(getAssistantContext.body, body);
        return withTenant(db, invocation.context, async (trx): Promise<AssistantContext> => {
          const ai = await aiReadiness(trx, invocation.context);
          const canUse =
            invocation.permissions === 'all' || invocation.permissions.has('assistant.use');
          let shown: AssistantPage = { subject: null, checks: [] };
          try {
            shown = await options.page(trx, invocation, page);
          } catch (error) {
            // A record that is gone, or of another business, is a page with nothing to say.
            if (!(error instanceof AppError)) throw error;
          }
          return {
            ai,
            canUse,
            message: canUse ? readinessWords(ai) : NOT_ALLOWED,
            connect:
              ai === 'not_connected'
                ? { kind: 'ai_settings', id: null, section: null, path: null }
                : null,
            subject: shown.subject,
            // What stops the thing working comes first.
            checks: [
              ...shown.checks.filter((check) => check.severity === 'blocker'),
              ...shown.checks.filter((check) => check.severity !== 'blocker'),
            ],
            chips: [...(shown.chips ?? GENERAL_CHIPS)],
          };
        });
      },
    } satisfies Route<typeof getAssistantContext>,
    {
      endpoint: listAssistantThreads,
      run({ invocation, query }, { db }) {
        requireBusiness(invocation.context);
        const input = parseInput(listAssistantThreads.query, query);
        return withTenant(db, invocation.context, (trx) => readThreads(trx, invocation, input));
      },
    } satisfies Route<typeof listAssistantThreads>,
    {
      endpoint: createAssistantThread,
      command: start,
      async run({ invocation, body }, services) {
        return started(invocation, services, await runCommand(services, start, body, invocation));
      },
    } satisfies Route<typeof createAssistantThread>,
    {
      endpoint: getAssistantThread,
      run({ invocation, params }, { db }) {
        requireBusiness(invocation.context);
        const { id } = parseInput(getAssistantThread.params, params);
        return withTenant(db, invocation.context, async (trx) => ({
          thread: await readThread(trx, invocation, id),
          messages: await readMessages(trx, invocation, proposals, id, {
            after: 0,
            limit: ASSISTANT_LIMITS.messagePageSize,
            newest: true,
          }),
        }));
      },
    } satisfies Route<typeof getAssistantThread>,
    {
      endpoint: deleteAssistantThread,
      command: remove,
      run({ invocation, params }, services) {
        return runCommand(
          services,
          remove,
          parseInput(deleteAssistantThread.params, params),
          invocation,
        );
      },
    } satisfies Route<typeof deleteAssistantThread>,
    {
      endpoint: listAssistantMessages,
      run({ invocation, params, query }, { db }) {
        requireBusiness(invocation.context);
        const { id } = parseInput(listAssistantMessages.params, params);
        const input = parseInput(listAssistantMessages.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readMessages(trx, invocation, proposals, id, input),
        );
      },
    } satisfies Route<typeof listAssistantMessages>,
    {
      endpoint: postAssistantTurn,
      command: start,
      async run({ invocation, params, body }, services) {
        const { id } = parseInput(postAssistantTurn.params, params);
        const input = parseInput(postAssistantTurn.body, body);
        return started(
          invocation,
          services,
          await runCommand(services, start, { ...input, threadId: id }, invocation),
        );
      },
    } satisfies Route<typeof postAssistantTurn>,
    {
      endpoint: getAssistantTurn,
      run({ invocation, params }, { db }) {
        requireBusiness(invocation.context);
        const { id } = parseInput(getAssistantTurn.params, params);
        return withTenant(db, invocation.context, (trx) => readTurn(trx, invocation, id));
      },
    } satisfies Route<typeof getAssistantTurn>,
    {
      endpoint: cancelAssistantTurn,
      command: cancel,
      async run({ invocation, params }, services) {
        const reference = parseInput(cancelAssistantTurn.params, params);
        await runCommand(services, cancel, reference, invocation);
        return withTenant(services.db, invocation.context, (trx) =>
          readTurn(trx, invocation, reference.id),
        );
      },
    } satisfies Route<typeof cancelAssistantTurn>,
  ];
}
