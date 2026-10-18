import type { AiAgent, Permission, PermissionScope } from '@repo/contracts';
import type { Database, DatabaseTransaction } from '@repo/db';
import { ForbiddenError, ValidationError, type AppError, type TenantContext } from '@repo/kernel';
import type * as z from 'zod';

/**
 * What an actor may change: the permissions their role gives where they work, or all of
 * them, for the system.
 */
export type Grants = ReadonlySet<Permission> | 'all';

/** Who runs a command, and from where. */
export interface Invocation {
  /** Internal harness identity, never accepted from an HTTP body. Recorded atomically with the command. */
  readonly assistantToolCallId?: string;
  readonly context: TenantContext;
  readonly permissions: Grants;
  /** The event that led to this command, when an automation or a consumer runs it. */
  readonly causationId?: string;
  /** For the audit log, when the command comes over HTTP. */
  readonly ip?: string;
  readonly userAgent?: string;
  /**
   * Which assistant acts, when the actor is one (actorKind `ai_agent`). The command layer
   * then holds the command to that assistant's autonomy rule (autonomy.ts).
   */
  readonly agent?: AiAgent;
}

/** The proposal a command is applied or undone from. */
export interface ProposalLink {
  /** ai.proposals.id. */
  readonly id: string;
  /** The assistant that proposed it. */
  readonly agent: AiAgent;
}

/**
 * What lets an assistant run a command, or propose it: the kind of action an autonomy rule
 * is about, and the contact whose own rule comes first. A command without one can never be
 * run by an assistant, whatever its rules say, unless it holds a rule of its own
 * (`ownAssistantRule`).
 */
export interface Delegation<Input> {
  /** ai.autonomy_rules.action, such as send_message. */
  readonly action: string;
  /** The contact the command concerns, read in the command's transaction. */
  readonly contact?: (trx: DatabaseTransaction, input: Input) => Promise<string | undefined>;
}

/** Something that happened, as a command reports it. */
export interface EventDraft {
  /** Two or more dotted parts, such as tag.created. */
  readonly type: string;
  readonly subject: { readonly kind: string; readonly id: string };
  readonly payload?: Readonly<Record<string, unknown>>;
  /** The records (crm.records ids) whose timelines show the event. */
  readonly records?: readonly string[];
}

/** Whether the invocation's actor may run the command. */
export type Authorize = (invocation: Invocation, command: string) => boolean | Promise<boolean>;

/** What running commands needs. */
export interface Services {
  /** The crm_app pool. */
  readonly db: Database;
  readonly authorize: Authorize;
}

/** What a task's run gets besides the job's data. */
export interface JobRun {
  /**
   * The job's agency and business, acting as the system, under the correlation id of the
   * request that added the job, and caused by the event behind the job.
   */
  readonly invocation: Invocation;
  readonly services: Services;
  /**
   * The queue's record of the job, where a queue runs it: its priority, so a task that
   * queues itself again keeps the place it was given.
   */
  readonly job?: { readonly priority: number };
}

/**
 * Background work that follows from a command, such as reacting to an event. A command
 * adds its jobs with enqueue, and the worker runs each in the business that added it. A
 * job can run more than once: after a failure, and after a crash between its work and the
 * queue recording it as done. So a run must be safe to repeat.
 */
export interface TaskReference<Data extends z.ZodType> {
  /** Two or more dotted parts, such as tag.created; it names the task in the queue. */
  readonly name: string;
  /** What a job carries, as plain JSON: checked when the job is added and when it runs. */
  readonly data: Data;
}

/** Only the worker needs the executable handler; API commands enqueue its reference. */
export interface Task<Data extends z.ZodType> extends TaskReference<Data> {
  run(data: z.output<Data>, job: JobRun): Promise<void>;
}

export function defineTask<Data extends z.ZodType>(task: Task<Data>): Task<Data> {
  return task;
}

