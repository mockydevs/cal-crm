// "Replied to automation" on the message.received trigger: what the catalog takes, and what
// the validator resolves and refuses.
import { describe, expect, it } from 'vitest';

import { automationTriggerTypes } from './automations-catalog.js';
import {
  portableAutomation,
  validateAutomation,
  type AutomationSetup,
} from './automations-validate.js';

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
  tags: [],
  users: [],
  automations: [
    { id: 'aut_dj', name: 'DJ sales' },
    { id: 'aut_photo', name: 'Photo and video sales' },
  ],
  values: [],
  channels: { email: false, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const document = (config: Record<string, unknown>) => ({
  name: 'Sales reply: notify',
  triggers: [{ id: 'replied', type: 'message.received', config }],
  start: 'pause',
  steps: { pause: { type: 'wait', config: { duration: 'PT1M' } } },
});

describe('the message.received trigger', () => {
  const config = automationTriggerTypes['message.received'].config;

  it('takes the automations a reply must be to, one to twenty of them', () => {
    expect(config.safeParse({}).success).toBe(true);
    expect(config.safeParse({ channel: 'email' }).success).toBe(true);
    expect(config.safeParse({ repliedTo: ['DJ sales'] }).success).toBe(true);
    expect(config.safeParse({ channel: 'sms', repliedTo: ['aut_dj', 'aut_photo'] }).success).toBe(
      true,
    );
    expect(config.safeParse({ repliedTo: [] }).success).toBe(false);
    expect(
      config.safeParse({ repliedTo: Array.from({ length: 21 }, (_, n) => `aut_${String(n)}`) })
        .success,
    ).toBe(false);
    expect(config.safeParse({ repliedTo: 'DJ sales' }).success).toBe(false);
  });

  it('has each automation it names resolved by the validator', () => {
    const result = validateAutomation(
      document({ repliedTo: ['dj sales', 'aut_photo'], channel: 'email' }),
      setup,
    );
    expect(result.errors).toEqual([]);
    expect(result.document?.triggers[0]?.config).toEqual({
      channel: 'email',
      repliedTo: ['aut_dj', 'aut_photo'],
    });
  });

  it('is refused where it names an automation the business does not have', () => {
    const result = validateAutomation(document({ repliedTo: ['DJ sales', 'DJ sails'] }), setup);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: '/triggers/0/config/repliedTo/1',
        code: 'unknown_reference',
        message: 'There\'s no automation "DJ sails".',
        suggestion: 'Did you mean DJ sales?',
      },
    ]);
  });

  it('goes to another business with its automations by name', () => {
    const { document: portable, warnings } = portableAutomation(
      document({ repliedTo: ['aut_dj', 'aut_gone'] }),
      setup,
    );
    expect(portable['triggers']).toMatchObject([
      { config: { repliedTo: ['DJ sales', 'aut_gone'] } },
    ]);
    expect(warnings).toEqual([
      {
        path: '/triggers/0/config/repliedTo/1',
        code: 'not_portable',
        message: 'There\'s no automation "aut_gone" to name.',
      },
    ]);
  });
});
