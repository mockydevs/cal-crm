// What a trigger's compact filter editor works out: which source filters show, the answers
// a form's workflow can read, and what a named form is.
import { i18n } from '@lingui/core';
import { validateAutomation, type AutomationSetup } from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { harborSetup } from '../e2e/automation-fixtures';
import { filterFields } from './automation-filters';
import { sourceFields } from './automation-record-rules';
import {
  addableCompactFilters,
  formOptions,
  formState,
  formStateWords,
  isCompactFilter,
  isFilterSet,
  shownCompactFilters,
} from './automation-trigger-filters';
import { answerFields, answerRow, formsNamed, submissionScope } from './automation-submission';

it('starts a filter on an answer with the first comparison its kind takes', () => {
  const row = (type: 'text' | 'multi_choice' | 'date' | 'number') =>
    answerRow({ path: 'trigger.answers.x', type }).operator;
  expect([row('text'), row('number'), row('multi_choice'), row('date')]).toEqual([
    'equals',
    'equals',
    'includes',
    'before',
  ]);
});

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const forms: AutomationSetup['forms'] = [
  {
    id: 'form_enquiry',
    name: 'Event enquiry',
    questions: [
      {
        key: 'service_interest',
        label: 'Service interest',
        type: 'single_choice',
        options: [
          { key: 'dj', label: 'DJ' },
          { key: 'photo', label: 'Photo booth' },
        ],
      },
      { key: 'guests', label: 'Guests', type: 'number', options: [] },
      { key: 'notes', label: '  ', type: 'long_text', options: [] },
    ],
  },
  {
    id: 'form_callback',
    name: 'Callback',
    questions: [
      {
        key: 'service_interest',
        label: 'What for?',
        type: 'single_choice',
        options: [{ key: 'lights', label: 'Lighting' }],
      },
      { key: 'guests', label: 'How many?', type: 'text', options: [] },
    ],
  },
  { id: 'form_old', name: 'Old form' },
];
const keys = ['form', 'sources', 'sessionSources'];

describe('the source filters of a trigger', () => {
  it('shows only those that hold something, or were just added', () => {
    expect(isCompactFilter('sources')).toBe(true);
    expect(isCompactFilter('form')).toBe(false);
    expect(isFilterSet(['Google Ads'])).toBe(true);
    expect(isFilterSet([])).toBe(false);
    expect(isFilterSet(undefined)).toBe(false);
    // The default: any source. Nothing is shown, and nothing narrows the trigger.
    expect(shownCompactFilters(keys, { form: 'form_enquiry' }, [])).toEqual([]);
    // A workflow saved with a source filter opens with it in sight: it is never dropped.
    expect(shownCompactFilters(keys, { sources: ['Google Ads'] }, [])).toEqual(['sources']);
    expect(shownCompactFilters(keys, { sessionSources: ['paid_search'] }, ['sources'])).toEqual([
      'sources',
      'sessionSources',
    ]);
  });

  it('offers in the menu what is not shown yet', () => {
    expect(addableCompactFilters(keys, [])).toEqual(['sources', 'sessionSources']);
    expect(addableCompactFilters(keys, ['sources'])).toEqual(['sessionSources']);
    expect(addableCompactFilters(['channel'], [])).toEqual([]);
  });
});

