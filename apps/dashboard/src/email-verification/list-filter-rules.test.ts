import { contactEmailVerifications, contactFilter, parseContactFilter } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  filterConditionCount,
  verificationConditionOf,
  verificationFilterOf,
  verificationStates,
  type VerificationCondition,
} from './list-filter-rules';

const condition = (
  operator: VerificationCondition['operator'],
  values: VerificationCondition['values'] = [],
): VerificationCondition => ({ operator, values });

describe("the contact list's email verification filter", () => {
  it('knows the six results the contract knows, in its order', () => {
    expect(verificationStates).toEqual(contactEmailVerifications);
  });

  it('writes one condition as the filter the list and its count take', () => {
    const filter = verificationFilterOf(condition('any_of', ['invalid', 'risky']));
    expect(filter).toEqual({
      match: 'all',
      groups: [
        {
          match: 'all',
          conditions: [
            // In the contract's order, whatever order they were ticked in.
            { field: 'emailVerification', operator: 'any_of', values: ['risky', 'invalid'] },
          ],
        },
      ],
    });
    expect(contactFilter.parse(filter)).toEqual(filter);
    // Sent as JSON text, as listContacts and countContacts take it.
    expect(parseContactFilter(JSON.stringify(filter))).toEqual(filter);
  });

  it('writes is empty and is not empty without values', () => {
    for (const operator of ['is_empty', 'is_not_empty'] as const) {
      const filter = verificationFilterOf(condition(operator, ['valid']));
      expect(filter?.groups[0]?.conditions).toEqual([{ field: 'emailVerification', operator }]);
      expect(contactFilter.safeParse(filter).success).toBe(true);
    }
  });

  it('writes nothing for no condition, or a choice with nothing ticked', () => {
    expect(verificationFilterOf(undefined)).toBeUndefined();
    expect(verificationFilterOf(condition('none_of'))).toBeUndefined();
  });

  it('reads back what it wrote, each result once in the contract order', () => {
    for (const each of [
      condition('any_of', ['valid']),
      condition('none_of', ['excluded', 'unchecked']),
      condition('is_empty'),
      condition('is_not_empty'),
    ])
      expect(verificationConditionOf(verificationFilterOf(each))).toEqual({
        ...each,
        values: verificationStates.filter((state) => each.values.includes(state)),
      });
  });

  it('reads nothing from an address that holds anything else', () => {
    const written = verificationFilterOf(condition('any_of', ['valid']));
    for (const value of [
      undefined,
      'valid',
      [],
      { match: 'all', groups: [] },
      { ...written, match: 'any' },
      {
        match: 'all',
        groups: [
          { match: 'all', conditions: [{ field: 'tags', operator: 'any_of', values: ['t'] }] },
        ],
      },
      {
        match: 'all',
        groups: [
          {
            match: 'all',
            conditions: [{ field: 'emailVerification', operator: 'is', value: 'x' }],
          },
        ],
      },
      {
        match: 'all',
        groups: [
          {
            match: 'all',
            conditions: [{ field: 'emailVerification', operator: 'any_of', values: ['great'] }],
          },
        ],
      },
      {
        match: 'all',
        groups: [
          { match: 'all', conditions: [{ field: 'emailVerification', operator: 'any_of' }] },
        ],
      },
    ])
      expect(verificationConditionOf(value)).toBeUndefined();
  });
});

describe('filterConditionCount', () => {
  it("counts each of the Filters panel's conditions, and none without a filter", () => {
    const condition = { field: 'emailVerification', operator: 'is_empty' as const };
    expect(filterConditionCount(undefined)).toBe(0);
    expect(
      filterConditionCount({
        match: 'all',
        groups: [
          { match: 'all', conditions: [condition, condition] },
          { match: 'any', conditions: [condition] },
        ],
      }),
    ).toBe(3);
  });
});
