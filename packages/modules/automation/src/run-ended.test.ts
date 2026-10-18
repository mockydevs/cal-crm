// Which run-ended events pass an automation.run_ended trigger.
import { automationTrigger } from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { eventPassesTrigger, TRIGGER_EVENTS } from './triggers.js';

const sales = '0192f3a0-1111-7222-8333-444455556666';
const other = '0192f3a0-1111-7222-8333-444455557777';
const salesId = toPublicId('automation', sales);

const trigger = (config: Record<string, unknown>) =>
  automationTrigger.parse({
    id: 'ended',
    type: 'automation.run_ended',
    config: { automations: [salesId], ...config },
  });

const stopped = (reason: string, automationId = salesId) =>
  ['automation.run.stopped', { automationId, reason }] as const;
const completed = ['automation.run.completed', { automationId: salesId }] as const;
const failed = [
  'automation.run.failed',
  { automationId: salesId, reason: 'missing_values' },
] as const;

describe('the automation.run_ended trigger', () => {
  it('listens for every event a run ends with', () => {
    expect(TRIGGER_EVENTS['automation.run_ended'].events).toEqual([
      'automation.run.stopped',
      'automation.run.completed',
      'automation.run.failed',
    ]);
  });

  it('passes any ending of an automation it names, and none of another', () => {
    const any = trigger({});
    for (const [type, payload] of [
      stopped('stop:message.received'),
      stopped('removed:aut_x'),
      completed,
      failed,
    ])
      expect(eventPassesTrigger(any, type, payload), type).toBe(true);
    expect(eventPassesTrigger(any, ...stopped('stop:message.received', other))).toBe(false);
    expect(eventPassesTrigger(any, 'automation.run.stopped', {})).toBe(false);
    expect(eventPassesTrigger(any, 'message.received', { automationId: salesId })).toBe(false);
    // The automation as its stored id, as an older document might hold it.
    const stored = automationTrigger.parse({
      id: 'ended',
      type: 'automation.run_ended',
      config: { automations: [sales] },
    });
    expect(eventPassesTrigger(stored, ...completed)).toBe(true);
  });

  it.each([
    ['stopped', [true, false, false, false]],
    ['removed', [false, true, false, false]],
    ['completed', [false, false, true, false]],
    ['failed', [false, false, false, true]],
  ] as const)('with how %s passes only that ending', (how, expected) => {
    const only = trigger({ how: [how] });
    expect(
      [stopped('stop:tag.added'), stopped('removed:aut_x'), completed, failed].map(
        ([type, payload]) => eventPassesTrigger(only, type, payload),
      ),
    ).toEqual(expected);
  });

  it('with several ways passes each of them', () => {
    const either = trigger({ how: ['removed', 'failed'] });
    expect(eventPassesTrigger(either, ...stopped('removed:aut_x'))).toBe(true);
    expect(eventPassesTrigger(either, ...failed)).toBe(true);
    expect(eventPassesTrigger(either, ...completed)).toBe(false);
  });

  it('with stoppedBy passes only a run stopped by one of those events', () => {
    const replied = trigger({ stoppedBy: ['message.received'] });
    expect(eventPassesTrigger(replied, ...stopped('stop:message.received'))).toBe(true);
    expect(eventPassesTrigger(replied, ...stopped('stop:appointment.booked'))).toBe(false);
    expect(eventPassesTrigger(replied, ...stopped('removed:aut_x'))).toBe(false);
    expect(eventPassesTrigger(replied, ...completed)).toBe(false);
    expect(eventPassesTrigger(replied, 'automation.run.stopped', { automationId: salesId })).toBe(
      false,
    );
    // Beside other ways of ending, stoppedBy narrows the stopped ones only.
    const repliedOrDone = trigger({
      how: ['stopped', 'completed'],
      stoppedBy: ['message.received'],
    });
    expect(eventPassesTrigger(repliedOrDone, ...completed)).toBe(true);
    expect(eventPassesTrigger(repliedOrDone, ...stopped('stop:message.received'))).toBe(true);
    expect(eventPassesTrigger(repliedOrDone, ...stopped('stop:tag.added'))).toBe(false);
    expect(eventPassesTrigger(repliedOrDone, ...failed)).toBe(false);
  });
});
