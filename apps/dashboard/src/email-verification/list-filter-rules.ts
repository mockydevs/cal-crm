// The contact list's "Email verification" filter, as its address keeps it and as the list,
// its count and a bulk action send it: one condition on what email verification found of
// each contact's primary email address, written as the contract's filter (one group, one
// condition). It reads only the shape it writes, so an address holding any other filter is
// read as none. No schemas: the list's address is read by the code everyone loads first.
import type {
  ContactEmailVerification,
  contactEmailVerifications,
  ContactFilter,
  ContactViewState,
} from '@repo/contracts';

/** The six results, in the contract's order (list-filter-rules.test.ts holds them equal). */
export const verificationStates = [
  'valid',
  'risky',
  'invalid',
  'unknown',
  'unchecked',
  'excluded',
] as const satisfies typeof contactEmailVerifications;

export type VerificationOperator = 'any_of' | 'none_of' | 'is_empty' | 'is_not_empty';

/** Is any of, or none of, the results ticked; or no email address (empty), or one. */
export interface VerificationCondition {
  readonly operator: VerificationOperator;
  /** For any_of and none_of: the results ticked. */
  readonly values: readonly ContactEmailVerification[];
}

const FIELD = 'emailVerification';
const operators: readonly string[] = ['any_of', 'none_of', 'is_empty', 'is_not_empty'];
const isOperator = (value: unknown): value is VerificationOperator =>
  typeof value === 'string' && operators.includes(value);
const isState = (value: unknown): value is ContactEmailVerification =>
  verificationStates.some((state) => state === value);
const takesValues = (operator: VerificationOperator): boolean =>
  operator === 'any_of' || operator === 'none_of';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The filter for a condition, or none for no condition or a choice with nothing ticked. */
export function verificationFilterOf(
  condition: VerificationCondition | undefined,
): ContactFilter | undefined {
  if (condition === undefined) return undefined;
  const { operator } = condition;
  const values = verificationStates.filter((state) => condition.values.includes(state));
  if (takesValues(operator) && values.length === 0) return undefined;
  return {
    match: 'all',
    groups: [
      {
        match: 'all',
        conditions: [
          takesValues(operator) ? { field: FIELD, operator, values } : { field: FIELD, operator },
        ],
      },
    ],
  };
}

/** The condition a filter holds, when it is one this list writes; undefined for any other. */
export function verificationConditionOf(filter: unknown): VerificationCondition | undefined {
  if (!isRecord(filter) || filter['match'] !== 'all' || !Array.isArray(filter['groups']))
    return undefined;
  const [group, ...moreGroups] = filter['groups'] as unknown[];
  if (!isRecord(group) || moreGroups.length > 0 || group['match'] !== 'all') return undefined;
  if (!Array.isArray(group['conditions'])) return undefined;
  const [condition, ...more] = group['conditions'] as unknown[];
  if (!isRecord(condition) || more.length > 0 || condition['field'] !== FIELD) return undefined;
  const { operator, values } = condition;
  if (!isOperator(operator)) return undefined;
  if (!takesValues(operator)) return { operator, values: [] };
  if (!Array.isArray(values) || values.length === 0 || !values.every(isState)) return undefined;
  return { operator, values: verificationStates.filter((state) => values.includes(state)) };
}

/**
 * How many of the Filters panel's conditions narrow the contact list, beside the period and
 * the field condition the shared list rules count. Kept with the contact list's own rules,
 * so the other lists' pages do not carry it.
 */
export function filterConditionCount(filter: ContactViewState['filter']): number {
  return filter?.groups.reduce((sum, group) => sum + group.conditions.length, 0) ?? 0;
}
