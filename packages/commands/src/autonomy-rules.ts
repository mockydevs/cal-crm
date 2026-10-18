// Autonomy, as rules with no database in them: which level applies, and what a level lets
// an assistant do. A rule names an assistant and a kind of action, for the business or for
// one contact, and gives one of three levels. Only `act` lets the assistant run a command
// itself; at every other level it can only propose, and a person decides.
import { DEFAULT_AUTONOMY, type AutonomyLevel } from '@repo/contracts';

/** A rule as stored: for one contact, or (contactId null) for the whole business. */
export interface AutonomyRule {
  readonly contactId: string | null;
  readonly level: AutonomyLevel;
}

export interface AutonomyDecision {
  /** The level that applies. */
  readonly level: AutonomyLevel;
  /** Where it comes from: the contact's own rule, the business's, or the starting level. */
  readonly source: 'contact' | 'business' | 'default';
  /** What applies to a contact with no rule of their own. */
  readonly businessLevel: AutonomyLevel;
}

/**
 * The level for an action on a contact, from the rules for that assistant and action: the
 * contact's own rule first, then the business's, then the starting level: asking first,
 * unless the caller names another for this assistant and action. A rule for some other
 * contact says nothing.
 */
export function resolveAutonomy(
  rules: readonly AutonomyRule[],
  contactId: string | undefined,
  /** Where this assistant starts for this action with no rule at all (defaultAutonomy). */
  startingLevel: AutonomyLevel = DEFAULT_AUTONOMY,
): AutonomyDecision {
  const business = rules.find((rule) => rule.contactId === null);
  const businessLevel = business?.level ?? startingLevel;
  // With no contact in question nothing matches: a rule's contact is an id or null.
  const own = rules.find((rule) => rule.contactId === contactId);
  if (own !== undefined) return { level: own.level, source: 'contact', businessLevel };
  return {
    level: businessLevel,
    source: business === undefined ? 'default' : 'business',
    businessLevel,
  };
}

/** Whether an assistant at this level may run a command itself. Only `act` says yes. */
export function agentMayRun(level: AutonomyLevel): boolean {
  return level === 'act';
}
