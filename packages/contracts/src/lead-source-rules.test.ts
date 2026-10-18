import { describe, expect, it } from 'vitest';

import {
  createLeadSourceRuleInput,
  LEAD_SOURCE_RULE_LIMITS,
  leadSourceChoiceLabel,
  leadSourceCondition,
  leadSourceFactNames,
  leadSourceFacts,
  leadSourceOperatorLabels,
  leadSourceOperatorOperand,
  leadSourceOperators,
  leadSourceOperatorsOf,
  leadSourceRuleEndpoints,
  matchesLeadSourceCondition,
  reorderLeadSourceRulesInput,
  updateLeadSourceRuleInput,
  type LeadSourceCondition,
} from './lead-source-rules.js';
import { leadSourceKeys } from './lead-sources.js';

const TAG = 'tag_01h455vb4pex5vsknk084sn02q';
const FIELD = 'fld_01h455vb4pex5vsknk084sn02q';
const RULE = 'lsr_01h455vb4pex5vsknk084sn02q';

const codes = (given: unknown): string[] => {
  const parsed = leadSourceCondition.safeParse(given);
  return parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) =>
          `${issue.path.join('/')} ${(issue as { params?: { code?: string } }).params?.code ?? issue.code}`,
      );
};

describe('a condition', () => {
  it('takes each fact with the operators of its kind, and no other', () => {
    for (const fact of leadSourceFactNames) {
      const { kind } = leadSourceFacts[fact];
      const allowed = leadSourceOperatorsOf(fact);
      expect(allowed.length, fact).toBeGreaterThan(0);
      for (const op of leadSourceOperators) {
        const operand = leadSourceOperatorOperand[op];
        const info: { readonly kind: string; readonly choices?: readonly string[] } =
          leadSourceFacts[fact];
        const value = info.choices?.[0] ?? 'spring';
        const given = {
          fact,
          op,
          ...(kind === 'parameter' ? { name: 'promo' } : {}),
          ...(operand === 'value' ? { value } : operand === 'values' ? { values: [value] } : {}),
        };
        expect(leadSourceCondition.safeParse(given).success, `${fact} ${op}`).toBe(
          allowed.includes(op),
        );
      }
    }
    expect(leadSourceOperatorsOf('lead_source')).toEqual(['is', 'is_not', 'is_one_of']);
    expect(leadSourceOperatorsOf('click_id_google')).toEqual(['is_not_empty', 'is_empty']);
    expect(leadSourceOperatorsOf('utm_campaign')).toEqual(leadSourceOperators);
    expect(leadSourceOperatorsOf('parameter')).toEqual(leadSourceOperators);
    expect(Object.keys(leadSourceOperatorLabels)).toEqual([...leadSourceOperators]);
  });

  it('is refused in words when its parts do not fit', () => {
    expect(codes({ fact: 'utm_source', op: 'is' })).toEqual(['value required']);
    expect(codes({ fact: 'utm_source', op: 'is', value: 'a', values: ['a'] })).toEqual([
      'values unexpected_values',
    ]);
    expect(codes({ fact: 'utm_source', op: 'is_empty', value: 'a' })).toEqual([
      'value unexpected_value',
    ]);
    expect(codes({ fact: 'utm_source', op: 'is_one_of' })).toEqual(['values required']);
    expect(codes({ fact: 'parameter', op: 'is', value: 'a' })).toEqual(['name required']);
    expect(codes({ fact: 'utm_source', name: 'promo', op: 'is', value: 'a' })).toEqual([
      'name unexpected_name',
    ]);
    expect(codes({ fact: 'click_id_meta', op: 'contains', value: 'a' })).toEqual([
      'op unsupported_operator',
    ]);
    expect(codes({ fact: 'lead_source', op: 'is', value: 'Google Ads' })).toEqual([
      'value unknown_choice',
    ]);
    expect(codes({ fact: 'medium', op: 'is_one_of', values: ['form', 'email'] })).toEqual([
      'values unknown_choice',
    ]);
    expect(codes({ fact: 'session_source', op: 'is', value: 'crm_ui' })).toEqual([
      'value unknown_choice',
    ]);
    expect(codes({ fact: 'weather', op: 'is', value: 'a' })).toHaveLength(1);
    expect(codes({ fact: 'utm_source', op: 'is', value: 'a\nb' })).toHaveLength(1);
    expect(codes({ fact: 'utm_source', op: 'is', value: 'x'.repeat(201) })).toHaveLength(1);
    expect(
      codes({ fact: 'utm_source', op: 'is_one_of', values: Array.from({ length: 21 }, String) }),
    ).toHaveLength(1);
    expect(codes({ fact: 'parameter', name: '9lives', op: 'is_empty' })).toHaveLength(1);
  });

  it('lists every built-in lead source as a choice, with a name for each', () => {
    expect(leadSourceFacts.lead_source.choices).toBe(leadSourceKeys);
    for (const key of leadSourceKeys) expect(leadSourceChoiceLabel(key)).not.toBe('');
    expect(leadSourceChoiceLabel('google_ads')).toBe('Google Ads');
  });
});

