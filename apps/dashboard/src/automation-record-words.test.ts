// The words around the record steps: what a card says of Assign owner, Update contact,
// Find opportunity and Update opportunity; "contains" for text where a list "includes";
// which settings are still to fill in; and where a problem with one field is said.
import { i18n } from '@lingui/core';
import { automationStepTypes, validateAutomation } from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { recordSetup, welcome } from '../e2e/automation-fixtures';
import { publishChanges } from './automation-changes';
import {
  cleanConfig,
  configProblems,
  DEAL_CHANGE_KEYS,
  DEAL_FILTER_KEYS,
  fieldsOf,
  missingFields,
  settingWords,
} from './automation-fields';
import { dealChangeMembers, dealFilterKinds } from './automation-record-rules';
import { outputWords } from './automation-run-words';
import { problemsAt } from './automation-step-problems';
import {
  branchLabel,
  conditionWords,
  holdsText,
  stepLabel,
  stepSummary,
} from './automation-summary';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const says = (type: string, config: Record<string, unknown>): string | undefined =>
  stepSummary({ type, config }, recordSetup);

describe('what a card says of Assign owner', () => {
  it('names one member, counts several who take turns, and says when only the unassigned', () => {
    expect(says('owner.assign', { user: 'usr_chris' })).toBe('Assign to Chris Marino');
    expect(says('owner.assign', { users: ['usr_chris'] })).toBe('Assign to Chris Marino');
    expect(says('owner.assign', { users: ['usr_chris', 'usr_dana', 'usr_sam'] })).toBe(
      'Assign in turn to 3 people',
    );
    expect(says('owner.assign', { user: 'usr_chris', onlyIfUnassigned: true })).toBe(
      'Assign to Chris Marino, only when unassigned',
    );
    expect(says('owner.assign', { users: ['usr_chris', 'usr_dana'], onlyIfUnassigned: true })).toBe(
      'Assign in turn to 2 people, only when unassigned',
    );
    expect(says('owner.assign', { onlyIfUnassigned: true })).toBeUndefined();
    expect(says('owner.assign', { user: 'usr_chris', onlyIfUnassigned: false })).toBe(
      'Assign to Chris Marino',
    );
  });
});

describe('what a card says of Update contact', () => {
  it.each([
    [{ 'contact.firstName': 'Sam' }, 'On the contact: set first name to “Sam”'],
    [{ 'contact.custom.budget': null }, 'On the contact: clear budget'],
    [
      { 'contact.custom.lead_source_raw': '{{contact.custom.utm_source}}' },
      'On the contact: copy utm source to lead source raw',
    ],
    [
      { 'contact.custom.lead_source_raw': 'Ad: {{contact.custom.utm_source}}' },
      'On the contact: set lead source raw to “Ad: {{contact.custom.utm_source}}”',
    ],
    [{ 'contact.custom.first_enquiry': { op: 'now' } }, 'On the contact: set first enquiry to now'],
    [
      { 'contact.custom.first_enquiry': { set: { op: 'now' }, onlyIfEmpty: true } },
      'On the contact: set first enquiry to now, only if empty',
    ],
    [
      { 'contact.custom.event_date': { op: 'date_add', days: 365 } },
      'On the contact: set event date to 365 days after now',
    ],
    [
      { 'contact.custom.event_date': { op: 'date_add', value: '2026-12-01', days: 1 } },
      'On the contact: set event date to 1 day after 2026-12-01',
    ],
    [
      {
        'contact.custom.first_enquiry': {
          op: 'date_add',
          field: 'contact.custom.event_date',
          days: -2,
        },
      },
      'On the contact: set first enquiry to 2 days before event date',
    ],
    [
      { 'contact.custom.event_date': { op: 'date_add' } },
      'On the contact: set event date to 0 days after now',
    ],
    [
      {
        'contact.custom.visits': {
          op: 'math',
          left: 'contact.custom.visits',
          operator: '+',
          right: 1,
        },
      },
      'On the contact: set visits to visits + 1',
    ],
    [{ 'contact.custom.visits': { op: 'power' } }, 'On the contact: set visits'],
    [
      {
        'contact.firstName': { set: 'Sam' },
        'contact.lastName': { set: null, onlyIfEmpty: false },
      },
      'On the contact: set first name to “Sam” and clear last name',
    ],
  ])('reads %j', (fields, summary) => {
    expect(says('contact.update', { fields })).toBe(summary);
  });

  it('reads as not set up with no field', () => {
    expect(says('contact.update', { fields: {} })).toBeUndefined();
    expect(says('contact.update', {})).toBeUndefined();
  });
});

