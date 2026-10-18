import type { ContactViewState, FieldListOptions } from '@repo/contracts';
import type { VerificationCondition } from './email-verification/list-filter-rules';

/**
 * What the panel applies: the period, where the list has one, the field condition, and the
 * contact list's Email verification.
 */
export interface AppliedFilters {
  readonly added?: NonNullable<ContactViewState['added']>;
  readonly fieldId?: string;
  readonly fieldOperator?: NonNullable<FieldListOptions['fieldOperator']>;
  readonly fieldValue?: string;
  /** The contact list's Email verification condition. */
  readonly emailVerification?: VerificationCondition;
}

export interface BuiltInOrder<Key extends string> {
  readonly key: Key;
  readonly label: string;
}

/** The list's order: one of its built-in orders, or a custom field in a direction. */
export type ListOrder<Key extends string> =
  { readonly by: Key } | { readonly field: string; readonly direction: 'asc' | 'desc' };
