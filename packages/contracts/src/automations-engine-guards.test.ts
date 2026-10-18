// The validator's side of the engine guards: a loop must wait an hour each time round, a
// workflow is told when its own change is what its trigger listens for, and when its
// changes start another workflow whose changes start it again. And conditions judge a date
// with no time of day as that day in the run's zone.
import { describe, expect, it } from 'vitest';

import { LOOP_MIN_WAIT, LOOP_MIN_WAIT_MS } from './automations-catalog.js';
import { evaluateCondition } from './automations-evaluate.js';
import { automationTouches, touchWords, triggerListens } from './automations-touches.js';
import { automationDocument } from './automations.js';
import { minDurationMs, validateAutomation, type AutomationSetup } from './automations-validate.js';

const setup: AutomationSetup = {
  fields: {
    contact: [
      { key: 'touches', aliases: [], type: 'number', options: [] },
      { key: 'score', aliases: [], type: 'number', options: [] },
      { key: 'event_date', aliases: [], type: 'date', options: [] },
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

const note = { type: 'note.create', config: { text: 'Nudge' } };
const codes = (result: { errors: readonly { code: string }[] }) =>
  result.errors.map((issue) => issue.code);
const warnings = (result: { warnings: readonly { code: string }[] }) =>
  result.warnings.map((issue) => issue.code);

const loop = (wait: Record<string, unknown>) => ({
  name: 'Nudge loop',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'nudge',
  steps: {
    nudge: { ...note, next: 'pause' },
    pause: { next: 'again', ...wait },
    again: { type: 'goto', config: { target: 'nudge' } },
  },
});

describe('a loop waits an hour each time round', () => {
  it('states the least wait', () => {
    expect(LOOP_MIN_WAIT).toBe('PT1H');
    expect(LOOP_MIN_WAIT_MS).toBe(3_600_000);
  });

  it.each([
    { type: 'wait', config: { duration: 'PT0S' } },
    { type: 'wait', config: { duration: 'PT59M' } },
    { type: 'wait.until', config: { at: '2020-01-01T00:00:00Z' } },
    {
      type: 'wait.condition',
      config: { if: { field: 'contact.custom.score', operator: 'is_set' }, timeout: 'PT5M' },
      next: { met: 'again', timed_out: 'again' },
    },
    {
      type: 'wait.event',
      config: { event: 'message.received', timeout: 'PT10M' },
      next: { received: 'again', timed_out: 'again' },
    },
  ])('refuses a loop whose wait can end sooner: $type $config', (wait) => {
    expect(codes(validateAutomation(loop(wait), setup))).toEqual(['loop_wait_too_short']);
  });

  it.each([
    { type: 'wait', config: { duration: 'PT1H' } },
    { type: 'wait', config: { duration: 'P1M' } },
    { type: 'wait.until', config: { field: 'contact.custom.event_date' } },
    {
      type: 'wait.condition',
      config: { if: { field: 'contact.custom.score', operator: 'is_set' }, timeout: 'P1D' },
      next: { met: 'again', timed_out: 'again' },
    },
    {
      type: 'wait.event',
      config: { event: 'message.received', timeout: 'PT1H' },
      next: { received: 'again', timed_out: 'again' },
    },
    {
      type: 'wait.appointment',
      config: {},
      next: { reached: 'again', passed: 'again', no_appointment: 'again' },
    },
  ])('takes a loop that waits an hour or more: $type', (wait) => {
    expect(codes(validateAutomation(loop(wait), setup))).toEqual([]);
  });

  it('reads the least a duration can last', () => {
    expect(minDurationMs('PT1H')).toBe(3_600_000);
    expect(minDurationMs('P1Y1M1W1DT1H1M1S')).toBe(
      (((365 + 28 + 7 + 1) * 24 + 1) * 60 + 1) * 60_000 + 1000,
    );
    expect(minDurationMs('soon')).toBe(0);
  });
});

const counting = (reEnrollment: 'never' | 'after_finished') => ({
  name: 'Count touches',
  triggers: [{ id: 'changed', type: 'field.changed', config: { field: 'contact.custom.touches' } }],
  start: 'bump',
  steps: {
    bump: {
      type: 'contact.update',
      config: {
        fields: {
          'contact.custom.touches': {
            set: { op: 'math', left: 'contact.custom.touches', operator: '+', right: 1 },
          },
        },
      },
      next: 'tag',
    },
    tag: { type: 'tag.add', config: { tag: 'VIP' } },
  },
  settings: { reEnrollment },
});

describe('a step that changes what the trigger listens for', () => {
  it('is told, when a record may go through again', () => {
    const result = validateAutomation(counting('after_finished'), setup);
    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual({
      path: '/triggers/0',
      code: 'self_trigger',
      message: expect.stringContaining('changes contact.custom.touches') as string,
    });
  });

  it('is not, when the workflow takes a record once', () => {
    expect(warnings(validateAutomation(counting('never'), setup))).not.toContain('self_trigger');
  });
});

describe('workflows whose changes start each other', () => {
  const pingPong = (writes: string) => ({
    name: 'A',
    triggers: [{ id: 'changed', type: 'field.changed', config: { field: 'contact.custom.score' } }],
    start: 'bump',
    steps: {
      bump: { type: 'contact.update', config: { fields: { [writes]: '1' } } },
    },
    settings: { reEnrollment: 'after_finished' },
  });
  const others: AutomationSetup['automations'] = [
    { id: 'aut_a', name: 'A' },
    {
      id: 'aut_b',
      name: 'B',
      listens: ['field:contact.custom.touches'],
      writes: ['tag_added:tag_vip'],
    },
    {
      id: 'aut_c',
      name: 'C',
      listens: ['tag_added:tag_vip'],
      writes: ['field:contact.custom.score'],
    },
    { id: 'aut_d', name: 'D', listens: ['field:contact.custom.score'] },
  ];

  it('are told, with the way round', () => {
    const result = validateAutomation(
      pingPong('contact.custom.touches'),
      { ...setup, automations: others },
      { automationId: 'aut_a' },
    );
    expect(result.warnings).toContainEqual({
      path: '/triggers/0',
      code: 'automation_loop',
      message: expect.stringContaining('A → B → C → A') as string,
    });
  });

  it('are not, when no way leads back', () => {
    const result = validateAutomation(
      pingPong('contact.custom.event_date'),
      { ...setup, automations: others },
      { automationId: 'aut_a' },
    );
    expect(warnings(result)).not.toContain('automation_loop');
    // A new workflow has no id yet: no other workflow can name it.
    expect(warnings(validateAutomation(pingPong('contact.custom.touches'), setup))).not.toContain(
      'automation_loop',
    );
  });
});

describe('what a workflow listens for and changes', () => {
  it('reads field changes and tags', () => {
    const document = automationDocument.parse({
      name: 'Tags',
      triggers: [
        { id: 'a', type: 'tag.added', config: { tag: 'tag_vip' } },
        { id: 'r', type: 'tag.removed', config: { tag: 'tag_vip' } },
        { id: 'c', type: 'contact.created', config: {} },
      ],
      start: 'remove',
      steps: { remove: { type: 'tag.remove', config: { tag: 'tag_vip' } } },
    });
    expect(automationTouches(document)).toEqual({
      listens: ['tag_added:tag_vip', 'tag_removed:tag_vip'],
      writes: ['tag_removed:tag_vip'],
    });
    expect(triggerListens(document.triggers[2] as never)).toBeUndefined();
  });

  it('says a key in words', () => {
    expect(touchWords('tag_added:tag_vip', () => 'VIP')).toBe('adds the tag VIP');
    expect(touchWords('tag_removed:tag_vip')).toBe('removes the tag tag_vip');
    expect(touchWords('field:contact.custom.score')).toBe('changes contact.custom.score');
  });
});

describe('a date with no time of day in a condition', () => {
  // Saturday 31 October 2026, 23:00 in New York.
  const now = new Date('2026-11-01T03:00:00Z');
  const zone = 'America/New_York';
  const holds = (operator: string, value: string, field: string) =>
    evaluateCondition(
      { field: 'contact.custom.event_date', operator, value } as never,
      { 'contact.custom.event_date': field },
      now,
      zone,
    );

  it('is that day in the run zone', () => {
    expect(holds('within_next', 'P1D', '2026-11-01')).toBe(true);
    expect(holds('within_last', 'P1D', '2026-10-31')).toBe(true);
    expect(holds('after', '2026-10-31T23:30:00-04:00', '2026-11-01')).toBe(true);
    expect(holds('after', '2026-10-31', '2026-11-01')).toBe(true);
    expect(holds('before', '2026-11-02', '2026-11-01')).toBe(true);
    expect(holds('greater_than', '2026-10-31', '2026-11-01')).toBe(true);
    expect(holds('less_than', '2026-10-31', '2026-11-01')).toBe(false);
    // A day is neither before nor after a time inside it.
    expect(holds('before', '2026-11-01T12:00:00-05:00', '2026-11-01')).toBe(false);
    expect(holds('after', '2026-11-01T12:00:00-05:00', '2026-11-01')).toBe(false);
    expect(holds('within_next', 'P1D', '2026-11-03')).toBe(false);
  });

  it('is midnight UTC without a zone, as it always was', () => {
    expect(
      evaluateCondition(
        { field: 'contact.custom.event_date', operator: 'within_next', value: 'P1D' } as never,
        { 'contact.custom.event_date': '2026-11-01' },
        now,
      ),
    ).toBe(false);
  });

  it('falls back to the instant when the zone is not one', () => {
    expect(
      evaluateCondition(
        { field: 'contact.custom.event_date', operator: 'after', value: '2026-10-31' } as never,
        { 'contact.custom.event_date': '2026-11-01' },
        now,
        'Not/A_Zone',
      ),
    ).toBe(true);
  });
});
