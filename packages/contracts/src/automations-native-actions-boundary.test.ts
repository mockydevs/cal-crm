import { expect, it } from 'vitest';

import { automationStep } from './automations.js';
import { automationStepTypes } from './automations-catalog.js';
import { validateAutomation } from './automations-validate.js';

it('rejects unknown note merge fields before publishing', () => {
  const result = validateAutomation(
    {
      name: 'Write note',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'note',
      steps: { note: { type: 'note.create', config: { text: '{{contact.unknown}}' } } },
    },
    {
      fields: { contact: [], deal: [] },
      values: [],
      tags: [],
      users: [],
      pipelines: [],
      lostReasons: [],
      emailTemplates: [],
      whatsappTemplates: [],
      phoneNumbers: [],
      mailboxes: [],
      calendars: [],
      forms: [],
      automations: [],
      ai: false,
      channels: { email: false, sms: false, whatsapp: false },
      webhooks: false,
      unavailableSteps: [],
      unavailableTriggers: [],
    },
  );
  expect(result.valid).toBe(false);
  expect(result.errors).toMatchObject([
    { path: '/steps/note/config/text', code: 'unknown_merge_field' },
  ]);
});

it('accepts native note creation and returns a declared note id for later merges', () => {
  expect(
    automationStep.safeParse({
      type: 'note.create',
      config: { text: 'Welcome {{contact.firstName}}' },
    }).success,
  ).toBe(true);
  expect(automationStepTypes['note.create'].outputs).toEqual([
    { key: 'noteId', type: 'id', description: 'The note created.' },
  ]);
});

it('accepts owner removal with no invented user or revision config', () => {
  expect(automationStep.safeParse({ type: 'owner.remove', config: {} }).success).toBe(true);
});

it('accepts exactly one thousand non-empty lines within the canonical note node limit', () => {
  expect(
    automationStep.safeParse({
      type: 'note.create',
      config: { text: 'a\n'.repeat(999) + 'a' },
    }).success,
  ).toBe(true);
});

it('refuses a static note beyond the canonical node limit before publishing', () => {
  expect(
    automationStep.safeParse({
      type: 'note.create',
      config: { text: 'a\n'.repeat(1000) + 'a' },
    }).success,
  ).toBe(false);
});

it.each(['', ' '.repeat(5), 'x'.repeat(100001)])('refuses invalid note text', (text) => {
  expect(automationStep.safeParse({ type: 'note.create', config: { text } }).success).toBe(false);
});

it('refuses caller supplied note authors and owner removal users', () => {
  expect(
    automationStep.safeParse({ type: 'note.create', config: { text: 'Hello', author: 'Ada' } })
      .success,
  ).toBe(false);
  expect(automationStep.safeParse({ type: 'owner.remove', config: { user: 'Ada' } }).success).toBe(
    false,
  );
});
