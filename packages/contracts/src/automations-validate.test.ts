import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  maxDurationDays,
  validateAutomation,
  type AutomationSetup,
} from './automations-validate.js';

describe('guidance for a workflow being built', () => {
  it('checks removed-tag references against the business setup', () => {
    const result = validateAutomation(
      {
        name: 'Removal',
        triggers: [{ id: 'removed', type: 'tag.removed', config: { tag: 'tag_missing' } }],
        start: 'wait',
        steps: { wait: { type: 'wait', config: { duration: 'PT1M' } } },
      },
      harborLights,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: '/triggers/0/config/tag',
        code: 'unknown_reference',
        message: 'There\'s no tag "tag_missing".',
      },
    ]);
  });

  it('explains an empty workflow without exposing schema jargon', () => {
    const result = validateAutomation(
      { name: 'New workflow', triggers: [], steps: {} },
      harborLights,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: '/start',
        code: 'invalid',
        message: 'Add the first action to choose where this workflow starts.',
        suggestion: 'Choose Add the first action in the builder.',
      },
    ]);
  });
});

const spec = readFileSync(new URL('../../../docs/AUTOMATIONS.md', import.meta.url), 'utf8');
const example = [...spec.matchAll(/```json\n([\s\S]*?)```/g)]
  .map(([, body]) => JSON.parse(body ?? '') as Record<string, unknown>)
  .find((block) => 'steps' in block);
const documentedError = [...spec.matchAll(/```json\n([\s\S]*?)```/g)]
  .map(([, body]) => JSON.parse(body ?? '') as Record<string, unknown>)
  .find((block) => 'valid' in block) as {
  errors: { path: string; code: string; message: string; suggestion: string }[];
};

/** The setup of Harbor Lights, the business of AUTOMATIONS.md. */
export const harborLights: AutomationSetup = {
  fields: {
    contact: [
      {
        key: 'services',
        aliases: ['service_interest'],
        type: 'multi_choice',
        options: [
          { key: 'opt_video', label: 'Video' },
          { key: 'opt_lighting', label: 'Lighting' },
        ],
      },
      { key: 'event_date', aliases: [], type: 'date', options: [] },
      { key: 'guests', aliases: [], type: 'number', options: [] },
      // A custom key that collides with a built-in: the built-in wins for contact.name.
      { key: 'name', aliases: [], type: 'text', options: [] },
    ],
    deal: [],
  },
  forms: [{ id: 'form_quote', name: 'Request a quote' }],
  emailTemplates: [
    { id: 'tmpl_pricing', name: 'Pricing guide' },
    { id: 'tmpl_twin_a', name: 'Welcome' },
    { id: 'tmpl_twin_b', name: 'welcome' },
  ],
  whatsappTemplates: [],
  mailboxes: [{ id: 'mbx_sales', name: 'Sales' }],
  phoneNumbers: [
    { id: 'num_main', name: 'Main line' },
    { id: 'num_events', name: 'Events line' },
  ],
  calendars: [],
  pipelines: [
    {
      id: 'pipe_events',
      name: 'Events',
      stages: [
        { id: 'stage_quote', name: 'Quote sent' },
        { id: 'stage_won', name: 'Booked' },
      ],
    },
    {
      id: 'pipe_corporate',
      name: 'Corporate',
      stages: [{ id: 'stage_corp_quote', name: 'Quote sent' }],
    },
  ],
  lostReasons: [{ id: 'lost_price', name: 'Price' }],
  tags: [{ id: 'tag_vip', name: 'VIP' }],
  users: [{ id: 'user_amina', name: 'Amina' }],
  automations: [],
  values: ['sample_reel_url'],
  channels: { email: true, sms: true, whatsapp: false },
  ai: false,
  webhooks: true,
  // What this install's engine can't run yet; the example uses none of them.
  unavailableSteps: ['team.notify'],
  unavailableTriggers: ['schedule'],
};

describe('the AUTOMATIONS.md example', () => {
  const result = validateAutomation(example, harborLights);

  it('is valid for Harbor Lights, with names resolved and fields made canonical', () => {
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.document?.triggers[0]?.config).toEqual({ form: 'form_quote' });
    expect(result.document?.steps['send_guide']).toMatchObject({
      config: { template: 'tmpl_pricing' },
      typeVersion: 1,
    });
    expect(result.document?.steps['asked_about_video']).toMatchObject({
      config: {
        if: { field: 'contact.custom.services', operator: 'includes', value: 'opt_video' },
      },
    });
  });

  it("warns where a path ends right after a message, as the spec's sample does", () => {
    expect(result.warnings.map((warning) => [warning.path, warning.code])).toEqual([
      ['/steps/send_reel', 'no_follow_up'],
      ['/steps/last_check_in', 'no_follow_up'],
    ]);
  });

  it('leaves the text around merge fields exactly as written', () => {
    const message = (result.document?.steps['check_in']?.config as { message: string }).message;
    expect(message).toBe(
      'Hi {{contact.firstName}}, did the pricing guide come through? Happy to answer any questions.',
    );
  });
});

