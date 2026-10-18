// Proposable commands: each module says which of its commands an assistant may propose, and
// how, with defineProposable. The AI module keeps the proposals (ai.proposals) and runs
// their commands through what is declared here, which is runProposedCommand: the command
// layer, with nothing left out. What may become of a proposal is decided in
// proposal-rules.ts.
import { parseInput, type AiAgent, type Permission, type ProposalKind } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import type * as z from 'zod';

import { requireActionAutonomy } from './autonomy.js';
import type { Command, Invocation, ProposalLink, Services } from './command.js';
import type { JsonRecord, UndoPlan } from './proposal-rules.js';
import { runProposedCommand } from './run-command.js';

/** What a proposal is about: at most one of the four, and the contact whose rule applies. */
export interface ProposalSubject {
  readonly conversationId?: string;
  readonly recordId?: string;
  readonly automationId?: string;
  readonly formId?: string;
  readonly contactId?: string;
}

/** What a module says of a command of its own that an assistant may propose. */
export interface ProposableDefinition<Input extends z.ZodType, Output, Captured> {
  /** ai.proposals.kind. */
  readonly kind: ProposalKind;
  /**
   * The command Apply runs. It names its delegation, the action a rule is about, or the
   * proposable names the action itself (`action`).
   */
  readonly command: Command<Input, Output>;
  /**
   * The kind of action an autonomy rule is about, for a command that names no delegation:
   * one that keeps its own rule for assistants (`ownAssistantRule`), or one no assistant may
   * run at all. An assistant that applies such a proposal is held to the rule for this
   * action, for the proposal's contact, in the command's transaction and before its handler;
   * the command's own rule, or its refusal of every assistant, still follows. Ignored for a
   * command that names a delegation: its own action is the one.
   */
  readonly action?: string;
  /** The assistants that may propose it. */
  readonly agents: readonly AiAgent[];
  subject(trx: DatabaseTransaction, input: z.output<Input>): Promise<ProposalSubject>;
  /**
   * A fingerprint of what the proposal is made on. Apply compares it with the fingerprint
   * then: a difference means the record moved on, and the proposal is refused as stale.
   */
  revision(trx: DatabaseTransaction, input: z.output<Input>): Promise<string>;
  /**
   * The input to run when a person changed the proposal first, still unchecked: the
   * command's own schema validates it. Left out where nothing may be changed.
   */
  readonly change?: (input: z.output<Input>, changes: JsonRecord) => unknown;
  /** What it would do, as a card shows it (the contract's ProposalChange). */
  present(
    trx: DatabaseTransaction,
    input: z.output<Input>,
    invocation: Invocation,
  ): Promise<JsonRecord>;
  /** Before the command runs: what reversing it later will need to know. */
  capture(trx: DatabaseTransaction, input: z.output<Input>): Promise<Captured>;
  /** What applying made, to keep on the proposal: small, and safe to show. */
  result(output: Output): JsonRecord;
  /** After it ran: how to reverse it, or why nothing can. */
  undo(captured: Captured, output: Output, input: z.output<Input>): UndoPlan;
}

/** What the store does around a proposal's command, in that command's transaction. */
export interface ProposalHooks {
  readonly proposal: ProposalLink;
  /**
   * First, before anything runs: `run` to go on, `repeat` when it was already done.
   * Throws to refuse.
   */
  begin(trx: DatabaseTransaction): Promise<'run' | 'repeat'>;
  /** After the command ran. */
  finish(
    trx: DatabaseTransaction,
    done: {
      readonly result: JsonRecord;
      readonly undo: UndoPlan;
      readonly eventIds: readonly string[];
    },
  ): Promise<void>;
}

/** A proposable command with its types put away, as a registry of them holds it. */
export interface Proposable {
  readonly kind: ProposalKind;
  readonly commandName: string;
  readonly permission: Permission;
  /** The action an autonomy rule is about, from the command's delegation. */
  readonly action: string;
  readonly agents: readonly AiAgent[];
  readonly changeable: boolean;
  /** Checks an input as the command would: a ValidationError when it does not fit. */
  check(input: unknown): void;
  subject(trx: DatabaseTransaction, input: unknown): Promise<ProposalSubject>;
  revision(trx: DatabaseTransaction, input: unknown): Promise<string>;
  /** The input to run instead, unchecked. Only where `changeable`. */
  change(input: unknown, changes: JsonRecord): unknown;
  present(trx: DatabaseTransaction, input: unknown, invocation: Invocation): Promise<JsonRecord>;
  /**
   * Runs the command through the command layer, as whoever the invocation is: validated,
   * permitted, held to the autonomy rule when the actor is an assistant, audited and marked
   * with the proposal. `false` when the hooks said it was already done.
   */
  run(
    services: Services,
    input: unknown,
    invocation: Invocation,
    hooks: ProposalHooks,
  ): Promise<boolean>;
}

/** Declares that a command can be proposed, and how. */
export function defineProposable<Input extends z.ZodType, Output, Captured>(
  definition: ProposableDefinition<Input, Output, Captured>,
): Proposable {
  const { command } = definition;
  const { delegation } = command;
  const action = delegation?.action ?? definition.action;
  if (action === undefined)
    throw new Error(`${command.name} names no delegation, so it cannot be proposed.`);
  const parsed = (input: unknown): z.output<Input> => parseInput(command.input, input);
  return {
    kind: definition.kind,
    commandName: command.name,
    permission: command.permission,
    action,
    agents: definition.agents,
    changeable: definition.change !== undefined,
    check: (input) => {
      parsed(input);
    },
    // Each is a promise even when the input does not fit: a refusal, never a throw.
    subject: async (trx, input) => await definition.subject(trx, parsed(input)),
    revision: async (trx, input) => await definition.revision(trx, parsed(input)),
    change: (input, changes) => {
      if (definition.change === undefined)
        throw new Error(`A ${definition.kind} proposal cannot be changed.`);
      return definition.change(parsed(input), changes);
    },
    present: async (trx, input, invocation) =>
      await definition.present(trx, parsed(input), invocation),
    async run(services, input, invocation, hooks) {
      let captured: { readonly value: Captured } | undefined;
      const done = await runProposedCommand(services, command, input, invocation, {
        proposal: hooks.proposal,
        async begin(trx, checked) {
          const go = await hooks.begin(trx);
          if (go !== 'run') return go;
          // A command that names a delegation is held to its rule by the command layer
          // itself. One that does not is held here, to the proposable's own action.
          if (delegation === undefined)
            await requireActionAutonomy(
              trx,
              invocation,
              action,
              (await definition.subject(trx, checked)).contactId,
            );
          captured = { value: await definition.capture(trx, checked) };
          return go;
        },
        async finish(trx, checked, output, eventIds) {
          if (captured === undefined) throw new Error('A proposal finished without beginning.');
          await hooks.finish(trx, {
            result: definition.result(output),
            undo: definition.undo(captured.value, output, checked),
            eventIds,
          });
        },
      });
      return done.ran;
    },
  };
}

/** The proposable of a kind, from a registry of them. */
export function proposableOf(
  registry: readonly Proposable[],
  kind: string,
): Proposable | undefined {
  return registry.find((each) => each.kind === kind);
}
