// The Contact Engagement Score trigger's filter: the score a change left the contact with,
// compared as GoHighLevel's trigger compares it (equal to, not equal to, greater than, at
// least, less than, at most). Every change of the score is a contact.score_changed event
// (crm/scoring/scores.ts), so the trigger starts each time a change leaves the score passing.
import type { ScoreComparison } from '@repo/contracts';

export interface ScoreFilter {
  readonly operator: ScoreComparison;
  readonly score: number;
}

export interface ScoreMismatchResult {
  readonly filter: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

function passes(filter: ScoreFilter, score: number): boolean {
  switch (filter.operator) {
    case 'equals':
      return score === filter.score;
    case 'not_equals':
      return score !== filter.score;
    case 'gt':
      return score > filter.score;
    case 'gte':
      return score >= filter.score;
    case 'lt':
      return score < filter.score;
    case 'lte':
      return score <= filter.score;
  }
}

/** Why the score a change left does not pass the trigger's filter; nothing when it does. */
export function scoreMismatch(
  filter: ScoreFilter,
  payload: Readonly<Record<string, unknown>>,
): ScoreMismatchResult | undefined {
  const score = payload['score'];
  if (typeof score === 'number' && passes(filter, score)) return undefined;
  return {
    filter: 'score',
    expected: `${filter.operator} ${String(filter.score)}`,
    actual: typeof score === 'number' ? score : null,
  };
}
