// owner.assign: one team member, or the next of several in turn. The turn is a row per
// automation and step, locked for the step's transaction, so contacts enrolled at the same
// moment on any number of workers take different members, and a step that fails gives its
// turn back with the rest of what it did.
import { requireBusiness, type CommandContext } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId, ValidationError } from '@repo/kernel';
import { assignContactOwnerCommand, readContactDetails, type TaskOptions } from '@repo/module-crm';
import { sql } from 'kysely';

import { runActionCommand } from './actions-command.js';

/** An owner.assign step's settings, in either of its shapes. */
export type OwnerAssignment = (
  { readonly user: string } | { readonly users: readonly string[] }
) & { readonly onlyIfUnassigned?: boolean | undefined };

/** What the step came to. */
export interface OwnerAssigned {
  readonly output: Readonly<Record<string, unknown>>;
  readonly explanation: string;
}

/**
 * The members of a step's list from a place in it, once round: the order they are tried in
 * for the next contact. The place is read modulo the list's length, so it stays a place in
 * a list that was shortened since it was kept.
 */
export function turnOrder<T>(members: readonly T[], position: number): readonly T[] {
  if (members.length === 0) return [];
  const start = ((position % members.length) + members.length) % members.length;
  return [...members.slice(start), ...members.slice(0, start)];
}

/** The place after the member chosen, who was `passed` places on from `position`. */
export const nextTurn = (position: number, passed: number, size: number): number =>
  size === 0 ? 0 : ((((position % size) + size) % size) + passed + 1) % size;

const KEPT = 'The contact already has an owner, and this step leaves an owner in place.';

/**
 * Makes a team member the contact's owner, through the CRM's own command. With several
 * members, the next in turn who is still on the team; with onlyIfUnassigned, a contact that
 * has an owner keeps them and no turn is used.
 */
export async function assignStepOwner(
  trx: DatabaseTransaction,
  command: CommandContext,
  options: TaskOptions,
  input: {
    readonly contactId: string;
    readonly automationId: string;
    readonly stepKey: string;
    readonly config: OwnerAssignment;
  },
): Promise<OwnerAssigned> {
  const { config } = input;
  const id = toPublicId('contact', input.contactId);
  const assign = assignContactOwnerCommand(options);
  // The CRM's own read gives the revision its write checks, so nothing is guessed.
  const details = await readContactDetails(trx, command, id, options);
  if (config.onlyIfUnassigned === true && details.owner !== null)
    return { output: {}, explanation: KEPT };
  if ('user' in config) {
    await runActionCommand(command, assign, {
      id,
      owner: config.user,
      revision: details.ownerRevision,
    });
    return {
      output: { membershipId: config.user },
      explanation: "The contact's owner was assigned.",
    };
  }
  const businessId = requireBusiness(command.context);
  // The step's turn, made at its first contact and held to the end of the transaction.
  await sql`
    insert into automation.assignment_cursors (business_id, automation_id, step_key)
    values (${businessId}, ${input.automationId}, ${input.stepKey})
    on conflict do nothing
  `.execute(trx);
  const turn = await sql<{ next_position: number }>`
    select next_position from automation.assignment_cursors
    where business_id = ${businessId} and automation_id = ${input.automationId}
      and step_key = ${input.stepKey}
    for update
  `.execute(trx);
  const position = turn.rows[0]?.next_position ?? 0;
  const order = turnOrder(config.users, position);
  for (const [passed, member] of order.entries()) {
    // Tenancy says who is on the team now, and holds the membership until this commits.
    let userId: string | null;
    try {
      userId = await options.assignees.resolve(trx, command.context, member);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      userId = null;
    }
    if (userId === null) continue;
    await runActionCommand(command, assign, { id, owner: member, revision: details.ownerRevision });
    await sql`
      update automation.assignment_cursors
      set next_position = ${nextTurn(position, passed, config.users.length)}
      where business_id = ${businessId} and automation_id = ${input.automationId}
        and step_key = ${input.stepKey}
    `.execute(trx);
    const place = `number ${String((((position % order.length) + passed) % order.length) + 1)} of ${String(order.length)} in turn`;
    return {
      output: { membershipId: member },
      explanation:
        passed === 0
          ? `The contact's owner was assigned: ${place}.`
          : `The contact's owner was assigned: ${place}, after passing over ${String(passed)} who ${passed === 1 ? 'has' : 'have'} left the team.`,
    };
  }
  throw new ValidationError([
    {
      path: '/config/users',
      code: 'unavailable_member',
      message: 'None of the team members this step shares contacts between is on the team now.',
    },
  ]);
}