describe('how a condition is compared', () => {
  const holds = (
    op: LeadSourceCondition['op'],
    actual: string | null,
    value?: string,
    values?: string[],
  ) => matchesLeadSourceCondition({ op, value, values }, actual);

  it.each([
    ['is', 'Spring', 'spring', true],
    ['is', ' spring ', 'SPRING', true],
    ['is', 'spring sale', 'spring', false],
    ['is', null, 'spring', false],
    ['is_not', 'autumn', 'spring', true],
    ['is_not', 'SPRING', 'spring', false],
    // A visit that did not say it is not "spring" either.
    ['is_not', null, 'spring', true],
    ['contains', 'Big Spring Sale', 'spring', true],
    ['contains', 'autumn', 'spring', false],
    ['contains', null, 'spring', false],
    ['starts_with', 'Spring-2026', 'spring', true],
    ['starts_with', 'big spring', 'spring', false],
    ['starts_with', null, 'spring', false],
  ] as const)('%s: %j against %j is %j', (op, actual, value, expected) => {
    expect(holds(op, actual, value)).toBe(expected);
  });

  it('knows empty from not, and one of a list', () => {
    expect(holds('is_empty', null)).toBe(true);
    expect(holds('is_empty', '  ')).toBe(true);
    expect(holds('is_empty', 'a')).toBe(false);
    expect(holds('is_not_empty', 'a')).toBe(true);
    expect(holds('is_not_empty', null)).toBe(false);
    expect(holds('is_one_of', 'B', undefined, ['a', 'b'])).toBe(true);
    expect(holds('is_one_of', 'c', undefined, ['a', 'b'])).toBe(false);
    expect(holds('is_one_of', null, undefined, ['a'])).toBe(false);
  });
});

describe('a rule', () => {
  const conditions = [{ fact: 'utm_campaign', op: 'contains', value: 'spring' }];

  it('is created with its defaults, and must do something', () => {
    expect(
      createLeadSourceRuleInput.parse({ name: ' Spring ', conditions, source: ' Spring promo ' }),
    ).toEqual({
      name: 'Spring',
      enabled: true,
      conditions,
      source: 'Spring promo',
      tagIds: [],
      fieldWrites: [],
    });
    const idle = createLeadSourceRuleInput.safeParse({ name: 'Idle', conditions });
    expect(idle.success).toBe(false);
    expect(idle.error?.issues[0]).toMatchObject({
      path: ['source'],
      message: 'Say what the rule does: name the Source, add a tag or fill a field.',
    });
    for (const does of [{ tagIds: [TAG] }, { fieldWrites: [{ fieldId: FIELD, value: 'x' }] }])
      expect(createLeadSourceRuleInput.safeParse({ name: 'R', conditions, ...does }).success).toBe(
        true,
      );
  });

  it('holds to its limits', () => {
    const rule = { name: 'R', conditions, source: 'S' };
    const refused = (change: Record<string, unknown>) =>
      !createLeadSourceRuleInput.safeParse({ ...rule, ...change }).success;
    expect(LEAD_SOURCE_RULE_LIMITS).toMatchObject({ rules: 50, conditions: 5, tags: 5 });
    expect(refused({ conditions: [] })).toBe(true);
    expect(refused({ conditions: Array.from({ length: 6 }, () => conditions[0]) })).toBe(true);
    expect(refused({ conditions: Array.from({ length: 5 }, () => conditions[0]) })).toBe(false);
    expect(refused({ name: 'x'.repeat(81) })).toBe(true);
    expect(refused({ name: '  ' })).toBe(true);
    expect(refused({ source: 'x'.repeat(201) })).toBe(true);
    expect(refused({ source: 'two\nlines' })).toBe(true);
    expect(refused({ tagIds: [TAG, TAG] })).toBe(true);
    expect(refused({ tagIds: ['con_01h455vb4pex5vsknk084sn02q'] })).toBe(true);
    expect(
      refused({
        fieldWrites: [
          { fieldId: FIELD, value: 'a' },
          { fieldId: FIELD, value: 'b' },
        ],
      }),
    ).toBe(true);
    expect(refused({ fieldWrites: [{ fieldId: FIELD, value: '' }] })).toBe(true);
    expect(refused({ position: 1 })).toBe(true);
  });

  it('is saved whole with the revision it was read at, and reordered by naming each once', () => {
    const whole = {
      name: 'R',
      enabled: false,
      conditions,
      source: null,
      tagIds: [TAG],
      fieldWrites: [],
    };
    expect(updateLeadSourceRuleInput.safeParse({ ...whole, revision: 3 }).success).toBe(true);
    expect(updateLeadSourceRuleInput.safeParse(whole).success).toBe(false);
    expect(updateLeadSourceRuleInput.safeParse({ ...whole, revision: 0 }).success).toBe(false);
    const revision = 'a'.repeat(64);
    expect(reorderLeadSourceRulesInput.safeParse({ ruleIds: [RULE], revision }).success).toBe(true);
    expect(reorderLeadSourceRulesInput.safeParse({ ruleIds: [RULE, RULE], revision }).success).toBe(
      false,
    );
    expect(reorderLeadSourceRulesInput.safeParse({ ruleIds: [], revision }).success).toBe(false);
    expect(reorderLeadSourceRulesInput.safeParse({ ruleIds: [RULE] }).success).toBe(false);
  });

  it('has its six operations, the order before the one that takes an id', () => {
    expect(
      leadSourceRuleEndpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    ).toEqual([
      'get /lead-sources/rules',
      'post /lead-sources/rules',
      'post /lead-sources/rules/order',
      'get /lead-sources/rules/{ruleId}',
      'put /lead-sources/rules/{ruleId}',
      'delete /lead-sources/rules/{ruleId}',
    ]);
  });
});