/** Any task, as a list of them holds it. */
export type AnyTask = Task<z.ZodType>;

/** What caused a job, when it isn't the event the command emitted last. */
export interface EnqueueOptions {
  /** The id of an event the command emitted. */
  readonly causedBy?: string;
}

/** What a handler gets besides its input: who runs it, and ways to report what follows. */
export interface CommandContext extends Invocation {
  /** Runs a canonical child command within this command's tenant transaction. */
  runChild?<Input extends z.ZodType, Output>(
    command: Command<Input, Output>,
    input: unknown,
  ): Promise<Output>;
  /**
   * The proposal this run applies or undoes, when it is one. The actor is still whoever
   * approved; this only says an assistant proposed it.
   */
  readonly proposal?: ProposalLink;
  /**
   * Writes an event, and its timeline entries, in the command's transaction, so it's kept
   * with the command's change or not at all. Gives the event's id.
   */
  emit(event: EventDraft): Promise<string>;
  /**
   * Adds a job, written with the command's change or not at all; the worker runs it once
   * the change commits. Data that doesn't fit the task is a bug, and fails the command. The
   * job's cause is the event named, else the event the command emitted last, else the event
   * that caused the command.
   */
  enqueue<Data extends z.ZodType>(
    task: TaskReference<Data>,
    data: z.input<Data>,
    options?: EnqueueOptions,
  ): void;
}

/**
 * A change to the data, such as tag.create. The handler runs inside the tenant
 * transaction, with its input already validated.
 */
export interface Command<Input extends z.ZodType, Output> {
  /** Two or more dotted parts, such as tag.create; it names the command in the audit log. */
  readonly name: string;
  /** What the actor's role must allow to run it. */
  readonly permission: Permission;
  readonly input: Input;
  /** What the audit log keeps of the input: all of it, unless this leaves secrets out. */
  readonly audit?: (input: z.output<Input>) => Readonly<Record<string, unknown>>;
  /** Named only by a command an assistant may run or propose (autonomy.ts). */
  readonly delegation?: Delegation<z.output<Input>>;
  /**
   * Named only by a command that holds its own, finer rule for assistants and keeps it in
   * its handler, where no caller can skip it: a field's AI sources and its overwrite
   * setting, say. The words say what that rule is, for whoever reads the command. Such a
   * command is not held to an autonomy rule; every other command an assistant runs is. A
   * command that also names a delegation is held to both.
   */
  readonly ownAssistantRule?: string;
  handle(
    trx: DatabaseTransaction,
    input: z.output<Input>,
    command: CommandContext,
  ): Promise<Output>;
}

export function defineCommand<Input extends z.ZodType, Output>(
  command: Command<Input, Output>,
): Command<Input, Output> {
  return command;
}

const businessRequired = () =>
  new ValidationError([
    { path: '', code: 'business_required', message: 'Choose a business first.' },
  ]);

const agencyRequired = () =>
  new ForbiddenError('Change this for the whole agency, outside any business.');

/** The business a command acts in. Agency staff choose one before changing its data. */
export function requireBusiness(context: TenantContext): string {
  if (context.businessId === undefined) {
    throw businessRequired();
  }
  return context.businessId;
}

/**
 * The agency a command changes as a whole, such as its sign-in rules. Only agency staff act
 * outside a business, so a request inside one is refused.
 */
export function requireAgency(context: TenantContext): string {
  if (context.businessId !== undefined) {
    throw agencyRequired();
  }
  return context.agencyId;
}

/**
 * Why a command can't run where the context works, when its permission applies only in a
 * business or only at the agency: what requireBusiness or requireAgency would throw.
 */
export function misplaced(
  scope: PermissionScope | 'both',
  context: TenantContext,
): AppError | undefined {
  if (scope === 'business' && context.businessId === undefined) return businessRequired();
  if (scope === 'agency' && context.businessId !== undefined) return agencyRequired();
  return undefined;
}
