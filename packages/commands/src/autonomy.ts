// Autonomy against the database: the rule in force for an assistant, an action and a
// contact, read in a command's own transaction. runCommand reads it before the handler of
// every command an assistant runs (run-command.ts), so no caller of a command can leave the
// check out. The rules themselves are in autonomy-rules.ts.
import { autonomyLevels, defaultAutonomy, type AiAgent } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ForbiddenError } from '@repo/kernel';
import * as z from 'zod';

import { agentMayRun, resolveAutonomy, type AutonomyDecision } from './autonomy-rules.js';
import type { Invocation } from './command.js';

export interface AutonomySubject {
  readonly agent: AiAgent;
  /** The kind of action, as a command's delegation names it, such as send_message. */
  readonly action: string;
  /** The contact the action concerns, when it concerns one. */
  readonly contactId?: string | undefined;
}

/** The level that applies now, read in the caller's transaction, in its business. */
export async function readAutonomy(
  trx: DatabaseTransaction,
  subject: AutonomySubject,
): Promise<AutonomyDecision> {
  const { contactId } = subject;
  const rows = await trx
    .selectFrom('ai.autonomy_rules')
    .select(['contact_id', 'level'])
    .where('agent', '=', subject.agent)
    .where('action', '=', subject.action)
    .where((eb) =>
      contactId === undefined
        ? eb('contact_id', 'is', null)
        : eb.or([eb('contact_id', 'is', null), eb('contact_id', '=', contactId)]),
    )
    .execute();
  return resolveAutonomy(
    rows.map((row) => ({
      contactId: row.contact_id,
      // The column's check allows no other word.
      level: z.enum(autonomyLevels).parse(row.level),
    })),
    contactId,
    // Asking first, but for what an assistant starts out doing on its own.
    defaultAutonomy(subject.agent, subject.action),
  );
}

/**
 * Holds an assistant to the rule for one kind of action, read in the caller's transaction:
 * unless the rule for that action, for this contact or else the business, says `act`, it is
 * refused. People, automations and the system are not assistants, and pass.
 *
 * runCommand does this itself for a command that names a delegation (requireAutonomy). This
 * is for the one place that does not: a proposal of a command that keeps its own rule for
 * assistants and names no delegation, which an assistant applies (proposals.ts). The rule
 * the command keeps in its handler still applies after this one.
 */
export async function requireActionAutonomy(
  trx: DatabaseTransaction,
  invocation: Pick<Invocation, 'context' | 'agent'>,
  action: string,
  contactId: string | undefined,
): Promise<void> {
  if (invocation.context.actorKind !== 'ai_agent') return;
  const { agent } = invocation;
  if (agent === undefined) throw new ApprovalRequiredError('not_delegable');
  const { level } = await readAutonomy(trx, { agent, action, contactId });
  if (!agentMayRun(level)) throw new ApprovalRequiredError('approval_required');
}

/**
 * An assistant tried to run a command it may only propose. It is a refusal like any other
 * 403, and the audit log keeps it apart from a role that lacks a permission.
 */
export class ApprovalRequiredError extends ForbiddenError {
  constructor(
    /** Why: the level asks for a person, or no assistant may run this command at all. */
    readonly reason: 'approval_required' | 'not_delegable',
  ) {
    super(
      reason === 'approval_required'
        ? 'The assistant may only propose this: a person has to approve it.'
        : 'An assistant cannot run this command.',
    );
  }
}
