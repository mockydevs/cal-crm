// Wait modes: the resume window, a date already passed, a wait for a reply on a channel or
// for a trigger link, a wait for a condition and a wait for an appointment. Shape,
// validation and the published catalog; the engine's side is tested in
// packages/modules/automation.
import { describe, expect, it } from 'vitest';

import {
  automationBranchNames,
  automationStepTypes,
  automationWaitEvents,
} from './automations-catalog.js';
import { automationCatalog, automationDocument } from './automations.js';
import { validateAutomation, type AutomationSetup } from './automations-validate.js';

const setup: AutomationSetup = {
  fields: {
    contact: [
      { key: 'budget', aliases: [], type: 'number', options: [] },
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
  triggerLinks: [{ id: 'tlk_brochure', name: 'Brochure', key: 'brochure' }],
  values: [],
  channels: { email: true, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const created = { id: 'created', type: 'contact.created', config: {} };
const pause = { type: 'wait', config: { duration: 'PT1M' } };
const document = (steps: Record<string, unknown>) => ({
  name: 'Waits',
  triggers: [created],
  start: Object.keys(steps)[0],
  steps,
});
const codes = (result: ReturnType<typeof validateAutomation>) =>
  result.errors.map((issue) => `${issue.path} ${issue.code}`);
const office = { days: ['monday', 'friday'], start: '09:00', end: '17:00' };
const rich = { field: 'contact.budget', operator: 'greater_than', value: 1000 };

describe('the resume window', () => {
  it.each([
    ['wait', { duration: 'P1D' }, 'b'],
    ['wait.until', { field: 'contact.custom.event_date' }, 'b'],
    ['wait.until', { at: '2026-12-01T09:00:00+03:00' }, 'b'],
    ['wait.event', { event: 'message.received', timeout: 'P1D' }, { received: 'b' }],
    ['wait.condition', { if: rich, timeout: 'P1D' }, { met: 'b' }],
    ['wait.appointment', {}, { reached: 'b' }],
  ])('is accepted on %s', (type, config, next) => {
    const result = validateAutomation(
      document({ a: { type, config: { ...config, resumeWindow: office }, next }, b: pause }),
      setup,
    );
    expect(result.errors).toEqual([]);
    expect(result.document?.steps['a']?.config).toMatchObject({ resumeWindow: office });
  });

  it('is not accepted on a step that is not a wait', () => {
    expect(
      automationDocument.safeParse(
        document({ a: { type: 'goto', config: { target: 'a', resumeWindow: office } } }),
      ).success,
    ).toBe(false);
  });

  it('needs a day, known days and 24-hour times', () => {
    const wait = (resumeWindow: unknown) =>
      automationDocument.safeParse(
        document({ a: { type: 'wait', config: { duration: 'P1D', resumeWindow } } }),
      ).success;
    expect(wait(office)).toBe(true);
    expect(wait({ ...office, days: [] })).toBe(false);
    expect(wait({ ...office, days: ['someday'] })).toBe(false);
    expect(wait({ ...office, start: '9am' })).toBe(false);
    expect(wait({ days: ['monday'], start: '09:00' })).toBe(false);
  });

  it('may run past midnight, and is refused when it opens and closes at the same time', () => {
    const wait = (start: string, end: string) =>
      validateAutomation(
        document({
          a: { type: 'wait', config: { duration: 'P1D', resumeWindow: { ...office, start, end } } },
        }),
        setup,
      );
    expect(wait('22:00', '06:00').errors).toEqual([]);
    const never = wait('09:00', '09:00');
    expect(codes(never)).toEqual(['/steps/a/config/resumeWindow/end empty_resume_window']);
    expect(never.errors[0]?.message).toBe(
      'The resume window opens and closes at 09:00, so it is never open.',
    );
  });
});

describe('wait.until with a time already passed', () => {
  it('takes continue or end, on a field and on a fixed moment, and nothing else', () => {
    const until = (config: Record<string, unknown>) =>
      automationDocument.safeParse(document({ a: { type: 'wait.until', config } })).success;
    expect(until({ field: 'contact.custom.event_date', ifPassed: 'end' })).toBe(true);
    expect(until({ at: '2026-12-01T09:00:00Z', ifPassed: 'continue' })).toBe(true);
    expect(until({ at: '2026-12-01T09:00:00Z', ifPassed: 'skip' })).toBe(false);
  });

  it('keeps a document without it exactly as it was', () => {
    const result = validateAutomation(
      document({ a: { type: 'wait.until', config: { field: 'contact.custom.event_date' } } }),
      setup,
    );
    expect(result.document?.steps['a']?.config).toEqual({
      field: 'contact.custom.event_date',
      direction: 'before',
    });
  });
});

describe('wait.event filters', () => {
  const waiting = (config: Record<string, unknown>) =>
    validateAutomation(
      document({
        a: { type: 'wait.event', config: { timeout: 'P1D', ...config }, next: { received: 'b' } },
        b: pause,
      }),
      setup,
    );

  it('waits for every stop event and for a trigger link', () => {
    expect(automationWaitEvents).toContain('message.received');
    expect(automationWaitEvents).toContain('trigger_link.clicked');
    for (const event of automationWaitEvents) expect(waiting({ event }).errors).toEqual([]);
  });

  it('takes a channel with message.received only', () => {
    expect(waiting({ event: 'message.received', channel: 'sms' }).errors).toEqual([]);
    const wrong = waiting({ event: 'tag.added', channel: 'sms' });
    expect(codes(wrong)).toEqual(['/steps/a/config/channel filter_not_for_event']);
    expect(wrong.errors[0]?.message).toBe(
      'A channel can be chosen only when the wait is for message.received.',
    );
    expect(
      automationDocument.safeParse(
        document({
          a: {
            type: 'wait.event',
            config: { event: 'message.received', channel: 'fax', timeout: 'P1D' },
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('takes a trigger link with trigger_link.clicked only, by id or by name', () => {
    const byName = waiting({ event: 'trigger_link.clicked', link: 'Brochure' });
    expect(byName.errors).toEqual([]);
    expect(byName.document?.steps['a']?.config).toMatchObject({ link: 'tlk_brochure' });
    expect(codes(waiting({ event: 'trigger_link.clicked', link: 'Nothing' }))).toEqual([
      '/steps/a/config/link unknown_reference',
    ]);
    expect(codes(waiting({ event: 'message.received', link: 'Brochure' }))).toEqual([
      '/steps/a/config/link filter_not_for_event',
    ]);
  });
});

describe('wait.condition', () => {
  const waiting = (config: Record<string, unknown>, next: unknown = { met: 'b', timed_out: 'c' }) =>
    validateAutomation(
      document({ a: { type: 'wait.condition', config, next }, b: pause, c: pause }),
      setup,
    );

  it('has the branches met and timed_out, and its condition is checked as any other', () => {
    expect(automationBranchNames('wait.condition', {})).toEqual(['met', 'timed_out']);
    const result = waiting({ if: rich, timeout: 'P7D' });
    expect(result.errors).toEqual([]);
    // The field is written by its canonical path, as a condition step's is.
    expect(result.document?.steps['a']?.config).toMatchObject({
      if: { field: 'contact.custom.budget' },
    });
    expect(
      codes(waiting({ if: { field: 'contact.nothing', operator: 'is_set' }, timeout: 'P7D' })),
    ).toEqual(['/steps/a/config/if/field unknown_field']);
  });

  it('needs a condition and a timeout, of at most 365 days', () => {
    const shape = (config: unknown) =>
      automationDocument.safeParse(document({ a: { type: 'wait.condition', config } })).success;
    expect(shape({ if: rich })).toBe(false);
    expect(shape({ timeout: 'P1D' })).toBe(false);
    expect(codes(waiting({ if: rich, timeout: 'P366D' }))).toEqual([
      '/steps/a/config/timeout wait_too_long',
    ]);
  });

  it('refuses a branch it does not have', () => {
    expect(
      automationDocument.safeParse(
        document({
          a: { type: 'wait.condition', config: { if: rich, timeout: 'P1D' }, next: { yes: 'b' } },
          b: pause,
        }),
      ).success,
    ).toBe(false);
  });

  it('counts as the wait a loop must hold', () => {
    const result = validateAutomation(
      document({
        a: {
          type: 'wait.condition',
          config: { if: rich, timeout: 'P1D' },
          next: { timed_out: 'b' },
        },
        b: { type: 'goto', config: { target: 'a' } },
      }),
      setup,
    );
    expect(result.errors).toEqual([]);
  });
});

describe('wait.appointment', () => {
  const waiting = (config: Record<string, unknown>) =>
    validateAutomation(
      document({
        a: {
          type: 'wait.appointment',
          config,
          next: { reached: 'b', passed: 'c', no_appointment: 'c' },
        },
        b: pause,
        c: pause,
      }),
      setup,
    );

  it('has three branches and waits before the start unless told after', () => {
    expect(automationBranchNames('wait.appointment', {})).toEqual([
      'reached',
      'passed',
      'no_appointment',
    ]);
    const result = waiting({ offset: 'PT1H' });
    expect(result.errors).toEqual([]);
    expect(result.document?.steps['a']?.config).toEqual({ offset: 'PT1H', direction: 'before' });
    expect(waiting({ offset: 'P1D', direction: 'after' }).errors).toEqual([]);
    expect(waiting({}).errors).toEqual([]);
  });

  it('refuses an offset longer than a wait may last, and one that is not a duration', () => {
    expect(codes(waiting({ offset: 'P2Y' }))).toEqual(['/steps/a/config/offset wait_too_long']);
    expect(
      automationDocument.safeParse(
        document({ a: { type: 'wait.appointment', config: { offset: '1 hour' } } }),
      ).success,
    ).toBe(false);
  });

  it('counts as the wait a loop must hold', () => {
    const result = validateAutomation(
      document({
        a: { type: 'wait.appointment', config: {}, next: { reached: 'b' } },
        b: { type: 'goto', config: { target: 'a' } },
      }),
      setup,
    );
    expect(result.errors).toEqual([]);
  });
});

describe('the published catalog', () => {
  it('lists the two new waits under timing, with their branches and outputs', () => {
    const steps = automationCatalog().steps;
    const condition = steps.find((each) => each.type === 'wait.condition');
    const appointment = steps.find((each) => each.type === 'wait.appointment');
    expect(condition).toMatchObject({
      group: 'timing',
      label: 'Wait for a condition',
      branches: { kind: 'fixed', names: ['met', 'timed_out'] },
      outputs: [],
    });
    expect(appointment).toMatchObject({
      group: 'timing',
      label: 'Wait for an appointment',
      branches: { kind: 'fixed', names: ['reached', 'passed', 'no_appointment'] },
    });
    expect(appointment?.outputs.map((each) => each.key)).toEqual(['appointmentId', 'startsAt']);
    expect(automationStepTypes['wait.condition'].version).toBe(1);
  });

  it('describes the resume window for whoever writes a document', () => {
    const wait = automationCatalog().steps.find((each) => each.type === 'wait');
    expect(JSON.stringify(wait?.config)).toContain(
      "When the run may go on from this wait: weekdays and hours in the automation's time zone.",
    );
  });
});