describe('what a card says of the opportunity steps', () => {
  it('says which opportunity is found, with every filter', () => {
    expect(stepLabel('deal.find')).toBe('Find opportunity');
    expect(stepLabel('deal.update')).toBe('Update opportunity');
    expect(says('deal.find', {})).toBe('Find their most recent opportunity');
    expect(says('deal.find', { which: 'oldest', status: 'any' })).toBe(
      'Find their oldest opportunity',
    );
    expect(
      says('deal.find', {
        pipeline: 'pip_sales',
        stage: 'stg_quoted',
        status: 'open',
        nameContains: 'Wedding',
        value: { operator: 'greater_than', value: 1000 },
        customField: { field: 'deal.custom.service', equals: 'video' },
      }),
    ).toBe(
      'Find their most recent opportunity: in Sales, at Quoted, open, named like “Wedding”, worth more than 1000, whose opportunity service is “video”',
    );
    expect(says('deal.find', { status: 'won', value: { operator: 'less_than', value: 5 } })).toBe(
      'Find their most recent opportunity: won, worth less than 5',
    );
    expect(says('deal.find', { status: 'lost', value: { operator: 'equals', value: 5 } })).toBe(
      'Find their most recent opportunity: lost, worth 5',
    );
  });

  it('names its two branches as the canvas labels them', () => {
    const step = { type: 'deal.find', config: {} };
    expect(branchLabel(step, 'found')).toBe('Found');
    expect(branchLabel(step, 'not_found')).toBe('Not found');
  });

  it('says what is changed on the opportunity, or that it is reopened', () => {
    expect(says('deal.update', {})).toBeUndefined();
    expect(says('deal.update', { status: 'open' })).toBe('Reopen the opportunity');
    expect(says('deal.update', { name: 'Renewal', amountFrom: 'contact.custom.budget' })).toBe(
      'On the opportunity: set name and value',
    );
    expect(
      says('deal.update', {
        owner: null,
        expectedCloseDate: { in: 'P30D' },
        source: 'Referral',
        fields: { 'deal.custom.service': 'video' },
      }),
    ).toBe('On the opportunity: set owner, expected close date, source, and service');
    expect(says('deal.update', { status: 'open', amount: 5 })).toBe(
      'Reopen the opportunity and set its value',
    );
  });

  it('says of a result which opportunity it is: found, changed or made', () => {
    expect(outputWords({ dealId: 'deal_1' }, 'deal.find')).toEqual(['It found an opportunity.']);
    expect(outputWords({ dealId: 'deal_1' }, 'deal.update')).toEqual([
      'It changed the opportunity.',
    ]);
    expect(outputWords({ dealId: 'deal_1' }, 'deal.create')).toEqual([
      'It created an opportunity.',
    ]);
    expect(outputWords({ dealId: 'deal_1' }, null)).toEqual(['It created an opportunity.']);
  });

  it('says a wait a person ended early was ended, not when it would have ended', () => {
    const words = outputWords({
      wakeAt: '2026-10-11T09:00:00.000Z',
      continuedAt: '2026-10-09T08:00:00.000Z',
      continuedBy: 'Jane Doe',
    });
    expect(words).toHaveLength(1);
    expect(words[0]).toMatch(/^A person ended its wait early, Oct 9, 2026, .+\.$/);
    expect(outputWords({ continuedAt: 'never', wakeAt: 'never' })).toEqual([]);
  });
});

