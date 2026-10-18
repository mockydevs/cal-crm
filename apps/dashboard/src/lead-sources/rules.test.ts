import {
  createLeadSourceRuleInput,
  LEAD_SOURCE_RULE_LIMITS,
  leadSourceCondition,
  leadSourceFactNames,
  leadSourceFacts,
  leadSourceOperatorOperand,
  leadSourceOperators,
  leadSourceOperatorsOf,
  type LeadSourceCondition,
  type LeadSourceFact,
  type LeadSourceRule,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  canAddCondition,
  canAddFieldWrite,
  canAddRule,
  checkRule,
  choiceName,
  conditionDraftOf,
  conditionOf,
  conditionPhrase,
  copyName,
  droppedOrder,
  emptyCondition,
  emptyRule,
  factChoices,
  factInfo,
  isClean,
  listOf,
  movedOrder,
  noRuleProblems,
  ruleBodyOf,
  ruleDraftOf,
  ruleProblemsOf,
  ruleSentence,
  trialFacts,
  tryRule,
  valueControl,
  withFact,
  withOperator,
  type ConditionDraft,
  type RuleDraft,
  type SentenceWords,
  type TrialReading,
} from './rules';

const tagA = 'tag_01k8e2wzr0e008000000000001';
const tagB = 'tag_01k8e2wzr0e008000000000002';
const fieldA = 'fld_01k8e2wzr0e008000000000001';
const at = '2026-10-14T09:00:00.000Z';

const words: SentenceWords = {
  choice: (fact, value) => `${fact}:${value}`,
  tagName: (id) => (id === tagA ? 'Promo' : id === tagB ? 'VIP' : 'a deleted tag'),
  fieldName: (id) => (id === fieldA ? 'Campaign' : 'a field that is gone'),
  has: (label) => `has a ${label}`,
  hasNo: (label) => `has no ${label}`,
  parameter: (name) => `address parameter ${name}`,
  either: (values) => values.join(' or '),
  quoted: (value) => `“${value}”`,
};

const condition = (patch: Partial<ConditionDraft> = {}): ConditionDraft => ({
  ...emptyCondition(),
  ...patch,
});
const draft = (patch: Partial<RuleDraft> = {}): RuleDraft => ({
  name: 'Spring promo',
  enabled: true,
  conditions: [
    condition({ fact: 'utm_campaign', op: 'contains', value: 'spring' }),
    condition({ fact: 'lead_source', op: 'is', value: 'facebook_ads' }),
  ],
  source: 'Spring promo',
  tagIds: [tagA, tagB],
  fieldWrites: [],
  ...patch,
});

/** A value each kind of operand can be given, for a fact. */
const filled = (fact: LeadSourceFact, op: (typeof leadSourceOperators)[number]): ConditionDraft => {
  const choices = factInfo(fact).choices;
  const one = choices?.[0] ?? 'spring';
  const two = choices?.[1] ?? 'summer';
  return {
    fact,
    name: factInfo(fact).kind === 'parameter' ? 'promo' : '',
    op,
    value: one,
    values: [one, two],
  };
};

