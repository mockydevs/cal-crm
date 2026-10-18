import { describe, expect, it } from 'vitest';

import { automationStep } from './automations.js';
import { validateAutomation, type AutomationSetup } from './automations-validate.js';

const email = (config: unknown) => automationStep.safeParse({ type: 'email.send', config });

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
  channels: { email: true, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const validateEmail = (subject: string, body: string) =>
  validateAutomation(
    {
      name: 'Inline email',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'email',
      steps: { email: { type: 'email.send', config: { subject, body } } },
    },
    setup,
  );

describe('email content authored inside a workflow', () => {
  it.each(['subject', 'body'] as const)('locates an unknown merge field in the %s', (field) => {
    const result = validateEmail(
      field === 'subject' ? 'Hello {{unknown.value}}' : 'Hello',
      field === 'body' ? 'Welcome {{unknown.value}}' : 'Welcome.',
    );
    expect(result.errors).toEqual([
      {
        path: `/steps/email/config/${field}`,
        code: 'unknown_merge_field',
        message: 'unknown.value is not a merge field.',
        suggestion:
          'Merge fields start with contact., deal., appointment., custom_values., values., trigger_link., steps. or trigger.',
      },
    ]);
    expect(result.valid).toBe(false);
  });

  it('canonicalizes a tenant field alias in both inline content members', () => {
    const result = validateEmail(
      'Your {{contact.custom.event_day}} event',
      'See you on {{contact.custom.event_day}}.',
    );
    expect(result.errors).toEqual([]);
    expect(result.document?.steps['email']?.config).toEqual({
      subject: 'Your {{contact.custom.event_date}} event',
      body: 'See you on {{contact.custom.event_date}}.',
    });
  });
  it('accepts inline subject and body without inventing a saved template', () => {
    const result = email({ subject: 'Hello {{contact.firstName}}', body: 'Welcome to Harbor.' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.config).toEqual({
      subject: 'Hello {{contact.firstName}}',
      body: 'Welcome to Harbor.',
    });
  });

  it('retains the existing template configuration', () => {
    const result = email({ template: 'Pricing guide', mailbox: 'Sales' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.config).toEqual({ template: 'Pricing guide', mailbox: 'Sales' });
  });

  it('accepts the canonical maximum subject and body lengths', () => {
    expect(email({ subject: 's'.repeat(998), body: 'b'.repeat(1_000_000) }).success).toBe(true);
  });

  it.each([
    { subject: 's'.repeat(999), body: 'Welcome.' },
    { subject: 'Hello', body: 'b'.repeat(1_000_001) },
    { subject: 'Hello\r\nBcc: someone@example.test', body: 'Welcome.' },
    { subject: 'Hello\nInjected header', body: 'Welcome.' },
    { subject: ' ', body: 'Welcome.' },
    { subject: 'Hello', body: ' ' },
    { subject: 'Hello' },
    { body: 'Welcome.' },
    { template: 'Pricing guide', subject: 'Hello', body: 'Welcome.' },
    { subject: 'Hello', body: 'Welcome.', unexpected: true },
  ])('rejects incomplete, conflicting or unsafe inline content %#', (config) => {
    expect(email(config).success).toBe(false);
  });
});