describe('"contains" for text, "includes" for a list', () => {
  it('knows which fields hold text', () => {
    for (const path of [
      'contact.firstName',
      'contact.email',
      'contact.source',
      'deal.name',
      'deal.stage',
      'deal.source',
    ])
      expect([path, holdsText(path)]).toEqual([path, true]);
    for (const path of [
      'contact.tags',
      'contact.createdAt',
      'deal.value',
      'company.name',
      'contact',
      7,
      undefined,
    ])
      expect([path, holdsText(path)]).toEqual([path, false]);
    // A custom field is text when the business's own fields say so.
    expect(holdsText('contact.custom.utm_source')).toBe(false);
    expect(holdsText('contact.custom.utm_source', recordSetup)).toBe(true);
    expect(holdsText('contact.utm_source', recordSetup)).toBe(true);
    expect(holdsText('contact.custom.notes', recordSetup)).toBe(true);
    expect(holdsText('deal.custom.service', recordSetup)).toBe(true);
    expect(holdsText('contact.custom.services', recordSetup)).toBe(false);
    expect(holdsText('contact.custom.budget', recordSetup)).toBe(false);
    expect(holdsText('contact.other.utm_source', recordSetup)).toBe(false);
  });

  it('words the same stored operator by what the field holds', () => {
    const on = (field: string, operator = 'includes') => ({ field, operator, value: 'Video' });
    expect(conditionWords(on('deal.name'))).toBe('opportunity name contains “Video”');
    expect(conditionWords(on('deal.name', 'excludes'))).toBe(
      "opportunity name doesn't contain “Video”",
    );
    expect(conditionWords(on('contact.tags'))).toBe('tags includes “Video”');
    expect(conditionWords(on('contact.custom.services'), false, recordSetup)).toBe(
      'services includes “Video”',
    );
    expect(conditionWords(on('contact.custom.utm_source'))).toBe('utm source includes “Video”');
    expect(conditionWords(on('contact.custom.utm_source'), false, recordSetup)).toBe(
      'utm source contains “Video”',
    );
    expect(
      conditionWords(
        { any: [on('contact.custom.utm_source'), { not: on('deal.source') }] },
        false,
        recordSetup,
      ),
    ).toBe('utm source contains “Video” or not opportunity source contains “Video”');
    // The step's own card, the trigger's and a setting's words all read the business's fields.
    expect(says('condition', { if: on('contact.custom.utm_source') })).toBe(
      'If utm source contains “Video”',
    );
    const [waitFor] = fieldsOf('step', 'wait.condition') ?? [];
    if (waitFor === undefined) throw new Error('The condition a wait is for.');
    expect(settingWords(waitFor, on('contact.custom.utm_source'), recordSetup)).toBe(
      'utm source contains “Video”',
    );
  });
});

describe('what publishing would change, for the record steps', () => {
  const draftOf = (steps: Record<string, unknown>) => ({ ...welcome, start: 'one', steps });
  const changed = (type: string, before: Record<string, unknown>, after: Record<string, unknown>) =>
    publishChanges(
      draftOf({ one: { type, config: before } }),
      draftOf({ one: { type, config: after } }),
      recordSetup,
    ).flatMap((change) => change.details);

  it('reads as the cards do, not as JSON', () => {
    expect(
      changed(
        'owner.assign',
        { user: 'usr_dana' },
        { users: ['usr_dana', 'usr_sam'], onlyIfUnassigned: true },
      ),
    ).toEqual([
      {
        label: 'Assign to',
        before: 'Assign to Dana Brooks',
        after: 'Assign in turn to 2 people, only when unassigned',
      },
    ]);
    expect(changed('deal.find', {}, { status: 'won' })).toEqual([
      { label: 'Filters', before: undefined, after: 'Find their most recent opportunity: won' },
    ]);
    expect(changed('deal.update', { name: 'Renewal' }, { name: 'Renewal', owner: null })).toEqual([
      {
        label: 'Fields to change',
        before: 'On the opportunity: set name',
        after: 'On the opportunity: set name and owner',
      },
    ]);
    expect(
      changed(
        'contact.update',
        { fields: { 'contact.firstName': 'Sam' } },
        { fields: { 'contact.firstName': null } },
      ),
    ).toEqual([
      {
        label: 'Fields to set',
        before: 'On the contact: set first name to “Sam”',
        after: 'On the contact: clear first name',
      },
    ]);
    // With nothing a card can say, what the settings hold is shown as it is.
    expect(
      changed('contact.update', { fields: { 'contact.firstName': 'Sam' } }, { fields: {} })[0]
        ?.after,
    ).toBe('{}');
    expect(
      changed('owner.assign', { user: 'usr_dana' }, { onlyIfUnassigned: true })[0]?.after,
    ).toBe('{"onlyIfUnassigned":true}');
  });
});

