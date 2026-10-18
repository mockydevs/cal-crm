// Every change to the data goes through runCommand: validate, authorize, then one tenant
// transaction holding the change, its events, their timeline entries and the audit row. An
// attempt that fails still leaves an audit row.
//
// An assistant is an actor like any other here, with one more check: inside the command's
// transaction, before the handler, its autonomy rule is read, and unless the rule says
// `act` the command is refused. A proposal a person approves comes through
// runProposedCommand, which is runCommand with the proposal's bookkeeping in the same
// transaction and the proposal's id on the audit row and the events.
import { parseInput, permissionCatalog } from '@repo/contracts';
import { withTenant, type DatabaseTransaction, type Json } from '@repo/db';
import { AppError, ForbiddenError } from '@repo/kernel';
import { sql } from 'kysely';
import type * as z from 'zod';

import { agentMayRun } from './autonomy-rules.js';
import { ApprovalRequiredError, readAutonomy } from './autonomy.js';
import {
  misplaced,
  requireBusiness,
  type Authorize,
  type Command,
  type EventDraft,
  type Invocation,
  type ProposalLink,
  type Services,
} from './command.js';

/**
 * Adds no rule beyond each command's permission. The authorize service is where rules about
 * records will go, such as "only records assigned to me".
 */
export const allowEveryone: Authorize = () => true;

/**
 * A job a handler added: its task's name, its data as the task's schema parsed it, and the
 * event behind it.
 */
interface JobDraft {
  readonly task: string;
  readonly data: unknown;
  readonly causationId: string | null;
}

type Outcome = 'ok' | 'denied' | 'invalid' | 'failed';

interface AuditRecord {
  readonly outcome: Outcome;
  readonly errorCode: string | null;
  readonly input: unknown;
  readonly eventIds: readonly string[];
  /** The id its events name it by, when it or a command it ran wrote any. */
  readonly commandId?: string;
}

// How each kind of error shows in the audit log; anything else is an internal failure.
const outcomes: Record<AppError['name'], [Outcome, string]> = {
  ValidationError: ['invalid', 'validation'],
  ForbiddenError: ['denied', 'forbidden'],
  NotFoundError: ['failed', 'not_found'],
  ConflictError: ['failed', 'conflict'],
  ContentTooLargeError: ['invalid', 'too_large'],
};

function failure(error: unknown, input: unknown): AuditRecord {
  // An assistant held to asking is told apart from a role that lacks a permission.
  if (error instanceof ApprovalRequiredError)
    return { outcome: 'denied', errorCode: error.reason, input, eventIds: [] };
  const [outcome, errorCode] =
    error instanceof AppError ? outcomes[error.name] : ['failed' as const, 'internal'];
  return { outcome, errorCode, input, eventIds: [] };
}

const asJson = (value: unknown) => sql<Json>`${JSON.stringify(value)}::jsonb`;

async function writeAudit(
  trx: DatabaseTransaction,
  command: string,
  invocation: Invocation,
  record: AuditRecord,
  proposal?: ProposalLink,
): Promise<void> {
  const { context } = invocation;
  await trx
    .insertInto('audit.commands')
    .values({
      agency_id: context.agencyId,
      business_id: context.businessId ?? null,
      command,
      actor_kind: context.actorKind,
      actor_id: context.actorId ?? null,
      ip: invocation.ip ?? null,
      user_agent: invocation.userAgent ?? null,
      ...(record.commandId === undefined ? {} : { id: record.commandId }),
      outcome: record.outcome,
      error_code: record.errorCode,
      input: asJson(record.input),
      event_ids: [...record.eventIds],
      correlation_id: context.correlationId,
      proposal_id: proposal?.id ?? null,
      ...(invocation.assistantToolCallId === undefined
        ? {}
        : { assistant_tool_call_id: invocation.assistantToolCallId }),
    })
    .execute();
}

/**
 * A new id for a command, from the database as every id is. Each event the command writes
 * names it, and so does its audit row: what reacts to events can then tell one change that
 * wrote several of them, such as a contact's name and three of its fields, from several.
 */
async function newCommandId(trx: DatabaseTransaction): Promise<string> {
  const { rows } = await sql<{ id: string }>`select uuidv7() as id`.execute(trx);
  const [row] = rows;
  if (row === undefined) throw new Error('The database gave no id.');
  return row.id;
}