describe('the answers of the form a workflow starts from', () => {
  it('has none when no trigger is a form submission', () => {
    expect(submissionScope(forms, [])).toBeUndefined();
    expect(answerFields(undefined)).toEqual([]);
    expect(
      formsNamed([
        { type: 'contact.created', config: {} },
        { type: 'form.submitted', config: { form: 'form_enquiry' } },
        { type: 'form.submitted', config: {} },
      ]),
    ).toEqual(['form_enquiry', undefined]);
  });

  it('types each answer by its question when one form is named, by id or by name', () => {
    const scope = submissionScope(forms, ['Event enquiry']);
    expect(scope?.form).toBe('Event enquiry');
    expect(answerFields(scope)).toEqual([
      {
        path: 'trigger.answers.service_interest',
        label: 'Service interest',
        type: 'single_choice',
        options: [
          { key: 'dj', label: 'DJ' },
          { key: 'photo', label: 'Photo booth' },
        ],
        heading: 'Answers to Event enquiry',
      },
      {
        path: 'trigger.answers.guests',
        label: 'Guests',
        type: 'number',
        options: [],
        heading: 'Answers to Event enquiry',
      },
      // A question with no words of its own is called by its key.
      {
        path: 'trigger.answers.notes',
        label: 'notes',
        type: 'long_text',
        options: [],
        heading: 'Answers to Event enquiry',
      },
      {
        path: 'trigger.pageUrl',
        label: 'Page the form was sent from',
        type: 'text',
        options: [],
        heading: 'Answers to Event enquiry',
      },
    ]);
  });

  it('joins the choices of a key two named forms ask alike, and reads as text one they ask two ways', () => {
    const scope = submissionScope(forms, ['form_enquiry', 'form_callback']);
    expect(scope?.form).toBeUndefined();
    const fields = answerFields(scope);
    expect(fields[0]).toMatchObject({
      path: 'trigger.answers.service_interest',
      type: 'single_choice',
      options: [
        { key: 'dj', label: 'DJ' },
        { key: 'photo', label: 'Photo booth' },
        { key: 'lights', label: 'Lighting' },
      ],
      heading: 'Form answers',
    });
    expect(fields[1]).toMatchObject({ path: 'trigger.answers.guests', type: 'text', options: [] });
  });

  it('offers every form’s questions as text when a trigger starts for any form, or one it cannot read', () => {
    for (const named of [[undefined], ['form_enquiry', undefined], ['form_old'], ['form_gone']]) {
      const fields = answerFields(submissionScope(forms, named));
      expect(fields.map((field) => [field.path, field.type, field.options.length])).toEqual([
        ['trigger.answers.service_interest', 'text', 0],
        ['trigger.answers.guests', 'text', 0],
        ['trigger.answers.notes', 'text', 0],
        ['trigger.pageUrl', 'text', 0],
      ]);
    }
  });

  it('lists them where a filter and a message choose a field, and the validator accepts each', () => {
    const setup = {
      ...harborSetup,
      forms,
      answers: answerFields(submissionScope(forms, ['form_enquiry'])),
    };
    const filters = filterFields(setup).filter((field) => field.group === 'submission');
    expect(filters.map((field) => field.path)).toEqual([
      'trigger.answers.service_interest',
      'trigger.answers.guests',
      'trigger.answers.notes',
      'trigger.pageUrl',
    ]);
    // Right after the contact's own fields, so its heading claims no field of the contact.
    const all = filterFields(setup);
    expect(all[all.findIndex((field) => field.group === 'submission') - 1]?.group).toBe('standard');
    expect(filterFields(harborSetup).some((field) => field.group === 'submission')).toBe(false);
    // In text, as merge fields; never as a value an Update contact step copies from.
    expect(sourceFields(setup, true).filter((field) => field.group === 'submission')).toHaveLength(
      4,
    );
    expect(sourceFields(setup).some((field) => field.group === 'submission')).toBe(false);

    const result = validateAutomation(
      {
        name: 'DJ enquiries',
        triggers: [
          {
            id: 'enquiry',
            type: 'form.submitted',
            config: { form: 'form_enquiry' },
            if: { field: filters[0]?.path, operator: 'equals', value: 'dj' },
          },
        ],
        start: 'thanks',
        steps: {
          thanks: {
            type: 'sms.send',
            config: { message: 'Thanks for asking about {{trigger.answers.service_interest}}.' },
          },
        },
      },
      { ...harborSetup, forms },
    );
    expect(result.errors).toEqual([]);
  });
});

describe('the form a trigger names', () => {
  const published = [{ id: 'form_enquiry', name: 'Event enquiry' }];
  const records = [
    { id: 'form_enquiry', name: 'Event enquiry', status: 'published' as const },
    { id: 'form_wedding', name: 'Wedding demo', status: 'draft' as const },
    { id: 'form_2019', name: 'Open day 2019', status: 'archived' as const },
  ];

  it('is any form when none is named', () => {
    expect(formState(undefined, published, records)).toEqual({ kind: 'any' });
    expect(formState('', published, undefined)).toEqual({ kind: 'any' });
    expect(formStateWords({ kind: 'any' })).toBeUndefined();
  });

  it('is a published form by id or by name, with nothing to say', () => {
    const state = formState(' event ENQUIRY ', published, undefined);
    expect(state).toEqual({ kind: 'published', id: 'form_enquiry', name: 'Event enquiry' });
    expect(formStateWords(state)).toBeUndefined();
  });

  it('is a draft by its name, said as one: never "not found"', () => {
    const state = formState('form_wedding', published, records);
    expect(state).toEqual({ kind: 'draft', id: 'form_wedding', name: 'Wedding demo' });
    expect(formStateWords(state)).toBe('This form is a draft. Publish it to receive submissions.');
  });

  it('tells an archived form from one that is gone, and says nothing while it is still reading', () => {
    expect(formState('form_2019', published, records)).toMatchObject({ kind: 'archived' });
    expect(formStateWords(formState('form_2019', published, records))).toBe(
      'This form is archived. Restore and publish it to receive submissions.',
    );
    const gone = formState('form_other_business', published, records);
    expect(gone).toEqual({ kind: 'missing', written: 'form_other_business' });
    expect(formStateWords(gone)).toBe(
      'This business has no form with this name or ID. Choose another form.',
    );
    const checking = formState('form_wedding', published, undefined);
    expect(checking).toEqual({ kind: 'checking', written: 'form_wedding' });
    expect(formStateWords(checking)).toBeUndefined();
  });

  it('offers the published forms, then the drafts with their mark; never an archived one', () => {
    expect(formOptions(published, records)).toEqual([
      { id: 'form_enquiry', name: 'Event enquiry', mark: undefined },
      { id: 'form_wedding', name: 'Wedding demo', mark: 'Draft' },
    ]);
    expect(formOptions(published, undefined)).toEqual([
      { id: 'form_enquiry', name: 'Event enquiry', mark: undefined },
    ]);
  });
});