describe('the documented error', () => {
  it('is what a misspelled merge field gets, path, code and suggestion alike', () => {
    expect(documentedError).toBeDefined();
    const broken = structuredClone(example) as {
      steps: Record<string, { config: { message: string } }>;
    };
    const checkIn = broken.steps['check_in'];
    if (checkIn === undefined) throw new Error('The example lost check_in.');
    checkIn.config.message = checkIn.config.message.replace(
      'contact.firstName',
      'contact.firstname',
    );
    const result = validateAutomation(broken, harborLights);
    expect(result.errors).toEqual([
      {
        path: documentedError.errors[0]?.path,
        code: documentedError.errors[0]?.code,
        message: 'contact.firstname is not a field.',
        suggestion: documentedError.errors[0]?.suggestion,
      },
    ]);
  });
});

// Golden files: test/automations/<case>.json holds a document and exactly the errors it
// must produce, so a message change is a reviewed change.
const goldenDirectory = new URL('../test/automations/', import.meta.url);
describe('the golden invalid documents', () => {
  for (const name of readdirSync(goldenDirectory).filter((file) => file.endsWith('.json'))) {
    it(name, () => {
      const golden = JSON.parse(readFileSync(new URL(name, goldenDirectory), 'utf8')) as {
        document: unknown;
        errors: unknown[];
      };
      const result = validateAutomation(golden.document, harborLights);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(golden.errors);
    });
  }
});

describe('fields', () => {
  const withCondition = (condition: unknown) => ({
    name: 'Check',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'check',
    steps: {
      check: { type: 'condition', config: { if: condition }, next: { yes: 'done', no: 'done' } },
      done: { type: 'tag.add', config: { tag: 'VIP' } },
    },
  });

  it('resolve an alias left by a merge to the surviving field', () => {
    const result = validateAutomation(
      withCondition({ field: 'contact.service_interest', operator: 'includes', value: 'Lighting' }),
      harborLights,
    );
    expect(result.errors).toEqual([]);
    expect(result.document?.steps['check']?.config).toEqual({
      if: { field: 'contact.custom.services', operator: 'includes', value: 'opt_lighting' },
    });
  });

  it('prefer a built-in to a custom field with the same key', () => {
    const result = validateAutomation(
      withCondition({ field: 'contact.name', operator: 'equals', value: 'Ada' }),
      harborLights,
    );
    expect(result.document?.steps['check']?.config).toEqual({
      if: { field: 'contact.name', operator: 'equals', value: 'Ada' },
    });
    const custom = validateAutomation(
      withCondition({ field: 'contact.custom.name', operator: 'equals', value: 'Ada' }),
      harborLights,
    );
    expect(custom.errors).toEqual([]);
  });

  it("refuse a field the business doesn't have, such as an archived one", () => {
    expect(
      validateAutomation(
        withCondition({ field: 'contact.custom.budget', operator: 'is_set' }),
        harborLights,
      ).errors,
    ).toEqual([
      {
        path: '/steps/check/config/if/field',
        code: 'unknown_field',
        message: 'contact.custom.budget is not a field.',
      },
    ]);
  });

  it.each([
    [
      { field: 'contact.custom.guests', operator: 'greater_than', value: 'many' },
      '/steps/check/config/if/value',
      'wrong_value_type',
    ],
    [
      { field: 'contact.firstName', operator: 'greater_than', value: 3 },
      '/steps/check/config/if/operator',
      'wrong_operator',
    ],
    [
      { field: 'contact.custom.event_date', operator: 'before', value: 'soon' },
      '/steps/check/config/if/value',
      'wrong_value_type',
    ],
    [
      { field: 'contact.custom.services', operator: 'includes', value: 'Catering' },
      '/steps/check/config/if/value',
      'unknown_option',
    ],
  ])('check %j against the field type', (condition, path, code) => {
    expect(validateAutomation(withCondition(condition), harborLights).errors).toMatchObject([
      { path, code },
    ]);
  });
});

describe('durations', () => {
  it.each([
    ['P2D', 2],
    ['PT36H', 1.5],
    ['P1Y', 365],
    ['P12M', 372],
    ['P2W', 14],
  ])('%s lasts at most %s days', (duration, days) => {
    expect(maxDurationDays(duration)).toBe(days);
  });
});