async function writeEvent(
  trx: DatabaseTransaction,
  invocation: Invocation,
  event: EventDraft,
  commandId: string,
  proposal?: ProposalLink,
): Promise<string> {
  const { context } = invocation;
  const { id } = await trx
    .insertInto('events.events')
    .values({
      agency_id: context.agencyId,
      business_id: context.businessId ?? null,
      type: event.type,
      actor_kind: context.actorKind,
      actor_id: context.actorId ?? null,
      causation_id: invocation.causationId ?? null,
      correlation_id: context.correlationId,
      subject_kind: event.subject.kind,
      subject_id: event.subject.id,
      payload: asJson(event.payload ?? {}),
      proposal_id: proposal?.id ?? null,
      command_id: commandId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (event.records !== undefined) {
    // Copied from the stored event in SQL: a JavaScript Date would drop the microseconds
    // of recorded_at, and the entry must name the event exactly.
    await sql`
      insert into crm.timeline_entries
        (business_id, record_id, occurred_at, event_id, event_recorded_at, event_type)
      select ${requireBusiness(context)}, record.id, e.occurred_at, e.id, e.recorded_at, e.type
      from events.events e
      cross join unnest(${[...event.records]}::uuid[]) as record (id)
      where e.id = ${id}
    `.execute(trx);
  }
  return id;
}

// private.enqueue_job stamps each job with the transaction's tenant context (0013) and the
// event behind it (0020).
async function writeJobs(trx: DatabaseTransaction, jobs: readonly JobDraft[]): Promise<void> {
  for (const job of jobs) {
    await sql`
      select private.enqueue_job(${job.task}, ${asJson(job.data)}, ${job.causationId}::uuid)
    `.execute(trx);
  }
}

/** Why the invocation's permission or tenant scope refuses a command. */
function permissionRefusal(
  command: Pick<Command<z.ZodType, unknown>, 'name' | 'permission'>,
  invocation: Invocation,
): AppError | undefined {
  // Where it runs comes first. A business's work at the agency, or the agency's in a
  // business, is refused as its handler would refuse it: no role could allow it there.
  return (
    misplaced(permissionCatalog[command.permission].scope, invocation.context) ??
    (invocation.permissions === 'all' || invocation.permissions.has(command.permission)
      ? undefined
      : new ForbiddenError(
          `Your role doesn't allow this: it needs ${command.permission}.`,
          command.permission,
        ))
  );
}

/** Checks and independently audits permission refusals before receiving command input. */
export async function requirePermission(
  services: Services,
  command: Pick<Command<z.ZodType, unknown>, 'name' | 'permission'>,
  invocation: Invocation,
  auditedInput: unknown = {},
  proposal?: ProposalLink,
): Promise<void> {
  const refused = permissionRefusal(command, invocation);
  if (refused === undefined) return;
  await withTenant(services.db, invocation.context, (trx) =>
    writeAudit(trx, command.name, invocation, failure(refused, auditedInput), proposal),
  );
  throw refused;
}

/**
 * Holds an assistant to its autonomy rule. People, automations and the system are not
 * assistants, and pass. An assistant runs a command only when the command names a
 * delegation and the rule for that action, for this contact or else the business, says
 * `act`; at `suggest`, at `ask` and with no rule at all it may only propose. Read in the
 * command's own transaction, so the level is the one in force as it runs.
 *
 * A command that says it holds its own rule for assistants (`ownAssistantRule`) is let
 * through to its handler, which keeps that rule. A command that says neither is refused.
 */
export async function requireAutonomy<Input extends z.ZodType>(
  trx: DatabaseTransaction,
  command: Pick<Command<Input, unknown>, 'delegation' | 'ownAssistantRule'>,
  input: z.output<Input>,
  invocation: Invocation,
): Promise<void> {
  if (invocation.context.actorKind !== 'ai_agent') return;
  const { delegation } = command;
  if (delegation === undefined && command.ownAssistantRule !== undefined) return;
  const { agent } = invocation;
  if (delegation === undefined || agent === undefined)
    throw new ApprovalRequiredError('not_delegable');
  const contactId = await delegation.contact?.(trx, input);
  const { level } = await readAutonomy(trx, { agent, action: delegation.action, contactId });
  if (!agentMayRun(level)) throw new ApprovalRequiredError('approval_required');
}

/** What a run of the handler made, for whatever runs around it. */
interface Ran<Output> {
  readonly output: Output;
  readonly eventIds: readonly string[];
  readonly lastEventId: string | undefined;
}

/**
 * What a command and the commands it runs inside it (its children) share: the savepoints
 * numbered so far, and the id their events name the change by. The id is asked for with the
 * first event, so a command that writes none costs nothing more. Children share it, so a
 * workflow step that changes a contact's name and three fields is one change, as a save is.
 */
interface Whole {
  savepoints: number;
  commandId?: Promise<string> | undefined;
}

type InTransaction = <Answer>(
  work: (trx: DatabaseTransaction) => Promise<Answer>,
) => Promise<Answer>;

/**
 * The one way a command runs. `around` is given the transaction and a function that runs
 * the handler once; what it returns is the answer. When it never runs the handler, nothing
 * is audited as done, because nothing was.
 */
async function execute<Input extends z.ZodType, Output, Answer>(
  services: Services,
  command: Command<Input, Output>,
  input: unknown,
  invocation: Invocation,
  proposal: ProposalLink | undefined,
  around: (
    trx: DatabaseTransaction,
    parsed: z.output<Input>,
    run: () => Promise<Ran<Output>>,
  ) => Promise<Answer>,
  inTransaction: InTransaction = (work) => withTenant(services.db, invocation.context, work),
  whole: Whole = { savepoints: 0 },
  deferredFailures?: (() => Promise<void>)[],
): Promise<Answer> {
  const childFailures = deferredFailures ?? [];
  const recordFailure = (record: AuditRecord): Promise<void> => {
    const write = () =>
      withTenant(services.db, invocation.context, (trx) =>
        writeAudit(trx, command.name, invocation, record, proposal),
      );
    if (deferredFailures === undefined) return write();
    // An independent audit's tenant foreign key can wait on the parent's row lock.
    // Keep failure audits independent, but write them after the outer transaction ends.
    childFailures.push(write);
    return Promise.resolve();
  };

  let parsed: z.output<Input>;
  try {
    parsed = parseInput(command.input, input);
  } catch (error) {
    // Input that doesn't fit could hold anything, so none of it is kept.
    await recordFailure(failure(error, {}));
    throw error;
  }
  const auditedInput = command.audit?.(parsed) ?? parsed;

  const refused = permissionRefusal(command, invocation);
  if (refused !== undefined) {
    await recordFailure(failure(refused, auditedInput));
    throw refused;
  }
  if (!(await services.authorize(invocation, command.name))) {
    const denied = new ForbiddenError("You don't have permission to do this.");
    await recordFailure(failure(denied, auditedInput));
    throw denied;
  }

  try {
    return await inTransaction(async (trx) => {
      const eventIds: string[] = [];
      const jobs: JobDraft[] = [];
      let lastEventId = invocation.causationId;
      let children: Promise<void> = Promise.resolve();
      // Set by the handler's run, which `around` may never ask for.
      const handler = { ran: false };
      const answer = await around(trx, parsed, async () => {
        handler.ran = true;
        await requireAutonomy(trx, command, parsed, invocation);
        let output: Output;
        try {
          output = await command.handle(trx, parsed, {
            ...invocation,
            ...(proposal === undefined ? {} : { proposal }),
            runChild: (child, childInput) => {
              const result = children.then(() =>
                execute(
                  services,
                  child,
                  childInput,
                  {
                    ...invocation,
                    ...(lastEventId === undefined ? {} : { causationId: lastEventId }),
                  },
                  proposal,
                  async (_childTrx, _childParsed, runChild) => runChild(),
                  async (work) => {
                    const name = `command_child_${String(++whole.savepoints)}`;
                    await sql`savepoint ${sql.id(name)}`.execute(trx);
                    try {
                      const answer = await work(trx);
                      await sql`release savepoint ${sql.id(name)}`.execute(trx);
                      return answer;
                    } catch (error) {
                      await sql`rollback to savepoint ${sql.id(name)}`.execute(trx);
                      await sql`release savepoint ${sql.id(name)}`.execute(trx);
                      throw error;
                    }
                  },
                  whole,
                  childFailures,
                ).then((ran) => {
                  lastEventId = ran.lastEventId;
                  return ran.output;
                }),
              );
              children = result.then(
                () => undefined,
                () => undefined,
              );
              return result;
            },
            emit: async (event) => {
              // A child's failed ask is not kept: once its savepoint is rolled back, the
              // command that ran it asks again.
              whole.commandId ??= newCommandId(trx).catch((error: unknown) => {
                whole.commandId = undefined;
                throw error;
              });
              const id = await writeEvent(trx, invocation, event, await whole.commandId, proposal);
              eventIds.push(id);
              lastEventId = id;
              return id;
            },
            enqueue: (task, data, options = {}) => {
              if (options.causedBy !== undefined && !eventIds.includes(options.causedBy)) {
                throw new Error(
                  `A job's cause must be an event the command emitted: ${options.causedBy}`,
                );
              }
              const causationId = options.causedBy ?? lastEventId ?? null;
              jobs.push({ task: task.name, data: task.data.parse(data), causationId });
            },
          });
        } finally {
          // Promise.all may reject before later queued children finish. Keep the
          // transaction alive until every issued child has settled.
          await children;
        }
        return { output, eventIds, lastEventId };
      });
      if (!handler.ran) return answer;
      await writeJobs(trx, jobs);
      await writeAudit(
        trx,
        command.name,
        invocation,
        {
          outcome: 'ok',
          errorCode: null,
          input: auditedInput,
          eventIds,
          // The command that was run, not one it ran inside it, is the one events name.
          ...(deferredFailures !== undefined || whole.commandId === undefined
            ? {}
            : { commandId: await whole.commandId }),
        },
        proposal,
      );
      // PostgreSQL delivers NOTIFY only after this transaction commits. No row data leaves
      // the transaction: subscribers refetch through the API.
      if (invocation.context.businessId !== undefined) {
        await sql`select pg_notify('crm_business_changed', ${invocation.context.businessId})`.execute(
          trx,
        );
      }
      return answer;
    });
  } catch (error) {
    await recordFailure(failure(error, auditedInput));
    throw error;
  } finally {
    if (deferredFailures === undefined) for (const write of childFailures) await write();
  }
}

/**
 * Runs a command: validates the input, authorizes the actor, then runs the handler in one
 * tenant transaction with its events, timeline entries and audit row. A refused or failed
 * attempt changes nothing except its own audit row, written in a transaction of its own.
 */
export function runCommand<Input extends z.ZodType, Output>(
  services: Services,
  command: Command<Input, Output>,
  input: unknown,
  invocation: Invocation,
): Promise<Output> {
  return execute(services, command, input, invocation, undefined, async (_trx, _parsed, run) => {
    const { output } = await run();
    return output;
  });
}

/** What a proposal's store does around its command, in the command's transaction. */
export interface ProposedRun<Input, Output> {
  readonly proposal: ProposalLink;
  /**
   * First, before the handler: `run` to go on, `repeat` when the proposal was already
   * applied, so that nothing runs twice. Throws to refuse.
   */
  begin(trx: DatabaseTransaction, input: Input): Promise<'run' | 'repeat'>;
  /** After the handler, with what it returned and the ids of the events it wrote. */
  finish(
    trx: DatabaseTransaction,
    input: Input,
    output: Output,
    eventIds: readonly string[],
  ): Promise<void>;
}

/**
 * Runs a command a proposal holds, for whoever applies it. It is runCommand, with nothing
 * left out: the same validation, the same permission check against the same invocation,
 * the same autonomy rule when the actor is an assistant, the same handler, events and audit
 * row. Added to it, in the same transaction: the store's `begin` before the handler and its
 * `finish` after, so the proposal is marked with the change or not at all; and the
 * proposal's id on the audit row and on every event, a refusal's audit row included.
 */
export function runProposedCommand<Input extends z.ZodType, Output>(
  services: Services,
  command: Command<Input, Output>,
  input: unknown,
  invocation: Invocation,
  proposed: ProposedRun<z.output<Input>, Output>,
): Promise<{ readonly ran: true; readonly output: Output } | { readonly ran: false }> {
  return execute(
    services,
    command,
    input,
    invocation,
    proposed.proposal,
    async (trx, parsed, run) => {
      if ((await proposed.begin(trx, parsed)) === 'repeat') return { ran: false as const };
      const { output, eventIds } = await run();
      await proposed.finish(trx, parsed, output, eventIds);
      return { ran: true as const, output };
    },
  );
}
