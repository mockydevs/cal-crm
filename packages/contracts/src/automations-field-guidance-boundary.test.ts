import { expect, it } from 'vitest';

import { validateAutomation, type AutomationSetup } from './automations-validate.js';

const setup: AutomationSetup = {
  fields: {
    contact: [{ key: 'event_date', aliases: ['event_day'], type: 'date', options: [] }],
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
  values: [],
  channels: { email: false, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const workflow = (field: string) => ({
  name: 'Date change reminder',
  triggers: [{ id: 'changed', type: 'field.changed', config: { field } }],
  start: 'wait',
  steps: { wait: { type: 'wait', config: { duration: 'PT1M' } } },
});

it('suggests a nearby built-in field without silently accepting the typo', () => {
  const input = workflow('contact.firstNme');
  const result = validateAutomation(input, setup);
  expect(result.valid).toBe(false);
  expect(result.document).toBeUndefined();
  expect(result.errors).toEqual([
    {
      path: '/triggers/0/config/field',
      code: 'unknown_field',
      message: 'contact.firstNme is not a field.',
      suggestion: 'Did you mean contact.firstName?',
    },
  ]);
  expect(input.triggers[0]?.config.field).toBe('contact.firstNme');
});

it('suggests the tenant custom field rather than inventing a new field', () => {
  expect(validateAutomation(workflow('contact.custom.event_dat'), setup).errors).toEqual([
    {
      path: '/triggers/0/config/field',
      code: 'unknown_field',
      message: 'contact.custom.event_dat is not a field.',
      suggestion: 'Did you mean contact.custom.event_date?',
    },
  ]);
});

it('refuses an unrelated key without a misleading suggestion', () => {
  expect(validateAutomation(workflow('contact.custom.zzzzzzzzzzzz'), setup).errors).toEqual([
    {
      path: '/triggers/0/config/field',
      code: 'unknown_field',
      message: 'contact.custom.zzzzzzzzzzzz is not a field.',
    },
  ]);
});

it('normalizes an explicitly declared alias while leaving the input untouched', () => {
  const input = workflow('contact.custom.event_day');
  const result = validateAutomation(input, setup);
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.document?.triggers[0]?.config).toEqual({ field: 'contact.custom.event_date' });
  expect(input.triggers[0]?.config.field).toBe('contact.custom.event_day');
});