describe('a webhook step', () => {
  const document = {
    name: 'Tell the warehouse',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'tell',
    steps: {
      tell: { type: 'webhook.call', config: { url: 'https://hooks.example.test/crm' } },
    },
  };

  it('needs a signing secret, since an unsigned webhook is never sent', () => {
    const result = validateAutomation(document, { ...harborLights, webhooks: false });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: '/steps/tell',
        code: 'no_webhook_secret',
        message: 'Create a webhook signing secret before sending from this step.',
      },
    ]);
  });

  it('is fine once the business has one', () => {
    expect(validateAutomation(document, { ...harborLights, webhooks: true })).toMatchObject({
      valid: true,
      errors: [],
    });
  });
});

describe('a text message step', () => {
  const document = (config: Record<string, unknown>) => ({
    name: 'Check in',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'text',
    steps: {
      text: { type: 'sms.send', config, next: 'tagged' },
      tagged: { type: 'tag.add', config: { tag: 'VIP' } },
    },
  });

  it('may name the number it sends from, by name, and keeps its id', () => {
    const result = validateAutomation(
      document({ message: 'Hello', number: 'events line' }),
      harborLights,
    );
    expect(result.errors).toEqual([]);
    expect(result.document?.steps['text']?.config).toEqual({
      message: 'Hello',
      number: 'num_events',
    });
  });

  it('is refused for a number the business does not have, with the nearest name', () => {
    expect(
      validateAutomation(document({ message: 'Hello', number: 'Main lime' }), harborLights).errors,
    ).toEqual([
      {
        path: '/steps/text/config/number',
        code: 'unknown_reference',
        message: `There's no phone number "Main lime".`,
        suggestion: 'Did you mean Main line?',
      },
    ]);
  });

  it('needs no number named: the engine uses the only one, or says which to choose', () => {
    expect(validateAutomation(document({ message: 'Hello' }), harborLights).errors).toEqual([]);
  });
});

describe('a step this install cannot run yet', () => {
  const document = {
    name: 'Hand over',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'assign',
    steps: { assign: { type: 'owner.assign', config: { user: 'Amina' } } },
  };

  it('is refused before it is published, never left to fail when it runs', () => {
    const result = validateAutomation(document, {
      ...harborLights,
      unavailableSteps: ['owner.assign'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: '/steps/assign',
        code: 'step_unavailable',
        message: 'Assign owner steps are not available yet.',
        suggestion: 'Remove this step, or use a step that is available.',
      },
    ]);
  });

  it('covers triggers too: one that nothing fires is refused, not left to never start', () => {
    const scheduled = {
      ...document,
      triggers: [{ id: 'daily', type: 'schedule', config: { every: 'day', at: '09:00' } }],
    };
    expect(validateAutomation(scheduled, { ...harborLights, unavailableSteps: [] }).errors).toEqual(
      [
        {
          path: '/triggers/0',
          code: 'trigger_unavailable',
          message: 'Nothing starts an automation on "Schedule" yet.',
          suggestion: 'Remove this trigger, or use one that is available.',
        },
      ],
    );
    expect(
      validateAutomation(scheduled, {
        ...harborLights,
        unavailableSteps: [],
        unavailableTriggers: [],
      }).errors,
    ).toEqual([]);
  });

  it('is fine on an install whose engine runs it', () => {
    expect(validateAutomation(document, { ...harborLights, unavailableSteps: [] }).errors).toEqual(
      [],
    );
  });
});

describe('where a contact came from, and whether it is a lead or a customer', () => {
  const withCondition = (condition: unknown, message = 'Hello') => ({
    name: 'Website leads',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'check',
    steps: {
      check: { type: 'condition', config: { if: condition }, next: { yes: 'note', no: 'note' } },
      note: { type: 'note.create', config: { text: message } },
    },
  });

  it('are fields a condition reads', () => {
    const result = validateAutomation(
      withCondition({
        all: [
          { field: 'contact.source', operator: 'equals', value: 'Website' },
          { field: 'contact.type', operator: 'equals', value: 'Lead' },
        ],
      }),
      harborLights,
    );
    expect(result.errors).toEqual([]);
    // The source is the business's own words; the type is one of two, kept by its key.
    expect(result.document?.steps['check']?.config).toEqual({
      if: {
        all: [
          { field: 'contact.source', operator: 'equals', value: 'Website' },
          { field: 'contact.type', operator: 'equals', value: 'lead' },
        ],
      },
    });
  });

  it('are merge fields a message fills in', () => {
    const result = validateAutomation(
      withCondition(
        { field: 'contact.source', operator: 'is_set' },
        'Came from {{contact.source}} as a {{contact.type}}.',
      ),
      harborLights,
    );
    expect(result.errors).toEqual([]);
  });

  it('refuse a type a contact cannot be, and a step that would set either', () => {
    expect(
      validateAutomation(
        withCondition({ field: 'contact.type', operator: 'equals', value: 'Partner' }),
        harborLights,
      ).errors,
    ).toMatchObject([{ path: '/steps/check/config/if/value', code: 'unknown_option' }]);
    expect(
      validateAutomation(
        {
          name: 'Set source',
          triggers: [{ id: 'created', type: 'contact.created', config: {} }],
          start: 'set',
          steps: {
            set: { type: 'contact.update', config: { fields: { 'contact.source': 'Website' } } },
          },
        },
        harborLights,
      ).errors,
    ).toMatchObject([{ path: '/steps/set/config/fields/contact.source', code: 'read_only_field' }]);
  });
});

