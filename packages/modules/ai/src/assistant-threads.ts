// A person's conversations with the in-app assistant: threads, the turns a worker runs and
// the messages each turn writes. The app cannot open a provider's key, so a message a
// person sends is a row and a job; the worker's side is in assistant-turn.ts.
//
// A thread is its person's alone. Row-level security says so (migration 0084): only that
// person acting themselves, and the worker, read or write these tables. So every read here
// is simply "this thread": another person's thread is not found, whoever asks.
//
// Starting a turn, stopping one and deleting a thread are commands, needing
// `assistant.use`. What they are audited with holds no words of a message.
import {
  defineCommand,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
  type TaskReference,
} from '@repo/commands';
import {
  ASSISTANT_LIMITS,
  assistantMessage,
  assistantMessageKinds,
  assistantPageContext,
  assistantStartTurnInput,
  assistantTurnJob,
  assistantTurnOutcomes,
  assistantTurnStatuses,
  getAssistantThread,
  getAssistantTurn,
  type AssistantContext,
  type AssistantMessage,
  type AssistantMessages,
  type AssistantPageContext,
  type AssistantThread,
  type AssistantThreadList,
  type AssistantTurn,
  type AssistantTurnOutcome,
} from '@repo/contracts';
import type { DatabaseTransaction, Json } from '@repo/db';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  type TenantContext,
} from '@repo/kernel';

import { outcomeWords } from './assistant-loop.js';
import { readProposal, type ProposalOptions } from './proposals.js';
import { oneOf } from './stored-words.js';

export const assistantTurnReference = {
  name: 'ai.assistant_turn',
  data: assistantTurnJob,
} satisfies TaskReference<typeof assistantTurnJob>;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** What ending a turn says, by the product's own limits. */
export const TURN_LIMIT_WORDS = {
  steps: ASSISTANT_LIMITS.stepsPerTurn,
  minutes: ASSISTANT_LIMITS.turnMinutes,
} as const;

/**
 * The person a request is from: someone signed in, acting themselves. An API key, a job
 * and an assistant are not, and have no conversations of their own.
 */
export function requirePerson(context: TenantContext): string {
  const { userId } = context;
  if (context.actorKind !== 'user' || userId === undefined || context.actorId !== userId)
    throw new ForbiddenError('Only a signed-in person talks to the assistant.');
  return userId;
}

/**
 * Whether the business could ask a model at all: AI is on, and a provider is connected
 * where the business takes its keys from, its own or its agency's, as the gateway reads it.
 */
export async function aiReadiness(
  trx: DatabaseTransaction,
  context: TenantContext,
): Promise<AssistantContext['ai']> {
  const businessId = requireBusiness(context);
  const settings = await trx
    .selectFrom('ai.settings')
    .select(['enabled', 'key_source'])
    .where('business_id', '=', businessId)
    .executeTakeFirst();
  if (settings?.enabled === false) return 'off';
  const keys = trx
    .selectFrom('ai.provider_keys')
    .select('id')
    .where('agency_id', '=', context.agencyId);
  const key = await (
    settings?.key_source === 'own'
      ? keys.where('business_id', '=', businessId)
      : keys.where('business_id', 'is', null)
  )
    .limit(1)
    .executeTakeFirst();
  return key === undefined ? 'not_connected' : 'ready';
}

/** Why the assistant cannot be asked, in the words the panel shows. Null when it can. */
export function readinessWords(ai: AssistantContext['ai']): string | null {
  if (ai === 'off') return outcomeWords('ai_off', null, TURN_LIMIT_WORDS);
  if (ai === 'not_connected') return outcomeWords('not_configured', null, TURN_LIMIT_WORDS);
  return null;
}

const threadColumns = [
  'id',
  'user_id',
  'title',
  'message_seq',
  'created_at',
  'last_activity_at',
  'expires_at',
] as const;
const turnColumns = [
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
] as const;
const messageColumns = [
  'id',
  'thread_id',
  'turn_id',
  'seq',
  'kind',
  'text',
  'activity',
  'proposal_id',
  'code',
  'created_at',
] as const;

interface ThreadRow {
  readonly id: string;
  readonly user_id: string;
  readonly title: string;
  readonly message_seq: number;
  readonly created_at: Date;
  readonly last_activity_at: Date;
  readonly expires_at: Date;
}
export interface TurnRow {
  readonly id: string;
  readonly thread_id: string;
  readonly user_id: string;
  readonly status: string;
  readonly outcome: string | null;
  readonly reason: string | null;
  readonly page: Json;
  readonly cancel_requested_at: Date | null;
  readonly steps: number;
  readonly cost_estimate: string | null;
  readonly correlation_id: string;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
}
interface MessageRow {
  readonly id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly seq: number;
  readonly kind: string;
  readonly text: string;
  readonly activity: Json | null;
  readonly proposal_id: string | null;
  readonly code: string | null;
  readonly created_at: Date;
}

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

