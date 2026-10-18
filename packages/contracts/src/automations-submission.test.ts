// What a workflow reads of the form submission that started a run: trigger.answers.<key>
// and trigger.pageUrl, as the validator checks them against the form a trigger names.
import { describe, expect, it } from 'vitest';

import { automationCatalog } from './automations.js';
import { automationSetup } from './automations-api.js';
import {
  isSubmissionPath,
  SUBMISSION_PAGE_PATH,
  submissionAnswerKey,
  submissionAnswerPath,
  submissionQuestions,
  submissionTriggers,
} from './automations-submission.js';
import { validateAutomation, type AutomationSetup } from './automations-validate.js';
import { formFieldTypes } from './forms.js';

const setup: AutomationSetup = {
  fields: { contact: [{ key: 'budget', aliases: [], type: 'text', options: [] }], deal: [] },
  forms: [
    {
      id: 'form_enquiry',
      name: 'Enquiry',
      questions: [
        { key: 'email', label: 'Email', type: 'email', options: [] },
        { key: 'guests', label: 'Guests', type: 'number', options: [] },
        {
          key: 'plan',
          label: 'Plan',
          type: 'single_choice',
          options: [
            { key: 'gold', label: 'Gold' },
            { key: 'silver', label: 'Silver' },
          ],
        },
        { key: 'campaign', label: 'Campaign', type: 'text', options: [] },
        { key: 'shared', label: 'Shared', type: 'number', options: [] },
      ],
    },
    {
      id: 'form_callback',
      name: 'Callback',
      questions: [
        { key: 'phone', label: 'Phone', type: 'phone', options: [] },
        { key: 'shared', label: 'Shared', type: 'text', options: [] },
      ],
    },
    // From a server that does not say what a form asks.
    { id: 'form_old', name: 'Old' },
  ],
  emailTemplates: [],
  whatsappTemplates: [],
  mailboxes: [],
  phoneNumbers: [],
  calendars: [],
  pipelines: [],
  lostReasons: [],
  tags: [{ id: 'tag_vip', name: 'VIP' }],
  users: [],
  automations: [],
  values: [],
  channels: { email: true, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const sent = (form?: string) => ({
  id: `sent_${form ?? 'any'}`.toLowerCase(),
  type: 'form.submitted',
  config: form === undefined ? {} : { form },
});

const reading = (condition: unknown, triggers: readonly unknown[] = [sent('Enquiry')]) =>
  validateAutomation(
    {
      name: 'Leads',
      triggers,
      start: 'check',
      steps: {
        check: { type: 'condition', config: { if: condition }, next: { yes: 'tagged' } },
        tagged: { type: 'tag.add', config: { tag: 'VIP' } },
      },
    },
    setup,
  );

const codes = (result: ReturnType<typeof validateAutomation>) =>
  result.errors.map((issue) => issue.code);

describe('the paths of a submission', () => {
  it('are the page, and an answer by its question’s key', () => {
    expect(SUBMISSION_PAGE_PATH).toBe('trigger.pageUrl');
    expect(submissionAnswerPath('budget')).toBe('trigger.answers.budget');
    expect(submissionAnswerKey('trigger.answers.budget')).toBe('budget');
    expect(submissionAnswerKey('trigger.pageUrl')).toBeUndefined();
    expect(submissionAnswerKey('contact.custom.budget')).toBeUndefined();
    for (const path of ['trigger.pageUrl', 'trigger.answers.budget', 'trigger.answers.'])
      expect(isSubmissionPath(path), path).toBe(true);
    for (const path of ['trigger.attribution.source', 'trigger.submissionId', 'contact.email'])
      expect(isSubmissionPath(path), path).toBe(false);
    expect(submissionTriggers).toEqual(['form.submitted']);
  });

  it('are published in the catalog, with the questions of each form in the setup', () => {
    expect(automationCatalog().submission).toEqual({
      page: 'trigger.pageUrl',
      answers: 'trigger.answers.',
      triggers: ['form.submitted'],
    });
    expect(automationSetup.safeParse(setup).success).toBe(true);
    // A server from before this lists a form by name alone.
    expect(
      automationSetup.safeParse({ ...setup, forms: [{ id: 'form_a', name: 'A' }] }).success,
    ).toBe(true);
  });

  it('reads each kind of question as a kind of field, and leaves out what has no answer', () => {
    const fields = formFieldTypes.map((type) => ({
      key: type,
      type,
      label: type,
      options: [{ key: 'a', label: 'A' }],
    }));
    expect(submissionQuestions(fields).map((question) => [question.key, question.type])).toEqual([
      ['text', 'text'],
      ['long_text', 'long_text'],
      ['email', 'email'],
      ['phone', 'phone'],
      ['number', 'number'],
      ['date', 'date'],
      ['single_choice', 'single_choice'],
      ['checkbox', 'boolean'],
      ['multi_choice', 'multi_choice'],
      ['url', 'url'],
      ['rating', 'number'],
      ['hidden', 'text'],
    ]);
    // Only a choice question has choices.
    expect(
      submissionQuestions(fields)
        .filter((question) => question.options.length > 0)
        .map((question) => question.key),
    ).toEqual(['single_choice', 'multi_choice']);
    expect(submissionQuestions([{ key: 'plan', type: 'single_choice', label: 'Plan' }])).toEqual([
      { key: 'plan', label: 'Plan', type: 'single_choice', options: [] },
    ]);
  });
});

describe('a condition on what a form sent', () => {
  it('takes a question of the form the trigger names, by its kind', () => {
    for (const condition of [
      { field: 'trigger.answers.campaign', operator: 'includes', value: 'spring' },
      { field: 'trigger.answers.guests', operator: 'greater_than', value: 50 },
      { field: 'trigger.answers.plan', operator: 'equals', value: 'gold' },
      { field: 'trigger.answers.email', operator: 'is_set' },
      { field: 'trigger.pageUrl', operator: 'includes', value: '/open-day' },
    ]) {
      const result = reading(condition);
      expect([condition.field, result.errors, result.warnings]).toEqual([condition.field, [], []]);
    }
  });

  it('refuses a key the form does not ask, and says the one that was meant', () => {
    const result = reading({ field: 'trigger.answers.guest', operator: 'is_set' });
    expect(codes(result)).toEqual(['unknown_field']);
    expect(result.errors[0]).toMatchObject({
      message: 'trigger.answers.guest is not a question of Enquiry.',
      suggestion: 'Did you mean trigger.answers.guests?',
    });
    // Another form's question is not this form's.
    expect(codes(reading({ field: 'trigger.answers.phone', operator: 'is_set' }))).toEqual([
      'unknown_field',
    ]);
    // With both forms named, each one's questions are taken.
    const both = [sent('Enquiry'), sent('form_callback')];
    for (const key of ['phone', 'guests'])
      expect(
        reading({ field: `trigger.answers.${key}`, operator: 'is_set' }, both).errors,
        key,
      ).toEqual([]);
    expect(
      reading({ field: 'trigger.answers.nothing', operator: 'is_set' }, both).errors[0]?.message,
    ).toBe('trigger.answers.nothing is not a question of Enquiry or Callback.');
    // What is no key at all.
    for (const field of ['trigger.answers.Budget', 'trigger.answers.a.b'])
      expect(codes(reading({ field, operator: 'is_set' })), field).toEqual(['unknown_field']);
    expect(codes(reading({ field: 'trigger.page', operator: 'is_set' }))).toEqual([
      'unknown_field',
    ]);
  });

  it('reads a key two forms ask in two ways as text', () => {
    const both = [sent('Enquiry'), sent('Callback')];
    expect(
      reading({ field: 'trigger.answers.shared', operator: 'includes', value: 'a' }, both).errors,
    ).toEqual([]);
    // As a number it is one form's only.
    expect(
      reading({ field: 'trigger.answers.shared', operator: 'greater_than', value: 5 }).errors,
    ).toEqual([]);
  });

  it('takes any key as text when the trigger starts for any form, or the form is not known', () => {
    for (const triggers of [[sent()], [sent('Enquiry'), sent()], [sent('Old')]]) {
      const result = reading(
        { field: 'trigger.answers.anything_at_all', operator: 'includes', value: 'x' },
        triggers,
      );
      expect([result.errors, result.warnings]).toEqual([[], []]);
    }
  });

  it('warns where no trigger is a form submission: the answers are always empty', () => {
    const result = reading({ field: 'trigger.answers.plan', operator: 'is_set' }, [
      { id: 'made', type: 'contact.created', config: {} },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((issue) => [issue.path, issue.code])).toEqual([
      ['/steps/check/config/if/field', 'no_submission'],
    ]);
  });
});

describe('everything else that names a field', () => {
  const withSteps = (
    steps: Record<string, unknown>,
    triggers: readonly unknown[] = [sent('Enquiry')],
  ) => validateAutomation({ name: 'Leads', triggers, start: Object.keys(steps)[0], steps }, setup);

  it('fills an answer and the page into text, and refuses an answer the form does not ask', () => {
    const note = (body: string) =>
      withSteps({ noted: { type: 'note.create', config: { text: body } } });
    expect(
      note(
        'Asked for {{trigger.answers.plan}} for {{ trigger.answers.guests }} on {{trigger.pageUrl}}',
      ).errors,
    ).toEqual([]);
    const wrong = note('Asked for {{trigger.answers.plans}}');
    expect(codes(wrong)).toEqual(['unknown_merge_field']);
    expect(wrong.errors[0]?.suggestion).toBe('Did you mean trigger.answers.plan?');
    // The trigger's own outputs are still what they were.
    expect(note('Submission {{trigger.submissionId}}').errors).toEqual([]);
    expect(codes(note('{{trigger.nothing}}'))).toEqual(['unknown_merge_field']);
  });

  it('reads them in a trigger’s own condition', () => {
    const result = withSteps({ tagged: { type: 'tag.add', config: { tag: 'VIP' } } }, [
      {
        ...sent('Enquiry'),
        if: { field: 'trigger.answers.plan', operator: 'equals', value: 'gold' },
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  it('never writes one, and watches none', () => {
    const written = withSteps({
      set: {
        type: 'contact.update',
        config: { fields: { 'trigger.answers.plan': 'gold' } },
      },
    });
    expect(written.valid).toBe(false);
    for (const field of ['trigger.answers.plan', 'trigger.pageUrl']) {
      const watched = withSteps({ tagged: { type: 'tag.add', config: { tag: 'VIP' } } }, [
        sent('Enquiry'),
        { id: 'changed', type: 'field.changed', config: { field } },
      ]);
      expect(
        watched.errors.map((issue) => [issue.code, issue.message]),
        field,
      ).toEqual([
        ['wrong_field', `${field} is part of a form submission, which this trigger can't watch.`],
      ]);
    }
  });
});
