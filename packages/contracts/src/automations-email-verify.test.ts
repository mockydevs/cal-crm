// The Email verification step and the two contact values an If / else reads of it:
// shape, validation and the published catalog. The engine's side is tested in
// packages/modules/automation.
import { describe, expect, it } from 'vitest';

import { automationStepTypes } from './automations-catalog.js';
import { automationCatalog, automationDocument } from './automations.js';
import { validateAutomation, type AutomationSetup } from './automations-validate.js';
import { automationSetup } from './automations-api.js';

const setup: AutomationSetup = {
  fields: { contact: [], deal: [] },
  forms: [],
  emailTemplates: [],
  whatsappTemplates: [],
  mailboxes: [],
  phoneNumbers: [],
  calendars: [],
  pipelines: [],
  lostReasons: [],
  tags: [{ id: 'tag_checked', name: 'Checked' }],
  users: [],
  automations: [],
  values: [],
  channels: { email: true, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  emailVerification: true,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const document = (config: unknown) => ({
  name: 'Check new leads',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'check',
  steps: { check: { type: 'email.verify', config } },
});
const codes = (result: ReturnType<typeof validateAutomation>) =>
  result.errors.map((issue) => `${issue.path} ${issue.code}`);

describe('the shape of email.verify', () => {
  it('checks the primary address and reuses a result up to 90 days old unless told', () => {
    expect(automationDocument.parse(document({})).steps['check']?.config).toEqual({
      address: 'primary',
      maxAgeDays: 90,
    });
    expect(
      automationDocument.parse(document({ address: 'primary', maxAgeDays: 7 })).steps['check']
        ?.config,
    ).toEqual({ address: 'primary', maxAgeDays: 7 });
  });

  it('takes 1 to 365 days, in whole days, and no other address', () => {
    for (const maxAgeDays of [0, 366, 1.5])
      expect(automationDocument.safeParse(document({ maxAgeDays })).success).toBe(false);
    for (const maxAgeDays of [1, 365])
      expect(automationDocument.safeParse(document({ maxAgeDays })).success).toBe(true);
    expect(automationDocument.safeParse(document({ address: 'all' })).success).toBe(false);
    expect(automationDocument.safeParse(document({ also: true })).success).toBe(false);
  });

  it('is in the catalog as GoHighLevel names it, among the contact steps', () => {
    expect(automationStepTypes['email.verify']).toMatchObject({
      group: 'records',
      version: 1,
      label: 'Email verification',
    });
    const listed = automationCatalog().steps.find((step) => step.type === 'email.verify');
    expect(listed?.outputs.map((output) => output.key)).toEqual(['status', 'depth']);
  });
});

describe('validating email.verify', () => {
  it('is fine while email verification is on, or when the setup cannot tell', () => {
    expect(codes(validateAutomation(document({}), setup))).toEqual([]);
    const { emailVerification: _left, ...unknown } = setup;
    expect(codes(validateAutomation(document({}), unknown))).toEqual([]);
  });

  it('is refused while email verification is off, saying where to turn it on', () => {
    const result = validateAutomation(document({}), { ...setup, emailVerification: false });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: '/steps/check',
        code: 'verification_off',
        message:
          'Turn on email verification in Settings → Email Services → Email Verification before using this step.',
      },
    ]);
  });

  it('lets the setup say whether verification is on', () => {
    expect(automationSetup.parse({ ...setup, emailVerification: false }).emailVerification).toBe(
      false,
    );
    const { emailVerification: _left, ...older } = setup;
    expect(automationSetup.parse(older).emailVerification).toBeUndefined();
  });
});

describe('the contact values an If / else reads', () => {
  const branch = (field: string, value: unknown) => ({
    name: 'Branch on the check',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'check',
    steps: {
      check: { type: 'email.verify', config: {}, next: 'which' },
      which: {
        type: 'condition',
        config: {
          branches: [
            {
              name: 'good',
              if: { all: [{ field, operator: 'equals', value }] },
            },
          ],
        },
        next: { good: 'tag' },
      },
      tag: { type: 'tag.add', config: { tag: 'Checked' } },
    },
  });

  it('reads the primary address’s verification, by key or by its label', () => {
    for (const value of ['valid', 'risky', 'invalid', 'unknown', 'unchecked', 'excluded'])
      expect(codes(validateAutomation(branch('contact.emailVerification', value), setup))).toEqual(
        [],
      );
    const byLabel = validateAutomation(branch('contact.emailVerification', 'Verified'), setup);
    expect(byLabel.errors).toEqual([]);
    expect(byLabel.document?.steps['which']?.config).toMatchObject({
      branches: [{ if: { all: [{ value: 'valid' }] } }],
    });
  });

  it('refuses a verification that does not exist', () => {
    expect(
      codes(validateAutomation(branch('contact.emailVerification', 'deliverable'), setup)),
    ).toEqual(['/steps/which/config/branches/0/if/all/0/value unknown_option']);
  });

  it('reads whether the primary address is verified as yes or no', () => {
    expect(codes(validateAutomation(branch('contact.emailVerified', true), setup))).toEqual([]);
    expect(codes(validateAutomation(branch('contact.emailVerified', 'yes'), setup))).toEqual([
      '/steps/which/config/branches/0/if/all/0/value wrong_value_type',
    ]);
  });

  it('never lets a step write them', () => {
    const write = {
      name: 'Write',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'update',
      steps: {
        update: {
          type: 'contact.update',
          config: { fields: { 'contact.emailVerification': 'valid' } },
        },
      },
    };
    expect(codes(validateAutomation(write, setup))).toEqual([
      '/steps/update/config/fields/contact.emailVerification read_only_field',
    ]);
  });
});
