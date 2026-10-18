// The headings of "Why didn't this run?": what the server's answer about one contact and
// one workflow is filed under. The sentences themselves are the server's own (each
// evaluation's `explanation`, the answer's `summary`); these are the words above them.
import { t } from '@lingui/core/macro';
import type { AutomationTriggerEvaluationReason } from '@repo/contracts';

type State = 'has_run' | 'not_started' | 'nothing_on_record';

const states: Readonly<Record<State, () => string>> = {
  has_run: () => t`It ran for this contact`,
  not_started: () => t`It did not start for this contact`,
  nothing_on_record: () => t`Nothing is on record`,
};

const reasons: Readonly<Record<AutomationTriggerEvaluationReason, () => string>> = {
  filter_mismatch: () => t`A trigger filter did not match`,
  condition_false: () => t`The trigger's conditions did not hold`,
  already_enrolled: () => t`The contact was already in the workflow`,
  reentry_not_allowed: () => t`The contact had already been through it`,
  paused: () => t`The workflow was paused`,
  contact_missing: () => t`The event was about no contact`,
  stopped_by_rule: () => t`A built-in rule stopped it`,
  refused_loop: () => t`It would have looped`,
};

/** The states and reasons that have words here, for a test to hold them to the contract's. */
export const explainedStates: readonly string[] = Object.keys(states);
export const explainedReasons: readonly string[] = Object.keys(reasons);

const has = <Key extends string>(table: Readonly<Record<Key, unknown>>, key: string): key is Key =>
  Object.hasOwn(table, key);

/** What the answer as a whole is headed; a state this version lacks goes by its own name. */
export function stateHeading(state: string): string {
  return has(states, state) ? states[state]() : state;
}

/** What one evaluation is headed; a reason this version lacks goes by its own name. */
export function reasonHeading(reason: string): string {
  return has(reasons, reason) ? reasons[reason]() : reason.replaceAll('_', ' ');
}

/** A value an evaluation compared, as text. */
export function comparedWords(value: unknown): string {
  if (value === null || value === undefined || value === '') return t`nothing`;
  if (typeof value === 'boolean') return value ? t`yes` : t`no`;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value))
    return value.length === 0 ? t`nothing` : value.map(comparedWords).join(', ');
  return JSON.stringify(value);
}

export interface Compared {
  readonly label: string;
  readonly value: string;
}

/**
 * What an evaluation's detail holds beside its sentence: what a filter wanted and what the
 * event had, the values a condition compared, or the rule that stopped it.
 */
export function comparedOf(detail: Readonly<Record<string, unknown>>): Compared[] {
  const rows: Compared[] = [];
  if ('expected' in detail)
    rows.push({ label: t`Expected`, value: comparedWords(detail['expected']) });
  if ('actual' in detail) rows.push({ label: t`Actual`, value: comparedWords(detail['actual']) });
  const { values, rule } = detail;
  if (typeof values === 'object' && values !== null && !Array.isArray(values))
    for (const [path, value] of Object.entries(values))
      rows.push({ label: path, value: comparedWords(value) });
  if (typeof rule === 'string') rows.push({ label: t`Rule`, value: rule.replaceAll('_', ' ') });
  return rows;
}
