// Two ways an automation starts without an outside event: it has no trigger and another
// automation starts it, or it starts when a run of another automation ends.
import { describe, expect, it } from 'vitest';

import { automationTriggerTypes } from './automations-catalog.js';
import { automationDocument, automationJsonSchema } from './automations.js';
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
    { id: 'aut_dj', name: 'DJ sales', starts: [], startsAfter: [] },
    { id: 'aut_notify', name: 'Sales reply: notify', starts: [], startsAfter: ['aut_dj'] },
    { id: 'aut_follow', name: 'Follow-up', starts: ['aut_dj'], startsAfter: ['aut_notify'] },
  ],
  values: [],
  channels: { email: false, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const steps = { pause: { type: 'wait', config: { duration: 'PT1M' } } };
const ended = (config: Record<string, unknown>, name = 'Sales reply: notify') => ({
  name,
  triggers: [{ id: 'ended', type: 'automation.run_ended', config }],
  start: 'pause',
  steps,
});

describe('an automation with no trigger', () => {
  const document = { name: 'Consultation booked', triggers: [], start: 'pause', steps };

  it('is a document, and the published schema no longer asks for a trigger', () => {
    expect(automationDocument.parse(document).triggers).toEqual([]);
    expect(automationDocument.safeParse({ ...document, triggers: undefined }).success).toBe(false);
    const schema = automationJsonSchema() as { properties: { triggers: { minItems?: number } } };
    expect(schema.properties.triggers.minItems ?? 0).toBe(0);
  });

  it('is valid, with a warning in plain words that nothing starts it on its own', () => {
    const result = validateAutomation(document, setup);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      {
        path: '/triggers',
        code: 'no_trigger',
        message:
          'Nothing starts this workflow on its own. Add at least one trigger to start this workflow. Without one it runs only when another workflow starts it.',
      },
    ]);
    expect(result.document?.triggers).toEqual([]);
  });

  it('still tells the author of an empty new workflow about its triggers', () => {
    const result = validateAutomation({ name: 'New workflow', triggers: [], steps: {} }, setup);
    expect(result.valid).toBe(false);
    expect(result.errors.map((issue) => issue.path)).toEqual(['/start']);
    expect(result.warnings.map((issue) => [issue.path, issue.code])).toEqual([
      ['/triggers', 'no_trigger'],
    ]);
  });

  it('gets no such warning once it has a trigger', () => {
    const result = validateAutomation(
      { ...document, triggers: [{ id: 'created', type: 'contact.created', config: {} }] },
      setup,
    );
    expect(result.warnings).toEqual([]);
  });
});

