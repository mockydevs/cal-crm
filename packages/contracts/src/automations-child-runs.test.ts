// Starting and ending automations from an automation: what the catalog offers, and what the
// validator refuses before anything is published.
import { describe, expect, it } from 'vitest';

import { automationStepTypes } from './automations-catalog.js';
import { automationCatalog, automationDocument } from './automations.js';
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
    { id: 'aut_sales', name: 'Sales sequence', starts: [] },
    { id: 'aut_education', name: 'Education', starts: [] },
    { id: 'aut_booked', name: 'Consultation booked', starts: ['aut_pre'] },
    { id: 'aut_pre', name: 'Pre-consultation', starts: ['aut_reminder'] },
    { id: 'aut_reminder', name: 'Reminder', starts: [] },
  ],
  values: [],
  channels: { email: false, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const document = (steps: Record<string, unknown>, start: string) => ({
  name: 'Consultation booked',
  triggers: [{ id: 'booked', type: 'appointment.booked', config: {} }],
  start,
  steps,
});

describe('the catalog', () => {
  const catalog = automationCatalog();
  const step = (type: string) => catalog.steps.find((each) => each.type === type);

  it('says what starting another automation gives later steps', () => {
    expect(step('automation.run')?.outputs.map((output) => [output.key, output.type])).toEqual([
      ['enrolmentId', 'id'],
      ['outcome', 'string'],
    ]);
    expect(step('automation.run')?.branches).toEqual({ kind: 'none' });
  });

  it('offers removing a contact from automations, with how many it removed', () => {
    expect(step('automation.remove')).toMatchObject({
      group: 'connect',
      version: 1,
      label: 'Remove from automations',
      branches: { kind: 'none' },
      outputs: [{ key: 'removed', type: 'number' }],
    });
  });

  it('takes the four ways to remove, and an except list only where it means something', () => {
    const config = automationStepTypes['automation.remove'].config;
    const many = Array.from({ length: 21 }, (_, index) => `aut_${String(index)}`);
    expect(config.safeParse({ from: 'current' }).success).toBe(true);
    expect(config.safeParse({ from: 'automations', automations: ['Sales'] }).success).toBe(true);
    expect(config.safeParse({ from: 'all_others' }).success).toBe(true);
    expect(config.safeParse({ from: 'all_others', except: ['Education'] }).success).toBe(true);
    expect(config.safeParse({ from: 'all', except: ['Education'] }).success).toBe(true);
    expect(config.safeParse({ from: 'all' }).success).toBe(true);
    // Nothing to remove, too many, or a list where none belongs.
    expect(config.safeParse({ from: 'automations', automations: [] }).success).toBe(false);
    expect(config.safeParse({ from: 'automations' }).success).toBe(false);
    expect(config.safeParse({ from: 'automations', automations: many }).success).toBe(false);
    expect(config.safeParse({ from: 'all', except: many }).success).toBe(false);
    expect(config.safeParse({ from: 'current', except: ['Education'] }).success).toBe(false);
    expect(config.safeParse({ from: 'all', automations: ['Sales'] }).success).toBe(false);
    expect(config.safeParse({ from: 'everything' }).success).toBe(false);
    expect(config.safeParse({}).success).toBe(false);
  });

  it("lets a team notification go to the owner, or to everyone when there isn't one", () => {
    const config = automationStepTypes['team.notify'].config;
    expect(config.parse({ message: 'Hi', to: 'owner_or_everyone' })).toEqual({
      message: 'Hi',
      to: 'owner_or_everyone',
    });
    // What a step without `to` means has not changed.
    expect(config.parse({ message: 'Hi' })).toEqual({ message: 'Hi', to: 'contact_owner' });
    expect(config.safeParse({ message: 'Hi', to: 'nobody' }).success).toBe(false);
  });

  it('keeps a removal step in the document as written', () => {
    const parsed = automationDocument.parse(
      document(
        { clear: { type: 'automation.remove', config: { from: 'all_others' }, next: 'go' }, go },
        'clear',
      ),
    );
    expect(parsed.steps['clear']).toEqual({
      type: 'automation.remove',
      config: { from: 'all_others' },
      next: 'go',
    });
  });
});

const go = { type: 'automation.run', config: { automation: 'Pre-consultation' } };

describe('the validator', () => {
  it('resolves every automation a removal names, in both lists', () => {
    const result = validateAutomation(
      document(
        {
          sales: {
            type: 'automation.remove',
            config: { from: 'automations', automations: ['sales sequence', 'aut_reminder'] },
            next: 'rest',
          },
          rest: {
            type: 'automation.remove',
            config: { from: 'all_others', except: ['Education'] },
            next: 'go',
          },
          go,
        },
        'sales',
      ),
      setup,
    );
    expect(result.errors).toEqual([]);
    expect(result.document?.steps['sales']?.config).toEqual({
      from: 'automations',
      automations: ['aut_sales', 'aut_reminder'],
    });
    expect(result.document?.steps['rest']?.config).toEqual({
      from: 'all_others',
      except: ['aut_education'],
    });
    expect(result.document?.steps['rest']?.typeVersion).toBe(1);
    expect(result.document?.steps['go']?.config).toEqual({ automation: 'aut_pre' });
  });

  it('refuses a removal that names an automation the business does not have, where it is named', () => {
    const result = validateAutomation(
      document(
        {
          clear: {
            type: 'automation.remove',
            config: { from: 'all', except: ['Education', 'Educaton'] },
          },
        },
        'clear',
      ),
      setup,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: '/steps/clear/config/except/1',
        code: 'unknown_reference',
        message: 'There\'s no automation "Educaton".',
        suggestion: 'Did you mean Education?',
      },
    ]);
  });

  it('refuses an automation that starts itself', () => {
    const result = validateAutomation(
      document(
        { again: { type: 'automation.run', config: { automation: 'aut_booked' } } },
        'again',
      ),
      setup,
      { automationId: 'aut_booked' },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: '/steps/again/config/automation',
        code: 'automation_loop',
        message: 'This automation would start itself.',
        suggestion: 'Start a different automation, or remove this step.',
      },
    ]);
  });

  it('refuses a start that closes a loop through published automations, and names the loop', () => {
    // Reminder is being changed to start Consultation booked, which already leads to it.
    const result = validateAutomation(
      {
        ...document(
          { back: { type: 'automation.run', config: { automation: 'Consultation booked' } } },
          'back',
        ),
        name: 'Reminder',
      },
      setup,
      { automationId: 'aut_reminder' },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: '/steps/back/config/automation',
        code: 'automation_loop',
        message:
          'Starting "Consultation booked" would loop: Reminder → Consultation booked → Pre-consultation → Reminder.',
        suggestion: 'Start a different automation, or remove this step.',
      },
    ]);
  });

  it('allows a start that leads nowhere back, however the others are chained', () => {
    const result = validateAutomation(
      document({ go, then: { type: 'automation.run', config: { automation: 'Education' } } }, 'go'),
      {
        ...setup,
        automations: [
          ...setup.automations,
          // Two others that loop between themselves are not this document's loop.
          { id: 'aut_a', name: 'A', starts: ['aut_b'] },
          { id: 'aut_b', name: 'B', starts: ['aut_a', 'aut_gone'] },
        ],
      },
      { automationId: 'aut_booked' },
    );
    // `then` is unreachable, which is the only thing wrong here.
    expect(result.errors.map((issue) => issue.code)).toEqual(['unreachable_step']);
  });

  it('checks no loop when it is not told which automation the document is', () => {
    const result = validateAutomation(
      document(
        { again: { type: 'automation.run', config: { automation: 'aut_booked' } } },
        'again',
      ),
      setup,
    );
    expect(result.errors).toEqual([]);
  });

  it('reads a setup that lists no starts as one where nothing starts anything', () => {
    const result = validateAutomation(
      document({ go }, 'go'),
      { ...setup, automations: [{ id: 'aut_pre', name: 'Pre-consultation' }] },
      { automationId: 'aut_booked' },
    );
    expect(result.errors).toEqual([]);
  });
});

describe('a document for another business', () => {
  it('names every automation a removal lists', () => {
    const { document: portable, warnings } = portableAutomation(
      document(
        {
          clear: {
            type: 'automation.remove',
            config: { from: 'all_others', except: ['aut_education', 'aut_unknown'] },
            next: 'only',
          },
          only: {
            type: 'automation.remove',
            config: { from: 'automations', automations: ['aut_sales'] },
          },
        },
        'clear',
      ),
      setup,
    );
    expect(portable['steps']).toMatchObject({
      clear: { config: { from: 'all_others', except: ['Education', 'aut_unknown'] } },
      only: { config: { from: 'automations', automations: ['Sales sequence'] } },
    });
    expect(warnings).toEqual([
      {
        path: '/steps/clear/config/except/1',
        code: 'not_portable',
        message: 'There\'s no automation "aut_unknown" to name.',
      },
    ]);
  });
});
