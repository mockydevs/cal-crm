// Computed and copied values in contact.update: merge text as a value, now, a date moved by
// days, arithmetic, and "only when empty". Shape and validation; what each comes to is
// tested in packages/modules/automation.
import { describe, expect, it } from 'vitest';

import { automationStepTypes } from './automations-catalog.js';
import { automationCatalog, automationDocument } from './automations.js';
import {
  automationComputedValue,
  automationFieldWrite,
  MAX_DATE_ADD_DAYS,
} from './automations-field-writes.js';
import { validateAutomation, type AutomationSetup } from './automations-validate.js';

const setup: AutomationSetup = {
  fields: {
    contact: [
      { key: 'utm_source', aliases: ['utm'], type: 'text', options: [] },
      { key: 'lead_source_raw', aliases: [], type: 'text', options: [] },
      { key: 'budget', aliases: [], type: 'number', options: [] },
      { key: 'visits', aliases: [], type: 'number', options: [] },
      { key: 'event_date', aliases: [], type: 'date', options: [] },
      { key: 'first_enquiry', aliases: [], type: 'datetime', options: [] },
      {
        key: 'service',
        aliases: [],
        type: 'single_choice',
        options: [{ key: 'video', label: 'Video' }],
      },
    ],
    deal: [],
  },
  forms: [],
  emailTemplates: [],
  whatsappTemplates: [],
  mailboxes: [],
  phoneNumbers: [],
  calendars: [],
  pipelines: [],
  lostReasons: [],
  tags: [],
  users: [],
  automations: [],
  values: ['office'],
  channels: { email: true, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const document = (fields: Record<string, unknown>) => ({
  name: 'Work out values',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'set',
  steps: { set: { type: 'contact.update', config: { fields } } },
});
const check = (fields: Record<string, unknown>) => validateAutomation(document(fields), setup);
const codes = (result: ReturnType<typeof validateAutomation>) =>
  result.errors.map((issue) => `${issue.path} ${issue.code}`);
const written = (result: ReturnType<typeof validateAutomation>) => {
  const step = result.document?.steps['set'];
  return step?.type === 'contact.update' ? step.config.fields : undefined;
};

describe('the shape of a value a step writes', () => {
  it.each([
    'Grace',
    120,
    true,
    null,
    '{{contact.custom.utm_source}}',
    { op: 'now' },
    { op: 'date_add', days: 365 },
    { op: 'date_add', field: 'contact.custom.event_date', days: -7 },
    { op: 'date_add', value: '2026-12-01', days: MAX_DATE_ADD_DAYS },
    { op: 'date_add', value: '2026-12-01T09:00:00+03:00', days: 1 },
    { op: 'date_add', value: 'now', days: 0 },
    { op: 'math', left: 'contact.custom.visits', operator: '+', right: 1 },
    { op: 'math', left: 2, operator: '/', right: 'contact.custom.visits' },
    { set: { op: 'now' }, onlyIfEmpty: true },
    { set: 'Hello {{contact.firstName}}' },
    { set: null, onlyIfEmpty: false },
  ])('takes %j', (value) => {
    expect(automationFieldWrite.safeParse(value).success).toBe(true);
  });

  it.each([
    { op: 'today' },
    { op: 'now', days: 1 },
    { op: 'date_add' },
    { op: 'date_add', days: 1.5 },
    { op: 'date_add', days: MAX_DATE_ADD_DAYS + 1 },
    { op: 'date_add', value: 'tomorrow', days: 1 },
    { op: 'math', left: 1, operator: '%', right: 2 },
    { op: 'math', left: 1, operator: '+' },
    { op: 'math', left: 'visits', operator: '+', right: 1 },
    { onlyIfEmpty: true },
    { set: 'x', onlyIfEmpty: 'yes' },
    { set: 'x', only_if_empty: true },
    { set: { set: 'x' } },
    ['a'],
  ])('refuses %j', (value) => {
    expect(automationFieldWrite.safeParse(value).success).toBe(false);
  });

  it('leaves a fixed value in a stored document exactly as it was written', () => {
    const fields = { 'contact.firstName': 'Grace', 'contact.custom.budget': 120 };
    expect(automationDocument.parse(document(fields)).steps['set']?.config).toEqual({ fields });
  });

  it('describes each computed value for whoever writes one', () => {
    const schema = JSON.stringify(
      automationCatalog().steps.find((step) => step.type === 'contact.update')?.config,
    );
    for (const word of ['date_add', 'math', 'onlyIfEmpty', 'copies that field'])
      expect(schema).toContain(word);
    expect(automationStepTypes['contact.update'].version).toBe(2);
    expect(automationComputedValue.options.map((option) => option.shape.op.value)).toEqual([
      'now',
      'date_add',
      'math',
    ]);
  });
});

describe('validating what a step writes', () => {
  it('makes the fields canonical, in the value as in the key', () => {
    const result = check({
      'contact.lead_source_raw': '{{contact.utm}} via {{custom_values.office}}',
      'contact.budget': { op: 'math', left: 'contact.visits', operator: '*', right: 100 },
      'contact.event_date': {
        set: { op: 'date_add', field: 'contact.first_enquiry', days: 30 },
        onlyIfEmpty: true,
      },
      'contact.first_enquiry': { set: { op: 'now' }, onlyIfEmpty: true },
      'contact.service': 'Video',
    });
    expect(result.errors).toEqual([]);
    expect(written(result)).toEqual({
      'contact.custom.lead_source_raw':
        '{{contact.custom.utm_source}} via {{custom_values.office}}',
      'contact.custom.budget': {
        op: 'math',
        left: 'contact.custom.visits',
        operator: '*',
        right: 100,
      },
      'contact.custom.event_date': {
        set: { op: 'date_add', field: 'contact.custom.first_enquiry', days: 30 },
        onlyIfEmpty: true,
      },
      'contact.custom.first_enquiry': { set: { op: 'now' }, onlyIfEmpty: true },
      // A fixed choice is still made its key.
      'contact.custom.service': 'video',
    });
  });

  it('lets merge text go to a field of any kind, to be fitted when the step runs', () => {
    expect(
      check({
        'contact.custom.budget': '{{contact.custom.visits}}',
        'contact.custom.event_date': '{{contact.custom.first_enquiry}}',
        'contact.custom.service': '{{contact.custom.utm_source}}',
      }).valid,
    ).toBe(true);
  });

  it('still refuses a fixed value of the wrong kind, alone or under set', () => {
    expect(
      codes(
        check({
          'contact.custom.budget': 'a lot',
          'contact.custom.visits': { set: 'many', onlyIfEmpty: true },
        }),
      ),
    ).toEqual([
      '/steps/set/config/fields/contact.custom.budget wrong_value_type',
      '/steps/set/config/fields/contact.custom.visits/set wrong_value_type',
    ]);
  });

  it('names a merge field that does not exist', () => {
    const result = check({ 'contact.custom.lead_source_raw': '{{contact.custom.utm_sorce}}' });
    expect(codes(result)).toEqual([
      '/steps/set/config/fields/contact.custom.lead_source_raw unknown_merge_field',
    ]);
    expect(result.errors[0]?.suggestion).toBe('Did you mean contact.custom.utm_source?');
  });

  it('keeps each computed value to the kind of field it gives', () => {
    expect(
      codes(
        check({
          'contact.custom.budget': { op: 'now' },
          'contact.custom.utm_source': { op: 'date_add', days: 1 },
          'contact.custom.event_date': { op: 'math', left: 1, operator: '+', right: 1 },
        }),
      ),
    ).toEqual([
      '/steps/set/config/fields/contact.custom.budget wrong_field_type',
      '/steps/set/config/fields/contact.custom.utm_source wrong_field_type',
      '/steps/set/config/fields/contact.custom.event_date wrong_field_type',
    ]);
  });

  it('checks the fields a computed value reads', () => {
    expect(
      codes(
        check({
          'contact.custom.budget': {
            op: 'math',
            left: 'contact.custom.utm_source',
            operator: '+',
            right: 'contact.custom.visit',
          },
          'contact.custom.event_date': {
            op: 'date_add',
            field: 'contact.custom.budget',
            days: 1,
          },
          'contact.custom.first_enquiry': {
            op: 'date_add',
            field: 'contact.custom.event_date',
            value: '2026-12-01',
            days: 1,
          },
          'contact.custom.visits': { op: 'math', left: 1, operator: '/', right: 0 },
        }),
      ),
    ).toEqual([
      '/steps/set/config/fields/contact.custom.budget/left wrong_field_type',
      '/steps/set/config/fields/contact.custom.budget/right unknown_field',
      '/steps/set/config/fields/contact.custom.event_date/field wrong_field_type',
      '/steps/set/config/fields/contact.custom.first_enquiry/value date_base_given_twice',
      '/steps/set/config/fields/contact.custom.visits/right division_by_zero',
    ]);
  });

  it('refuses a field that cannot be written, however its value is given', () => {
    expect(
      codes(check({ 'contact.createdAt': { set: { op: 'now' }, onlyIfEmpty: true } })),
    ).toEqual(['/steps/set/config/fields/contact.createdAt read_only_field']);
  });
});