describe('the automation.run_ended trigger', () => {
  const config = automationTriggerTypes['automation.run_ended'].config;

  it('names the automations, and optionally how their runs ended', () => {
    expect(config.safeParse({ automations: ['DJ sales'] }).success).toBe(true);
    expect(
      config.safeParse({ automations: ['DJ sales'], how: ['stopped', 'removed'] }).success,
    ).toBe(true);
    expect(
      config.safeParse({ automations: ['DJ sales'], stoppedBy: ['message.received'] }).success,
    ).toBe(true);
    // No "any automation": the list is required, and bounded.
    expect(config.safeParse({}).success).toBe(false);
    expect(config.safeParse({ automations: [] }).success).toBe(false);
    expect(
      config.safeParse({ automations: Array.from({ length: 21 }, (_, n) => `aut_${String(n)}`) })
        .success,
    ).toBe(false);
    expect(config.safeParse({ automations: ['DJ sales'], how: [] }).success).toBe(false);
    expect(config.safeParse({ automations: ['DJ sales'], how: ['cancelled'] }).success).toBe(false);
    expect(config.safeParse({ automations: ['DJ sales'], stoppedBy: ['schedule'] }).success).toBe(
      false,
    );
  });

  it('has its automations resolved, and goes elsewhere with them by name', () => {
    const result = validateAutomation(
      ended({ automations: ['dj sales'], stoppedBy: ['message.received'] }, 'New notify'),
      setup,
    );
    expect(result.errors).toEqual([]);
    expect(result.document?.triggers[0]?.config).toEqual({
      automations: ['aut_dj'],
      stoppedBy: ['message.received'],
    });
    const { document: portable } = portableAutomation(ended({ automations: ['aut_dj'] }), setup);
    expect(portable['triggers']).toMatchObject([{ config: { automations: ['DJ sales'] } }]);
  });

  it('is refused where it names an automation the business does not have', () => {
    const result = validateAutomation(ended({ automations: ['DJ sails'] }), setup);
    expect(result.errors).toEqual([
      {
        path: '/triggers/0/config/automations/0',
        code: 'unknown_reference',
        message: 'There\'s no automation "DJ sails".',
        suggestion: 'Did you mean DJ sales?',
      },
    ]);
  });

  it('is refused when stoppedBy is given with a how that leaves stopped out', () => {
    const result = validateAutomation(
      ended({ automations: ['aut_dj'], how: ['completed'], stoppedBy: ['message.received'] }),
      setup,
    );
    expect(result.errors).toEqual([
      {
        path: '/triggers/0/config/stoppedBy',
        code: 'never_matches',
        message:
          'Only a run a stop condition ended has an event that stopped it: add "stopped" to how, or remove stoppedBy.',
      },
    ]);
  });

  it('may not listen for its own runs ending', () => {
    const result = validateAutomation(ended({ automations: ['aut_notify'] }), setup, {
      automationId: 'aut_notify',
    });
    expect(result.errors).toEqual([
      {
        path: '/triggers/0/config/automations/0',
        code: 'automation_loop',
        message: 'This automation would start whenever one of its own runs ended.',
        suggestion: 'Name a different automation, or remove it from this trigger.',
      },
    ]);
  });

  it('is refused when it closes a loop with what the others start and listen for', () => {
    // DJ sales would start when Follow-up ends; Follow-up starts when notify ends (and
    // starts DJ sales by a step), and notify starts when DJ sales ends.
    const result = validateAutomation(ended({ automations: ['Follow-up'] }, 'DJ sales'), setup, {
      automationId: 'aut_dj',
    });
    expect(result.errors).toEqual([
      {
        path: '/triggers/0/config/automations/0',
        code: 'automation_loop',
        message:
          'Starting when "Follow-up" ends would loop: DJ sales → Sales reply: notify → Follow-up → DJ sales.',
        suggestion: 'Name a different automation, or remove it from this trigger.',
      },
    ]);
  });

  it('reads the draft, not what the same automation published before, for its own edges', () => {
    // Notify published "after DJ sales"; its draft now listens for Follow-up instead,
    // which itself starts after notify: that is the loop, and DJ sales is no part of it.
    const result = validateAutomation(ended({ automations: ['aut_follow'] }), setup, {
      automationId: 'aut_notify',
    });
    expect(result.errors.map((issue) => issue.message)).toEqual([
      'Starting when "Follow-up" ends would loop: Sales reply: notify → Follow-up → Sales reply: notify.',
    ]);
  });

  it('counts a step that starts an automation whose end starts this one', () => {
    // Follow-up's draft starts notify by a step; notify's end starts Follow-up.
    const result = validateAutomation(
      {
        name: 'Follow-up',
        triggers: [
          { id: 'ended', type: 'automation.run_ended', config: { automations: ['aut_notify'] } },
        ],
        start: 'go',
        steps: { go: { type: 'automation.run', config: { automation: 'aut_notify' } } },
      },
      setup,
      { automationId: 'aut_follow' },
    );
    expect(result.errors.map((issue) => [issue.path, issue.code])).toEqual([
      ['/triggers/0/config/automations/0', 'automation_loop'],
      ['/steps/go/config/automation', 'automation_loop'],
    ]);
  });

  it('is allowed where nothing leads back', () => {
    const result = validateAutomation(ended({ automations: ['aut_dj'] }, 'Another'), setup, {
      automationId: 'aut_new',
    });
    expect(result.errors).toEqual([]);
  });
});
