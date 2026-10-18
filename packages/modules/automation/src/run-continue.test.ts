// Continuing a waiting run: which waits a person may end, and how a branch a person chose
// passes the planner, whatever the wait's own resume window says. No database here.
import { automationDocument, type AutomationStep } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { continuableWait } from './run-continue.js';
import { planStep } from './steps.js';

describe('the waits a person may end', () => {
  it.each([
    ['wait', 'time'],
    ['wait.until', 'time'],
    ['wait.event', 'branch'],
    ['wait.condition', 'branch'],
    ['wait.appointment', 'branch'],
    ['goal', undefined],
    ['manual.call', undefined],
    ['webhook.call', undefined],
    ['email.send', undefined],
    [null, undefined],
    [undefined, undefined],
  ])('%s: %s', (type, kind) => {
    expect(continuableWait(type)).toBe(kind);
  });
});

describe('a branch a person chose', () => {
  // A window that is closed at the moment the step is planned: it opens on Wednesdays, and
  // 2026-10-12 is a Monday.
  const resumeWindow = { days: ['wednesday'], start: '09:00', end: '10:00' };
  const steps = automationDocument.parse({
    name: 'Waits',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'reply',
    steps: {
      reply: {
        type: 'wait.event',
        config: { event: 'message.received', timeout: 'P7D', resumeWindow },
        next: { received: 'visit', timed_out: 'named' },
      },
      named: {
        type: 'wait.condition',
        config: {
          if: { field: 'contact.lastName', operator: 'is_set' },
          timeout: 'P7D',
          resumeWindow,
        },
        next: { met: 'visit', timed_out: 'visit' },
      },
      visit: {
        type: 'wait.appointment',
        config: { resumeWindow },
        next: { reached: 'reply', passed: 'reply', no_appointment: 'reply' },
      },
    },
  }).steps;
  const now = new Date('2026-10-12T12:00:00Z');
  const stepAt = (key: string): AutomationStep => {
    const step = steps[key];
    if (step === undefined) throw new Error(`No step ${key}.`);
    return step;
  };
  const plan = (key: string, decided: Record<string, unknown>) =>
    planStep({
      key,
      step: stepAt(key),
      values: {},
      now,
      timeZone: 'UTC',
      enrolmentId: 'e',
      armed: { receivedEventId: null, carry: { decided } },
      appointment: null,
    });
  const chosen = (branch: string) => ({
    branch,
    output: { continuedBy: 'Jane Doe' },
    explanation: `Continued by Jane Doe: the ${branch} branch was taken before the wait was over.`,
  });

  it.each([
    ['reply', 'timed_out', 'named'],
    ['reply', 'received', 'visit'],
    ['named', 'met', 'visit'],
    ['visit', 'reached', 'reply'],
    ['visit', 'no_appointment', 'reply'],
  ])('at %s takes %s at once, though the resume window is closed', (key, branch, next) => {
    expect(plan(key, { ...chosen(branch), continued: true })).toEqual({
      kind: 'next',
      next,
      branch,
      output: { continuedBy: 'Jane Doe' },
      explanation: `Continued by Jane Doe: the ${branch} branch was taken before the wait was over.`,
    });
  });

  it('is what tells it from a branch the wait decided itself, which the window still holds', () => {
    expect(plan('reply', chosen('timed_out'))).toMatchObject({
      kind: 'arm',
      wakeAt: new Date('2026-10-14T09:00:00Z'),
      carry: { decided: { branch: 'timed_out' } },
    });
    // Anything but true is not a person's choice.
    expect(plan('reply', { ...chosen('timed_out'), continued: 'yes' }).kind).toBe('arm');
  });
});