describe('the settings of the record steps', () => {
  it('stand for exactly the members the rules write', () => {
    expect([...DEAL_FILTER_KEYS]).toEqual([...dealFilterKinds]);
    expect([...DEAL_CHANGE_KEYS].toSorted()).toEqual(
      [...Object.values(dealChangeMembers).flat(), 'fields'].toSorted(),
    );
  });

  it('ask for a member, and for something to change, only while there is none', () => {
    expect(missingFields('step', 'owner.assign', {})).toEqual(['user']);
    expect(missingFields('step', 'owner.assign', { onlyIfUnassigned: true })).toEqual(['user']);
    expect(missingFields('step', 'owner.assign', { users: [] })).toEqual(['user']);
    expect(missingFields('step', 'owner.assign', { user: '' })).toEqual(['user']);
    expect(missingFields('step', 'owner.assign', { users: ['usr_chris', 'usr_dana'] })).toEqual([]);
    expect(missingFields('step', 'owner.assign', { user: 'usr_chris' })).toEqual([]);
    expect(missingFields('step', 'deal.update', {})).toEqual(['name']);
    expect(missingFields('step', 'deal.update', { owner: null })).toEqual([]);
    expect(
      missingFields('step', 'deal.update', { fields: { 'deal.custom.service': 'x' } }),
    ).toEqual([]);
    expect(missingFields('step', 'deal.find', {})).toEqual([]);
    // An Update contact step that sets no field does nothing: it asks for one.
    expect(missingFields('step', 'contact.update', { fields: {} })).toEqual(['fields']);
    expect(missingFields('step', 'contact.update', {})).toEqual(['fields']);
    expect(
      missingFields('step', 'contact.update', { fields: { 'contact.firstName': '' } }),
    ).toEqual([]);
  });

  it('keep a value set to nothing when the settings are cleaned', () => {
    expect(cleanConfig('step', 'deal.update', { amount: null, owner: null, name: '' })).toEqual({
      amount: null,
      owner: null,
    });
  });

  it("put the contract's refusal of one field under that field, and of the rest under their member", () => {
    expect(
      configProblems('step', 'contact.update', {
        fields: { 'contact.firstName': 'Sam', 'contact.custom.event_date': { op: 'date_add' } },
      }),
    ).toEqual({ 'fields/contact.custom.event_date': expect.any(String) as string });
    expect(Object.keys(configProblems('step', 'contact.update', { fields: 'x' }))).toEqual([
      'fields',
    ]);
    expect(Object.keys(configProblems('step', 'deal.update', { amount: -1 }))).toEqual(['amount']);
    expect(
      Object.keys(configProblems('step', 'deal.update', { fields: { 'deal.custom.a': ['x'] } })),
    ).toEqual(['fields/deal.custom.a']);
    expect(
      Object.keys(
        configProblems('step', 'owner.assign', { users: ['a'], onlyIfUnassigned: 'yes' }),
      ),
    ).toEqual(['onlyIfUnassigned']);
  });

  it("sort the server's checks the same way: by the field a problem is about", () => {
    const draft = {
      ...welcome,
      start: 'set',
      steps: {
        set: {
          type: 'contact.update',
          config: {
            fields: {
              'contact.custom.budget': { op: 'now' },
              'contact.custom.visits': {
                op: 'math',
                left: 'contact.firstName',
                operator: '/',
                right: 0,
              },
              'contact.firstName': 'Sam',
            },
          },
          next: 'team',
        },
        team: { type: 'owner.assign', config: { users: ['usr_chris', 'usr_chris'] } },
      },
    };
    expect(
      automationStepTypes['contact.update'].config.safeParse(draft.steps.set.config).success,
    ).toBe(true);
    const found = validateAutomation(draft, recordSetup).errors.map((issue) => ({
      ...issue,
      level: 'error',
    }));
    expect(found.map((issue) => issue.code).toSorted()).toEqual([
      'division_by_zero',
      'duplicate_member',
      'wrong_field_type',
      'wrong_field_type',
    ]);
    const problems = problemsAt(found, 'set');
    expect(Object.keys(problems).toSorted()).toEqual([
      'fields/contact.custom.budget',
      'fields/contact.custom.visits',
    ]);
    expect(problems['fields/contact.custom.budget']).toMatch(/isn't a date field/);
    expect(Object.keys(problemsAt(found, 'team'))).toEqual(['users']);
    // A problem with the fields as a whole is said under them.
    expect(
      problemsAt(
        [{ level: 'error', path: '/steps/set/config/fields', message: 'Not an object.' }],
        'set',
      ),
    ).toEqual({ fields: 'Not an object.' });
  });
});
