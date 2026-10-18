// Two things the validator says and does not refuse: a Form submitted trigger that names a
// form still in draft, and a Send email step of a business whose profile has no postal
// address.
import { describe, expect, it } from 'vitest';

import { automationSetup } from './automations-api.js';
import { validateAutomation, type AutomationSetup } from './automations-validate.js';

const setup: AutomationSetup = {
  fields: { contact: [], deal: [] },
  forms: [
    { id: 'form_live', name: 'Enquiry', status: 'published' },
    {
      id: 'form_draft',
      name: 'Wedding enquiry',
      status: 'draft',
      questions: [{ key: 'guests', label: 'Guests', type: 'number', options: [] }],
    },
    // From a server that lists published forms only, and does not say so.
    { id: 'form_old', name: 'Old' },
  ],
  emailTemplates: [{ id: 'tmpl_welcome', name: 'Welcome' }],
  whatsappTemplates: [],
  mailboxes: [{ id: 'mbx_main', name: 'Main' }],
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

const started = (form: string, given: AutomationSetup = setup) =>
  validateAutomation(
    {
      name: 'Leads',
      triggers: [{ id: 'sent', type: 'form.submitted', config: { form } }],
      start: 'tagged',
      steps: { tagged: { type: 'tag.add', config: { tag: 'VIP' } } },
    },
    given,
  );

describe('a Form submitted trigger', () => {
  it('that names a draft form is valid, and is told to publish it', () => {
    for (const named of ['form_draft', 'Wedding enquiry', 'wedding ENQUIRY']) {
      const result = started(named);
      expect(result.valid, named).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([
        {
          path: '/triggers/0/config/form',
          code: 'form_draft',
          message:
            'This form is a draft: publish it to receive submissions. Until then nothing starts this workflow from "Wedding enquiry".',
        },
      ]);
      // The name is resolved to the draft's id, as a published form's is.
      expect(result.document?.triggers[0]?.config).toEqual({ form: 'form_draft' });
    }
  });

  it('that names a published form, or one of a setup that does not say, is told nothing', () => {
    for (const named of ['Enquiry', 'form_old'])
      expect(started(named), named).toMatchObject({ valid: true, warnings: [] });
  });

  it('that names a form that is archived or missing is still refused', () => {
    // An archived form is not in the setup at all: it is as missing as one never made.
    const result = started('Retired form');
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: '/triggers/0/config/form',
        code: 'unknown_reference',
        message: 'There\'s no form "Retired form".',
      }),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('reads a draft form’s answers by the questions of its draft', () => {
    const reading = (path: string) =>
      validateAutomation(
        {
          name: 'Leads',
          triggers: [{ id: 'sent', type: 'form.submitted', config: { form: 'form_draft' } }],
          start: 'check',
          steps: {
            check: {
              type: 'condition',
              config: { if: { field: path, operator: 'greater_than', value: 50 } },
              next: { yes: 'tagged' },
            },
            tagged: { type: 'tag.add', config: { tag: 'VIP' } },
          },
        },
        setup,
      );
    expect(reading('trigger.answers.guests').valid).toBe(true);
    expect(reading('trigger.answers.gests').errors.map((issue) => issue.code)).toEqual([
      'unknown_field',
    ]);
  });
});

describe('a Send email step', () => {
  const sending = (given: AutomationSetup) =>
    validateAutomation(
      {
        name: 'Welcome',
        triggers: [{ id: 'sent', type: 'form.submitted', config: { form: 'Enquiry' } }],
        start: 'first',
        steps: {
          first: {
            type: 'email.send',
            config: { template: 'Welcome', mailbox: 'Main' },
            next: 'second',
          },
          second: { type: 'email.send', config: { template: 'Welcome', mailbox: 'Main' } },
        },
      },
      given,
    );

  /** What is said about the address; a path that ends on a message has a warning of its own. */
  const address = (given: AutomationSetup) =>
    sending(given).warnings.filter((warning) => warning.code === 'no_postal_address');

  it('of a business with no postal address is valid, and is warned at each step in plain words', () => {
    const result = sending({ ...setup, postalAddress: false });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(address({ ...setup, postalAddress: false })).toEqual(
      ['first', 'second'].map((step) => ({
        path: `/steps/${step}`,
        code: 'no_postal_address',
        message:
          'Your business profile has no postal address. US law (CAN-SPAM) asks every marketing email to show a valid postal address: add yours in Settings → Business profile and it is added to the end of this email. The email is still sent without it.',
      })),
    );
  });

  it('is told nothing when the profile has an address, or the setup cannot tell', () => {
    expect(address({ ...setup, postalAddress: true })).toEqual([]);
    expect(address(setup)).toEqual([]);
  });
});

describe('the setup as the API answers it', () => {
  it('takes a form’s status and the postal address, and neither from an older server', () => {
    expect(automationSetup.safeParse({ ...setup, postalAddress: false }).success).toBe(true);
    expect(automationSetup.safeParse(setup).success).toBe(true);
    expect(
      automationSetup.safeParse({ ...setup, forms: [{ id: 'f', name: 'F', status: 'archived' }] })
        .success,
    ).toBe(false);
  });
});
