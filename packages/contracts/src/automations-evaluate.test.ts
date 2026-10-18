import { describe, expect, it } from 'vitest';

import { evaluateCondition, type ConditionValues } from './automations-evaluate.js';

const now = new Date('2026-10-09T12:00:00Z');
const values: ConditionValues = {
  'contact.firstName': 'Ada',
  'contact.custom.services': ['opt_video', 'opt_lighting'],
  'contact.custom.guests': 120,
  'contact.custom.vip': true,
  'contact.custom.event_date': '2026-10-20',
  'contact.createdAt': '2026-10-01T08:00:00Z',
  'contact.custom.notes': '',
  'deal.amount': 1500,
};
const check = (condition: Parameters<typeof evaluateCondition>[0]) =>
  evaluateCondition(condition, values, now);

describe('a single comparison', () => {
  it.each([
    [{ field: 'contact.firstName', operator: 'equals', value: 'ada' }, true],
    [{ field: 'contact.firstName', operator: 'not_equals', value: 'Grace' }, true],
    [{ field: 'contact.custom.services', operator: 'includes', value: 'opt_video' }, true],
    [{ field: 'contact.custom.services', operator: 'excludes', value: 'opt_video' }, false],
    [{ field: 'contact.firstName', operator: 'includes', value: 'd' }, true],
    [{ field: 'contact.custom.guests', operator: 'greater_than', value: 100 }, true],
    [{ field: 'contact.custom.guests', operator: 'less_than', value: 100 }, false],
    [{ field: 'contact.custom.vip', operator: 'equals', value: true }, true],
    [{ field: 'contact.custom.event_date', operator: 'after', value: '2026-10-10' }, true],
    [{ field: 'contact.custom.event_date', operator: 'before', value: '2026-10-10' }, false],
    [{ field: 'contact.custom.event_date', operator: 'within_next', value: 'P14D' }, true],
    [{ field: 'contact.custom.event_date', operator: 'within_next', value: 'P7D' }, false],
    [{ field: 'contact.createdAt', operator: 'within_last', value: 'P10D' }, true],
    [{ field: 'contact.createdAt', operator: 'within_last', value: 'P3D' }, false],
    [{ field: 'contact.lastName', operator: 'is_empty' }, true],
    [{ field: 'contact.custom.notes', operator: 'is_empty' }, true],
    [{ field: 'contact.firstName', operator: 'is_set' }, true],
    [{ field: 'deal.amount', operator: 'greater_than', value: 1000 }, true],
  ] as const)('%j is %s', (condition, expected) => {
    expect(check(condition)).toBe(expected);
  });

  it('is false, never an error, when the field is missing or of another kind', () => {
    expect(check({ field: 'contact.lastName', operator: 'equals', value: 'x' })).toBe(false);
    expect(check({ field: 'contact.firstName', operator: 'greater_than', value: 3 })).toBe(false);
    expect(check({ field: 'contact.lastName', operator: 'within_last', value: 'P1D' })).toBe(false);
    expect(check({ field: 'contact.lastName', operator: 'not_equals', value: 'x' })).toBe(true);
  });
});

describe('combinations', () => {
  it('apply all, any and not', () => {
    const vip = { field: 'contact.custom.vip', operator: 'equals', value: true } as const;
    const small = { field: 'contact.custom.guests', operator: 'less_than', value: 50 } as const;
    expect(check({ all: [vip, small] })).toBe(false);
    expect(check({ any: [vip, small] })).toBe(true);
    expect(check({ not: small })).toBe(true);
    expect(check({ all: [vip, { not: { any: [small] } }] })).toBe(true);
  });
});