describe('the vocabulary', () => {
  it('offers every fact of the contract, in its order, and no other', () => {
    expect(factChoices).toEqual(leadSourceFactNames);
    for (const fact of factChoices) expect(factInfo(fact)).toBe(leadSourceFacts[fact]);
  });

  it('makes a condition the contract takes for every fact with every operator it takes', () => {
    for (const fact of leadSourceFactNames)
      for (const op of leadSourceOperatorsOf(fact)) {
        const made = conditionOf(filled(fact, op));
        const parsed = leadSourceCondition.safeParse(made);
        expect(parsed.success, `${fact} ${op}`).toBe(true);
        // And back: what the editor shows for a stored condition is what was stored.
        expect(conditionOf(conditionDraftOf(made)), `${fact} ${op}`).toEqual(made);
      }
  });

  it('sends only what the operator is given: a value, a list or nothing', () => {
    for (const op of leadSourceOperators) {
      const made = conditionOf(filled('utm_campaign', op));
      const operand = leadSourceOperatorOperand[op];
      expect('value' in made, op).toBe(operand === 'value');
      expect('values' in made, op).toBe(operand === 'values');
      expect('name' in made, op).toBe(false);
    }
    expect(conditionOf(filled('parameter', 'is')).name).toBe('promo');
    expect(
      conditionOf(condition({ fact: 'utm_source', op: 'is_one_of', values: [' a ', '', 'b'] })),
    ).toEqual({ fact: 'utm_source', op: 'is_one_of', values: ['a', 'b'] });
    expect(conditionOf(condition({ op: 'is', value: '  spring ' })).value).toBe('spring');
  });

  it('says what kind of box each value is', () => {
    expect(valueControl({ fact: 'utm_campaign', op: 'contains' })).toBe('text');
    expect(valueControl({ fact: 'utm_campaign', op: 'is_one_of' })).toBe('texts');
    expect(valueControl({ fact: 'utm_campaign', op: 'is_empty' })).toBe('none');
    expect(valueControl({ fact: 'lead_source', op: 'is' })).toBe('choice');
    expect(valueControl({ fact: 'session_source', op: 'is_one_of' })).toBe('choices');
    expect(valueControl({ fact: 'click_id_google', op: 'is_not_empty' })).toBe('none');
    expect(valueControl({ fact: 'parameter', op: 'starts_with' })).toBe('text');
  });

  it('keeps what still means something when the fact changes', () => {
    const typed = condition({ fact: 'utm_campaign', op: 'contains', value: 'spring' });
    expect(withFact(typed, 'utm_content')).toEqual({ ...typed, fact: 'utm_content' });
    // A list of choices takes no "contains", and words are no choice of it.
    expect(withFact(typed, 'lead_source')).toEqual({
      fact: 'lead_source',
      name: '',
      op: 'is',
      value: '',
      values: [],
    });
    // A click id is there or not: the first of its two operators, "is not empty".
    expect(withFact(typed, 'click_id_google').op).toBe('is_not_empty');
    const chosen = condition({ fact: 'lead_source', op: 'is', value: 'google_ads' });
    expect(withFact(chosen, 'session_source').value).toBe('');
    expect(withFact(chosen, 'utm_source').value).toBe('');
    const named = condition({ fact: 'parameter', name: 'promo', op: 'is', value: 'x' });
    expect(withFact(named, 'utm_term')).toEqual({ ...named, fact: 'utm_term', name: '' });
    expect(withFact(named, 'parameter').name).toBe('promo');
  });

  it('hands a single value over to a list and back when the operator changes', () => {
    const one = condition({ op: 'is', value: ' spring ' });
    expect(withOperator(one, 'is_one_of').values).toEqual(['spring']);
    expect(withOperator(condition({ op: 'is', value: ' ' }), 'is_one_of').values).toEqual([]);
    const many = condition({ op: 'is_one_of', value: '', values: ['spring', 'summer'] });
    expect(withOperator(many, 'is').value).toBe('spring');
    expect(withOperator(condition({ op: 'is_one_of', values: [] }), 'is').value).toBe('');
    // What is already there stays.
    expect(withOperator({ ...one, values: ['kept'] }, 'is_one_of').values).toEqual(['kept']);
    expect(withOperator({ ...many, value: 'kept' }, 'contains').value).toBe('kept');
    expect(withOperator(one, 'is_empty')).toEqual({ ...one, op: 'is_empty' });
  });

  it('reads a typed list by its commas and lines', () => {
    expect(listOf(' spring, summer\nautumn ,, ')).toEqual(['spring', 'summer', 'autumn']);
    expect(listOf('')).toEqual([]);
  });
});