/** What a message's activity column holds, as the server wrote it: the contract's own shape. */
const storedActivity = assistantMessage.shape.activity;

/** The page a turn was sent from, as its row keeps it. */
export function pageOf(turn: Pick<TurnRow, 'page'>): AssistantPageContext {
  return assistantPageContext.parse(turn.page);
}

function presentTurn(row: TurnRow): AssistantTurn {
  const outcome = row.outcome === null ? null : oneOf(assistantTurnOutcomes, row.outcome);
  return {
    id: toPublicId('assistant_turn', row.id),
    threadId: toPublicId('assistant_thread', row.thread_id),
    status: oneOf(assistantTurnStatuses, row.status),
    outcome,
    message: outcome === null ? null : outcomeWords(outcome, row.reason, TURN_LIMIT_WORDS),
    cancelRequested: row.cancel_requested_at !== null,
    steps: row.steps,
    // numeric(19, 6): the database's own six places.
    costEstimate: row.cost_estimate,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

function presentThread(row: ThreadRow, turn: TurnRow | undefined): AssistantThread {
  return {
    id: toPublicId('assistant_thread', row.id),
    title: row.title,
    createdAt: row.created_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    turn: turn === undefined ? null : presentTurn(turn),
  };
}

/** The newest turn of each of these threads. */
async function newestTurns(
  trx: DatabaseTransaction,
  threadIds: readonly string[],
): Promise<ReadonlyMap<string, TurnRow>> {
  if (threadIds.length === 0) return new Map();
  const rows = await trx
    .selectFrom('ai.assistant_turns')
    .select(turnColumns)
    .distinctOn('thread_id')
    .where('thread_id', 'in', [...threadIds])
    .orderBy('thread_id')
    .orderBy('id', 'desc')
    .execute();
  return new Map(rows.map((row) => [row.thread_id, row]));
}

/** A thread of the person's own by its public id, or a NotFoundError; optionally held. */
async function requireThread(
  trx: DatabaseTransaction,
  publicThreadId: string,
  lock = false,
): Promise<ThreadRow> {
  const id = parsePublicId('assistant_thread', publicThreadId);
  const query =
    id === undefined
      ? undefined
      : trx.selectFrom('ai.assistant_threads').select(threadColumns).where('id', '=', id);
  const row = await (lock ? query?.forUpdate() : query)?.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Conversation', publicThreadId);
  return row;
}

async function requireTurn(
  trx: DatabaseTransaction,
  publicTurnId: string,
  lock = false,
): Promise<TurnRow> {
  const id = parsePublicId('assistant_turn', publicTurnId);
  const query =
    id === undefined
      ? undefined
      : trx.selectFrom('ai.assistant_turns').select(turnColumns).where('id', '=', id);
  const row = await (lock ? query?.forUpdate() : query)?.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Turn', publicTurnId);
  return row;
}

/** Where a page of the list ends: the activity time to the millisecond, and the id. */
const cursorOf = (row: ThreadRow): string =>
  `${String(row.last_activity_at.getTime())}.${toPublicId('assistant_thread', row.id)}`;

function parseCursor(cursor: string): { readonly at: Date; readonly id: string } | undefined {
  const [time, publicId, ...rest] = cursor.split('.');
  const id = publicId === undefined ? undefined : parsePublicId('assistant_thread', publicId);
  if (time === undefined || !/^\d{1,15}$/.test(time) || id === undefined || rest.length > 0)
    return undefined;
  return { at: new Date(Number(time)), id };
}

/** The person's own threads in this business, newest activity first. */
export async function readThreads(
  trx: DatabaseTransaction,
  invocation: Invocation,
  input: { readonly after?: string | undefined; readonly limit: number },
): Promise<AssistantThreadList> {
  requireBusiness(invocation.context);
  const person = requirePerson(invocation.context);
  let query = trx
    .selectFrom('ai.assistant_threads')
    .select(threadColumns)
    .where('user_id', '=', person)
    .orderBy('last_activity_at', 'desc')
    .orderBy('id', 'desc');
  const after = input.after === undefined ? undefined : parseCursor(input.after);
  // A cursor that is none of ours starts nowhere: the list ends rather than starts again.
  if (input.after !== undefined && after === undefined) return { items: [], nextCursor: null };
  if (after !== undefined)
    query = query.where((eb) =>
      eb.or([
        eb('last_activity_at', '<', after.at),
        eb.and([eb('last_activity_at', '=', after.at), eb('id', '<', after.id)]),
      ]),
    );
  const found = await query.limit(input.limit + 1).execute();
  const rows = found.slice(0, input.limit);
  const turns = await newestTurns(
    trx,
    rows.map((row) => row.id),
  );
  const last = rows.at(-1);
  return {
    items: rows.map((row) => presentThread(row, turns.get(row.id))),
    nextCursor: found.length > input.limit && last !== undefined ? cursorOf(last) : null,
  };
}

export async function readThread(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicThreadId: string,
): Promise<AssistantThread> {
  requireBusiness(invocation.context);
  requirePerson(invocation.context);
  const row = await requireThread(trx, publicThreadId);
  return presentThread(row, (await newestTurns(trx, [row.id])).get(row.id));
}

export async function readTurn(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicTurnId: string,
): Promise<AssistantTurn> {
  requireBusiness(invocation.context);
  requirePerson(invocation.context);
  return presentTurn(await requireTurn(trx, publicTurnId));
}

async function presentMessage(
  trx: DatabaseTransaction,
  invocation: Invocation,
  proposals: ProposalOptions,
  row: MessageRow,
): Promise<AssistantMessage> {
  let proposal: AssistantMessage['proposal'] = null;
  if (row.proposal_id !== null) {
    try {
      // As it is now: waiting, applied, dismissed, stale. And whether this person may decide.
      proposal = await readProposal(
        trx,
        invocation,
        proposals,
        toPublicId('proposal', row.proposal_id),
      );
    } catch (error) {
      // A kind this version has no command for cannot be shown or decided here.
      if (!(error instanceof AppError)) throw error;
    }
  }
  return {
    id: toPublicId('assistant_message', row.id),
    seq: row.seq,
    turnId: toPublicId('assistant_turn', row.turn_id),
    kind: oneOf(assistantMessageKinds, row.kind),
    text: row.text,
    activity: storedActivity.parse(row.activity),
    proposal,
    code: row.code,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The messages of a thread after a cursor, oldest first, or its newest ones when `newest`
 * is asked for (how a thread is opened).
 */
export async function readMessages(
  trx: DatabaseTransaction,
  invocation: Invocation,
  proposals: ProposalOptions,
  publicThreadId: string,
  input: { readonly after: number; readonly limit: number; readonly newest?: boolean },
): Promise<AssistantMessages> {
  requireBusiness(invocation.context);
  requirePerson(invocation.context);
  const thread = await requireThread(trx, publicThreadId);
  const of = () =>
    trx
      .selectFrom('ai.assistant_messages')
      .select(messageColumns)
      .where('thread_id', '=', thread.id);
  const rows =
    input.newest === true
      ? (await of().orderBy('seq', 'desc').limit(input.limit).execute()).reverse()
      : await of().where('seq', '>', input.after).orderBy('seq').limit(input.limit).execute();
  const items: AssistantMessage[] = [];
  for (const row of rows) items.push(await presentMessage(trx, invocation, proposals, row));
  const cursor = rows.at(-1)?.seq ?? (input.newest === true ? 0 : input.after);
  const turn = (await newestTurns(trx, [thread.id])).get(thread.id);
  return {
    items,
    cursor,
    more: cursor < thread.message_seq,
    turn: turn === undefined ? null : presentTurn(turn),
  };
}

/** A thread's title: the first message on one line, cut to what the list shows. */
export function titleOf(message: string): string {
  const line = message.replaceAll(/\s+/g, ' ').trim();
  const characters = Array.from(line);
  return characters.length <= ASSISTANT_LIMITS.titleLength
    ? line
    : `${characters
        .slice(0, ASSISTANT_LIMITS.titleLength - 1)
        .join('')
        .trimEnd()}…`;
}

export interface NewMessage {
  readonly threadId: string;
  readonly turnId: string;
  readonly userId: string;
  readonly kind: AssistantMessage['kind'];
  readonly text: string;
  readonly activity?: NonNullable<AssistantMessage['activity']>;
  readonly proposalId?: string;
  readonly code?: string;
  readonly requestId?: string;
}

/** The most characters a message's row holds: longer text is cut, and says so. */
const MESSAGE_TEXT_MAX_LENGTH = 20_000;

/**
 * Writes a message at the next place in its thread, under the thread's lock, and marks
 * the thread used: it now expires so many days from `at`.
 */
export async function appendMessage(
  trx: DatabaseTransaction,
  businessId: string,
  message: NewMessage,
  at: Date,
): Promise<{ readonly id: string; readonly seq: number }> {
  const settings = await trx
    .selectFrom('ai.settings')
    .select('request_log_days')
    .where('business_id', '=', businessId)
    .executeTakeFirst();
  // Kept as long as the business keeps what was said to a model, a month at most, and at
  // least a day: a conversation that vanished while it was being had would be no use.
  const days = Math.min(
    ASSISTANT_LIMITS.threadDays,
    Math.max(1, settings?.request_log_days ?? ASSISTANT_LIMITS.threadDays),
  );
  const { message_seq: seq } = await trx
    .updateTable('ai.assistant_threads')
    .set((eb) => ({
      message_seq: eb('message_seq', '+', 1),
      last_activity_at: at,
      expires_at: new Date(at.getTime() + days * DAY_MS),
    }))
    .where('id', '=', message.threadId)
    .returning('message_seq')
    .executeTakeFirstOrThrow();
  const text =
    message.text.length <= MESSAGE_TEXT_MAX_LENGTH
      ? message.text
      : `${message.text.slice(0, MESSAGE_TEXT_MAX_LENGTH - 1)}…`;
  const { id } = await trx
    .insertInto('ai.assistant_messages')
    .values({
      business_id: businessId,
      thread_id: message.threadId,
      turn_id: message.turnId,
      user_id: message.userId,
      seq,
      kind: message.kind,
      text,
      activity: message.activity === undefined ? null : asJson(message.activity),
      proposal_id: message.proposalId ?? null,
      code: message.code ?? null,
      request_id: message.requestId ?? null,
      created_at: at,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id, seq };
}

/**
 * Ends a turn: how it ended, what it cost, and, unless it answered, a last message that
 * says why in plain words. Only a turn that has not finished is ended.
 */
export async function finishTurn(
  trx: DatabaseTransaction,
  businessId: string,
  turn: Pick<TurnRow, 'id' | 'thread_id' | 'user_id'>,
  ended: {
    readonly outcome: AssistantTurnOutcome;
    readonly reason?: string | null;
    readonly steps?: number;
    readonly costEstimate?: string | null;
  },
  at: Date,
): Promise<boolean> {
  const reason = ended.reason ?? null;
  const done = await trx
    .updateTable('ai.assistant_turns')
    .set({
      status: 'finished',
      outcome: ended.outcome,
      // The column takes a category's shape only: anything else is left out.
      reason: reason !== null && /^[a-z][a-z_]{0,63}$/.test(reason) ? reason : null,
      finished_at: at,
      ...(ended.steps === undefined ? {} : { steps: ended.steps }),
      ...(ended.costEstimate === undefined ? {} : { cost_estimate: ended.costEstimate }),
    })
    .where('id', '=', turn.id)
    .where('status', '<>', 'finished')
    .returning('id')
    .executeTakeFirst();
  if (done === undefined) return false;
  const words = outcomeWords(ended.outcome, reason, TURN_LIMIT_WORDS);
  if (words !== null)
    await appendMessage(
      trx,
      businessId,
      {
        threadId: turn.thread_id,
        turnId: turn.id,
        userId: turn.user_id,
        kind: 'error',
        text: words,
        code: ended.outcome,
      },
      at,
    );
  return true;
}

export interface AssistantThreadOptions {
  readonly now?: () => Date;
}

const REFUSALS = {
  busy: 'The assistant is still working on your last message. Wait for it to finish, or stop it.',
  deleting: 'The assistant is still working in this conversation. Stop it before deleting it.',
} as const;

export interface TurnStart {
  readonly threadId: string;
  readonly turnId: string;
  readonly messageSeq: number;
}

/**
 * A message from a person: stored as a turn with its first message, and queued for the
 * worker, in one transaction. Refused in plain words where no model could be asked, when
 * the person has started too many turns this hour, and while the thread's last turn runs.
 */
export function startTurnCommand(
  options: AssistantThreadOptions = {},
): Command<typeof assistantStartTurnInput, TurnStart> {
  const now = options.now ?? (() => new Date());
  return defineCommand({
    name: 'assistant.start_turn',
    permission: 'assistant.use',
    input: assistantStartTurnInput,
    // What was asked is the person's own: the audit log keeps where from, never the words.
    audit: ({ threadId, message, page }) => ({
      threadId: threadId ?? null,
      route: page.route,
      record: page.record ?? null,
      selected: page.selection.length,
      length: message.length,
    }),
    async handle(trx, input, command: CommandContext): Promise<TurnStart> {
      const businessId = requireBusiness(command.context);
      const person = requirePerson(command.context);
      const at = now();
      // The thread first: one that is not this person's is not found, whatever else is so.
      // Held until the turn is stored: two messages sent at once start one turn.
      const existing =
        input.threadId === undefined ? undefined : await requireThread(trx, input.threadId, true);
      const words = readinessWords(await aiReadiness(trx, command.context));
      if (words !== null) throw new ConflictError(words);

      const lately = await trx
        .selectFrom('ai.assistant_turns')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('user_id', '=', person)
        .where('created_at', '>', new Date(at.getTime() - HOUR_MS))
        .executeTakeFirstOrThrow();
      if (Number(lately.count) >= ASSISTANT_LIMITS.turnsPerHour)
        throw new ConflictError(
          `You have sent the assistant ${String(ASSISTANT_LIMITS.turnsPerHour)} messages in the last hour, which is the most one person may. Try again a little later.`,
        );

      const thread =
        existing ??
        (await trx
          .insertInto('ai.assistant_threads')
          .values({
            business_id: businessId,
            user_id: person,
            title: titleOf(input.message),
            created_at: at,
            last_activity_at: at,
          })
          .returning(['id'])
          .executeTakeFirstOrThrow());
      const open = await trx
        .selectFrom('ai.assistant_turns')
        .select('id')
        .where('thread_id', '=', thread.id)
        .where('status', '<>', 'finished')
        .executeTakeFirst();
      if (open !== undefined) throw new ConflictError(REFUSALS.busy);

      const turn = await trx
        .insertInto('ai.assistant_turns')
        .values({
          business_id: businessId,
          thread_id: thread.id,
          user_id: person,
          page: asJson(input.page),
          correlation_id: command.context.correlationId,
          created_at: at,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const { seq } = await appendMessage(
        trx,
        businessId,
        {
          threadId: thread.id,
          turnId: turn.id,
          userId: person,
          kind: 'user',
          text: input.message,
        },
        at,
      );
      command.enqueue(assistantTurnReference, { turnId: turn.id });
      return {
        threadId: toPublicId('assistant_thread', thread.id),
        turnId: toPublicId('assistant_turn', turn.id),
        messageSeq: seq,
      };
    },
  });
}

const turnReference = getAssistantTurn.params;
const threadReference = getAssistantThread.params;

/**
 * Stops a turn of the person's own. One no worker has taken ends at once; one that is
 * running is asked to stop, and does before its next step. Stopping a finished turn, or
 * stopping twice, changes nothing.
 */
export function cancelTurnCommand(
  options: AssistantThreadOptions = {},
): Command<typeof turnReference, undefined> {
  const now = options.now ?? (() => new Date());
  return defineCommand({
    name: 'assistant.cancel_turn',
    permission: 'assistant.use',
    input: turnReference,
    async handle(trx, { id }, command): Promise<undefined> {
      const businessId = requireBusiness(command.context);
      requirePerson(command.context);
      const turn = await requireTurn(trx, id, true);
      const at = now();
      if (turn.status === 'queued')
        await finishTurn(trx, businessId, turn, { outcome: 'cancelled' }, at);
      else if (turn.status === 'running' && turn.cancel_requested_at === null)
        await trx
          .updateTable('ai.assistant_turns')
          .set({ cancel_requested_at: at })
          .where('id', '=', turn.id)
          .execute();
      return undefined;
    },
  });
}

/**
 * Deletes a thread of the person's own, with its turns and messages. What the assistant
 * made stays, and so does a proposal it stored. Refused while a turn of it still runs.
 */
export function deleteThreadCommand(): Command<typeof threadReference, undefined> {
  return defineCommand({
    name: 'assistant.delete_thread',
    permission: 'assistant.use',
    input: threadReference,
    async handle(trx, { id }, command): Promise<undefined> {
      requireBusiness(command.context);
      requirePerson(command.context);
      const thread = await requireThread(trx, id, true);
      const open = await trx
        .selectFrom('ai.assistant_turns')
        .select('id')
        .where('thread_id', '=', thread.id)
        .where('status', '<>', 'finished')
        .executeTakeFirst();
      if (open !== undefined) throw new ConflictError(REFUSALS.deleting);
      await trx.deleteFrom('ai.assistant_threads').where('id', '=', thread.id).execute();
      return undefined;
    },
  });
}