describe('a deal whose amount comes from a field', () => {
  const creating = (config: Record<string, unknown>) => ({
    name: 'Open a deal',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'open',
    steps: {
      open: { type: 'deal.create', config: { pipeline: 'Events', stage: 'Quote sent', ...config } },
    },
  });
  const errors = (config: Record<string, unknown>) =>
    validateAutomation(creating(config), harborLights).errors;

  it('names a number field of the contact, kept by its canonical path', () => {
    const result = validateAutomation(creating({ amountFrom: 'contact.guests' }), harborLights);
    expect(result.errors).toEqual([]);
    expect(result.document?.steps['open']?.config).toEqual({
      pipeline: 'pipe_events',
      stage: 'stage_quote',
      amountFrom: 'contact.custom.guests',
    });
  });

  it('still takes a fixed amount, or none', () => {
    expect(errors({ amount: 1500 })).toEqual([]);
    expect(errors({})).toEqual([]);
  });

  it('is refused beside a fixed amount', () => {
    expect(errors({ amount: 1500, amountFrom: 'contact.custom.guests' })).toEqual([
      {
        path: '/steps/open/config/amountFrom',
        code: 'amount_given_twice',
        message: 'Give the opportunity a fixed amount or take it from a field, not both.',
        suggestion: 'Remove amount, or remove amountFrom.',
      },
    ]);
  });

  it.each([
    ['contact.custom.event_date', 'wrong_field_type', "contact.custom.event_date isn't a number."],
    ['contact.firstName', 'wrong_field_type', "contact.firstName isn't a number."],
    ['deal.amount', 'wrong_field', 'deal.amount is not a contact field.'],
    ['contact.custom.budget', 'unknown_field', 'contact.custom.budget is not a field.'],
  ])('is refused for %s, which is not a number field of the contact', (field, code, message) => {
    expect(errors({ amountFrom: field })).toEqual([
      { path: '/steps/open/config/amountFrom', code, message },
    ]);
  });
});

describe('what a field.changed trigger says the field changed to', () => {
  const changedTo = (field: string, to: unknown) => ({
    name: 'Changed',
    triggers: [{ id: 'changed', type: 'field.changed', config: { field, to } }],
    start: 'note',
    steps: { note: { type: 'note.create', config: { text: 'Changed' } } },
  });

  it('is a value of the field, with a choice given by its label kept as its key', () => {
    const result = validateAutomation(changedTo('contact.services', 'Lighting'), harborLights);
    expect(result.errors).toEqual([]);
    expect(result.document?.triggers[0]?.config).toEqual({
      field: 'contact.custom.services',
      to: 'opt_lighting',
    });
    expect(validateAutomation(changedTo('contact.guests', 120), harborLights).errors).toEqual([]);
  });

  it('may be empty text: changed to nothing', () => {
    const result = validateAutomation(changedTo('contact.guests', ''), harborLights);
    expect(result.errors).toEqual([]);
    expect(result.document?.triggers[0]?.config).toEqual({
      field: 'contact.custom.guests',
      to: '',
    });
  });

  it('is refused when the field could never hold it', () => {
    expect(validateAutomation(changedTo('contact.guests', 'many'), harborLights).errors).toEqual([
      {
        path: '/triggers/0/config/to',
        code: 'wrong_value_type',
        message: 'contact.custom.guests holds numbers; compare it with a number.',
      },
    ]);
    expect(
      validateAutomation(changedTo('contact.services', 'Catering'), harborLights).errors,
    ).toMatchObject([{ path: '/triggers/0/config/to', code: 'unknown_option' }]);
  });

  it('adds nothing to a trigger that names no value', () => {
    const result = validateAutomation(
      {
        name: 'Changed',
        triggers: [{ id: 'changed', type: 'field.changed', config: { field: 'contact.guests' } }],
        start: 'note',
        steps: { note: { type: 'note.create', config: { text: 'Changed' } } },
      },
      harborLights,
    );
    expect(result.errors).toEqual([]);
    expect(JSON.stringify(result.document?.triggers[0]?.config)).toBe(
      '{"field":"contact.custom.guests"}',
    );
  });
});