describe('a rule to and from the API', () => {
  const stored: LeadSourceRule = {
    id: 'lsr_01k8e2wzr0e008000000000001',
    position: 1,
    name: 'Spring promo',
    enabled: false,
    conditions: [
      { fact: 'utm_campaign', op: 'contains', value: 'spring' },
      { fact: 'parameter', name: 'promo', op: 'is_one_of', values: ['a', 'b'] },
      { fact: 'click_id_google', op: 'is_not_empty' },
    ],
    source: null,
    tagIds: [tagA],
    fieldWrites: [{ fieldId: fieldA, value: 'spring' }],
    problems: [],
    revision: 3,
    createdAt: at,
    updatedAt: at,
  };

  it('opens a stored rule in the editor and sends it back unchanged', () => {
    const opened = ruleDraftOf(stored);
    expect(opened.source).toBe('');
    expect(opened.conditions[1]).toEqual({
      fact: 'parameter',
      name: 'promo',
      op: 'is_one_of',
      value: '',
      values: ['a', 'b'],
    });
    expect(ruleBodyOf(opened)).toEqual({
      name: stored.name,
      enabled: false,
      conditions: stored.conditions,
      source: null,
      tagIds: [tagA],
      fieldWrites: [{ fieldId: fieldA, value: 'spring' }],
    });
  });

  it('trims what was typed, and an empty Source names none', () => {
    const body = ruleBodyOf(
      draft({
        name: '  Spring  ',
        source: '   ',
        fieldWrites: [{ fieldId: fieldA, value: ' x ' }],
      }),
    );
    expect(body.name).toBe('Spring');
    expect(body.source).toBeNull();
    expect(body.fieldWrites).toEqual([{ fieldId: fieldA, value: 'x' }]);
    expect(ruleBodyOf(draft()).source).toBe('Spring promo');
  });

  it('starts a new rule with one condition, switched on, doing nothing yet', () => {
    const fresh = emptyRule();
    expect(fresh.enabled).toBe(true);
    expect(fresh.conditions).toHaveLength(1);
    expect(leadSourceOperatorsOf(emptyCondition().fact)).toContain(emptyCondition().op);
    const checked = checkRule(fresh);
    expect(checked.ok).toBe(false);
  });

  it('checks a rule with the schema of the API, and says what the API would', () => {
    const good = checkRule(draft());
    expect(good.ok && createLeadSourceRuleInput.safeParse(good.body).success).toBe(true);

    const bad = checkRule(
      draft({
        name: ' ',
        source: '',
        tagIds: [],
        conditions: [
          condition({ fact: 'utm_campaign', op: 'contains', value: '' }),
          condition({ fact: 'parameter', name: '', op: 'is', value: 'x' }),
          condition({ fact: 'lead_source', op: 'is_one_of', values: [] }),
        ],
      }),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const problems = ruleProblemsOf(bad.issues);
    expect(problems.name).toBe('Give the rule a name.');
    expect(problems.conditions[0]).toEqual({ value: 'Enter a value.' });
    expect(problems.conditions[1]?.['name']).toBeDefined();
    // A list's problem is shown in the row's one value box.
    expect(problems.conditions[2]).toEqual({ value: 'List at least one value.' });
    expect(isClean(problems)).toBe(false);
  });

  it('says a rule that does nothing has to do something, at the Source', () => {
    const idle = checkRule(draft({ source: '', tagIds: [], fieldWrites: [] }));
    expect(idle.ok).toBe(false);
    if (idle.ok) return;
    expect(ruleProblemsOf(idle.issues).source).toBe(
      'Say what the rule does: name the Source, add a tag or fill a field.',
    );
  });

  it("sorts the server's refusals to the boxes they name", () => {
    const problems = ruleProblemsOf([
      { path: '/name', message: 'A' },
      { path: '/name', message: 'second is dropped' },
      { path: '/source', message: 'B' },
      { path: '/tagIds/1', message: 'C' },
      { path: '/conditions', message: 'D' },
      { path: '/conditions/1/op', message: 'E' },
      { path: '/conditions/1/values/0', message: 'F' },
      { path: '/conditions/3', message: 'G' },
      { path: '/fieldWrites', message: 'H' },
      { path: '/fieldWrites/0/fieldId', message: 'I' },
      { path: '/fieldWrites/2', message: 'J' },
      { path: '/revision', message: 'K' },
      { path: '', message: 'L' },
    ]);
    expect(problems).toEqual({
      name: 'A',
      source: 'B',
      tagIds: 'C',
      conditionList: 'D',
      conditions: { 1: { op: 'E', value: 'F' }, 3: { value: 'G' } },
      fieldWriteList: 'H',
      fieldWrites: { 0: { fieldId: 'I' }, 2: { value: 'J' } },
      form: 'K',
    });
    expect(isClean(noRuleProblems)).toBe(true);
    for (const path of ['/name', '/source', '/tagIds', '/conditions', '/fieldWrites', '/x'])
      expect(isClean(ruleProblemsOf([{ path, message: 'no' }])), path).toBe(false);
    expect(isClean(ruleProblemsOf([{ path: '/conditions/0/value', message: 'no' }]))).toBe(false);
    expect(isClean(ruleProblemsOf([{ path: '/fieldWrites/0/value', message: 'no' }]))).toBe(false);
  });
});

describe('limits and order', () => {
  it('says when the limits are reached, by the numbers of the contract', () => {
    expect(canAddRule(LEAD_SOURCE_RULE_LIMITS.rules - 1)).toBe(true);
    expect(canAddRule(LEAD_SOURCE_RULE_LIMITS.rules)).toBe(false);
    const full = Array.from({ length: LEAD_SOURCE_RULE_LIMITS.conditions }, () => condition());
    expect(canAddCondition({ conditions: full })).toBe(false);
    expect(canAddCondition({ conditions: full.slice(1) })).toBe(true);
    const writes = Array.from({ length: LEAD_SOURCE_RULE_LIMITS.fieldWrites }, () => ({
      fieldId: fieldA,
      value: 'x',
    }));
    expect(canAddFieldWrite({ fieldWrites: writes })).toBe(false);
    expect(canAddFieldWrite({ fieldWrites: [] })).toBe(true);
  });

  it('moves a rule one place, and nowhere past either end', () => {
    expect(movedOrder(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(movedOrder(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(movedOrder(['a', 'b', 'c'], 0, -1)).toBeUndefined();
    expect(movedOrder(['a', 'b', 'c'], 2, 1)).toBeUndefined();
    expect(movedOrder(['a'], 5, 1)).toBeUndefined();
  });

  it('puts a dragged rule where it was dropped', () => {
    expect(droppedOrder(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(droppedOrder(['a', 'b', 'c', 'd'], 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
    expect(droppedOrder(['a', 'b'], 'a', 'a')).toBeUndefined();
    expect(droppedOrder(['a', 'b'], 'x', 'a')).toBeUndefined();
    expect(droppedOrder(['a', 'b'], 'a', 'x')).toBeUndefined();
  });

  it('names a copy within what a name may hold', () => {
    expect(copyName('Spring promo', ' (copy)')).toBe('Spring promo (copy)');
    const long = 'x'.repeat(LEAD_SOURCE_RULE_LIMITS.nameLength);
    const copied = copyName(long, ' (copy)');
    expect(copied).toHaveLength(LEAD_SOURCE_RULE_LIMITS.nameLength);
    expect(copied.endsWith(' (copy)')).toBe(true);
    expect(
      copyName('abc', 'y'.repeat(LEAD_SOURCE_RULE_LIMITS.nameLength + 5)).startsWith('y'),
    ).toBe(true);
  });
});

describe('a rule as a sentence', () => {
  it('says each kind of condition in words', () => {
    const phrase = (patch: Partial<ConditionDraft>): string =>
      conditionPhrase(condition(patch), words);
    expect(phrase({ fact: 'utm_campaign', op: 'contains', value: ' spring ' })).toBe(
      'UTM campaign contains “spring”',
    );
    expect(phrase({ fact: 'utm_source', op: 'is_empty' })).toBe('UTM source is empty');
    expect(phrase({ fact: 'utm_source', op: 'is_one_of', values: ['a', 'b'] })).toBe(
      'UTM source is one of “a” or “b”',
    );
    expect(phrase({ fact: 'lead_source', op: 'is', value: 'facebook_ads' })).toBe(
      'Lead source (built-in) is Facebook Ads',
    );
    expect(phrase({ fact: 'lead_source', op: 'is', value: 'source_param' })).toBe(
      'Lead source (built-in) is A name the link chose (source=…)',
    );
    expect(phrase({ fact: 'lead_source', op: 'is', value: 'not_a_key' })).toBe(
      'Lead source (built-in) is not_a_key',
    );
    expect(
      phrase({ fact: 'session_source', op: 'is_one_of', values: ['paid_search', 'direct'] }),
    ).toBe('Session source is one of session_source:paid_search or session_source:direct');
    expect(phrase({ fact: 'click_id_google', op: 'is_not_empty' })).toBe('has a Google click ID');
    expect(phrase({ fact: 'click_id_meta', op: 'is_empty' })).toBe('has no Meta click ID');
    expect(phrase({ fact: 'parameter', name: ' promo ', op: 'starts_with', value: 'sp' })).toBe(
      'address parameter promo starts with “sp”',
    );
    expect(choiceName('medium', 'form', words)).toBe('medium:form');
  });

  it('reads a whole rule: when these hold, it does these', () => {
    expect(ruleSentence(draft(), words)).toEqual({
      when: ['UTM campaign contains “spring”', 'Lead source (built-in) is Facebook Ads'],
      source: 'Spring promo',
      tags: ['Promo', 'VIP'],
      fills: [],
    });
    expect(
      ruleSentence(
        draft({
          source: ' ',
          tagIds: ['tag_gone'],
          fieldWrites: [
            { fieldId: fieldA, value: ' spring ' },
            { fieldId: 'fld_gone', value: 'x' },
          ],
        }),
        words,
      ),
    ).toMatchObject({
      source: undefined,
      tags: ['a deleted tag'],
      fills: [
        { field: 'Campaign', value: 'spring' },
        { field: 'a field that is gone', value: 'x' },
      ],
    });
  });
});

describe('trying a link', () => {
  const nothing = {
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    utmTerm: null,
    matchType: null,
    campaignId: null,
    adGroupId: null,
    adId: null,
    referrerDomain: null,
    landingUrl: 'https://www.example.com/offer/step-2',
  };
  const address =
    'https://www.example.com/offer/step-2?utm_source=facebook&utm_medium=paid_social&utm_campaign=Spring-2026&promo=VIP&fbclid=abc';
  const preview: TrialReading = {
    sourceRule: 'facebook_ads',
    sessionSource: 'paid_social',
    facts: {
      ...nothing,
      utmSource: 'facebook',
      utmMedium: 'paid_social',
      utmCampaign: 'Spring-2026',
      campaignId: '42',
      adGroupId: '43',
      adId: '44',
      utmContent: 'video',
      utmTerm: 'venue',
      matchType: 'p',
      referrerDomain: 'l.facebook.com',
    },
    clickIds: ['fbclid'],
  };

  it("reads each fact from the server's own answer, and the page's parts from the address", () => {
    const factOf = trialFacts(preview, address);
    const read = (fact: LeadSourceFact, name = ''): string | null => factOf({ fact, name });
    expect(read('lead_source')).toBe('facebook_ads');
    expect(read('session_source')).toBe('paid_social');
    expect(read('medium')).toBe('form');
    expect(read('utm_source')).toBe('facebook');
    expect(read('utm_medium')).toBe('paid_social');
    expect(read('utm_campaign')).toBe('Spring-2026');
    expect(read('utm_content')).toBe('video');
    expect(read('utm_term')).toBe('venue');
    expect(read('match_type')).toBe('p');
    expect(read('campaign_id')).toBe('42');
    expect(read('ad_group_id')).toBe('43');
    expect(read('ad_id')).toBe('44');
    expect(read('click_id_meta')).toBe('yes');
    expect(read('click_id_google')).toBeNull();
    expect(read('click_id_microsoft')).toBeNull();
    expect(read('click_id_tiktok')).toBeNull();
    expect(read('click_id_linkedin')).toBeNull();
    expect(read('referrer_domain')).toBe('l.facebook.com');
    expect(read('landing_page')).toBe('https://www.example.com/offer/step-2');
    expect(read('form_page')).toBe('https://www.example.com/offer/step-2');
    expect(read('site')).toBe('www.example.com');
    expect(read('step')).toBe('/offer/step-2');
    expect(read('parameter', ' promo ')).toBe('VIP');
    expect(read('parameter', 'missing')).toBeNull();
    // As the server reads a parameter: trimmed, and not at all when empty, too long or
    // more than one line.
    const odd = trialFacts(
      preview,
      `https://www.example.com/?a=%20x%20&b=&c=${'y'.repeat(201)}&d=one%0Atwo&e=${'y'.repeat(200)}`,
    );
    expect(odd({ fact: 'parameter', name: 'a' })).toBe('x');
    expect(odd({ fact: 'parameter', name: 'b' })).toBeNull();
    expect(odd({ fact: 'parameter', name: 'c' })).toBeNull();
    expect(odd({ fact: 'parameter', name: 'd' })).toBeNull();
    expect(odd({ fact: 'parameter', name: 'e' })).toHaveLength(200);
    // Every fact of the vocabulary has a reading: none is forgotten when one is added.
    for (const fact of leadSourceFactNames)
      expect(() => factOf({ fact, name: 'promo' })).not.toThrow();
    const every = ['gclid', 'msclkid', 'ttclid', 'li_fat_id'] as const;
    const held = trialFacts({ ...preview, clickIds: [...every] }, address);
    for (const fact of [
      'click_id_google',
      'click_id_microsoft',
      'click_id_tiktok',
      'click_id_linkedin',
    ] as const)
      expect(held({ fact, name: '' })).toBe('yes');
  });

  it('says nothing of the page for something that is not an address', () => {
    const factOf = trialFacts(preview, 'not an address');
    expect(factOf({ fact: 'site', name: '' })).toBeNull();
    expect(factOf({ fact: 'step', name: '' })).toBeNull();
    expect(factOf({ fact: 'parameter', name: 'promo' })).toBeNull();
  });

  it('matches when every condition holds, without regard to case, and says which do not', () => {
    const matching = draft({
      conditions: [
        condition({ fact: 'utm_campaign', op: 'contains', value: 'spring' }),
        condition({ fact: 'lead_source', op: 'is', value: 'facebook_ads' }),
        condition({ fact: 'click_id_meta', op: 'is_not_empty' }),
        condition({ fact: 'parameter', name: 'promo', op: 'is_one_of', values: ['vip', 'gold'] }),
        condition({ fact: 'step', op: 'starts_with', value: '/offer' }),
      ],
    });
    expect(tryRule(matching, preview, address)).toEqual({
      holds: [true, true, true, true, true],
      matches: true,
    });
    const not = draft({
      conditions: [
        condition({ fact: 'utm_campaign', op: 'contains', value: 'spring' }),
        condition({ fact: 'lead_source', op: 'is', value: 'google_ads' }),
        condition({ fact: 'click_id_google', op: 'is_not_empty' }),
        condition({ fact: 'click_id_google', op: 'is_empty' }),
        condition({ fact: 'utm_source', op: 'is_not', value: 'google' }),
      ],
    });
    expect(tryRule(not, preview, address)).toEqual({
      holds: [true, false, false, true, true],
      matches: false,
    });
    // A rule with no condition matches nothing: the API takes none such either.
    expect(tryRule({ conditions: [] }, preview, address).matches).toBe(false);
  });

  it('holds the trial to the contract for every operator on a text fact', () => {
    const cases: readonly [LeadSourceCondition['op'], Partial<ConditionDraft>, boolean][] = [
      ['is', { value: 'SPRING-2026' }, true],
      ['is_not', { value: 'spring-2026' }, false],
      ['contains', { value: '2026' }, true],
      ['starts_with', { value: 'spring' }, true],
      ['is_empty', {}, false],
      ['is_not_empty', {}, true],
      ['is_one_of', { values: ['autumn', 'spring-2026'] }, true],
    ];
    expect(cases.map(([op]) => op).toSorted()).toEqual([...leadSourceOperators].toSorted());
    for (const [op, patch, expected] of cases)
      expect(
        tryRule(
          { conditions: [condition({ fact: 'utm_campaign', op, ...patch })] },
          preview,
          address,
        ).matches,
        op,
      ).toBe(expected);
  });
});
