// Flow control without a database: what the planner decides for a condition with several
// branches, a Go To and a goal step, and what a test run makes of them and of a stop that
// applies only to a reply to the run's messages.
import { automationDocument, automationStep, MAX_STEP_VISITS } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { simulateAutomation, type SimulatedEvent } from './simulate.js';
import { GOAL_WAIT, planStep, type StepInput } from './steps.js';

const now = new Date('2026-10-09T12:00:00Z');
const plan = (input: unknown, values = {}, more: Partial<StepInput> = {}) =>
  planStep({
    key: 'here',
    step: automationStep.parse(input),
    values,
    now,
    timeZone: 'Africa/Nairobi',
    enrolmentId: 'e1',
    ...more,
  });

const budget = (operator: string, value: number) => ({
  field: 'contact.custom.budget',
  operator,
  value,
});
const sized = {
  type: 'condition',
  config: {
    branches: [
      { name: 'large', if: budget('greater_than', 5000) },
      { name: 'medium', if: { any: [budget('greater_than', 1000), budget('equals', 1000)] } },
      { name: 'any_budget', if: { field: 'contact.custom.budget', operator: 'is_set' } },
    ],
  },
  next: { large: 'a', medium: 'b', none: 'd' },
};

describe('a condition with several branches', () => {
  it('takes the first branch that holds, in the order written', () => {
    // 9000 holds for all three; the first wins.
    expect(plan(sized, { 'contact.custom.budget': 9000 })).toEqual({
      kind: 'next',
      next: 'a',
      branch: 'large',
      output: {},
      explanation: 'Branch "large" held (number 1 of 3, tried in order), so it was taken.',
    });
    expect(plan(sized, { 'contact.custom.budget': 1000 })).toMatchObject({
      next: 'b',
      branch: 'medium',
      explanation: 'Branch "medium" held (number 2 of 3, tried in order), so it was taken.',
    });
  });

  it('ends the path on a branch that leads nowhere', () => {
    expect(plan(sized, { 'contact.custom.budget': 5 })).toMatchObject({
      kind: 'next',
      next: null,
      branch: 'any_budget',
    });
  });

  it('takes none when no branch holds', () => {
    expect(plan(sized, {})).toEqual({
      kind: 'next',
      next: 'd',
      branch: 'none',
      output: {},
      explanation: 'None of the 3 branches held, so the none branch was taken.',
    });
    const one = {
      type: 'condition',
      config: { branches: [{ name: 'large', if: budget('greater_than', 5000) }] },
    };
    expect(plan(one, {})).toMatchObject({
      next: null,
      branch: 'none',
      explanation: 'The one branch did not hold, so the none branch was taken.',
    });
  });

  it('decides a two-way condition as it always did', () => {
    const twoWay = {
      type: 'condition',
      config: { if: budget('greater_than', 5000) },
      next: { yes: 'a', no: 'b' },
    };
    expect(plan(twoWay, { 'contact.custom.budget': 9000 })).toEqual({
      kind: 'next',
      next: 'a',
      branch: 'yes',
      output: {},
      explanation: 'The condition was true, so the yes branch was taken.',
    });
    expect(plan(twoWay, {})).toMatchObject({ next: 'b', branch: 'no' });
  });
});

describe('go to', () => {
  it('goes to its target', () => {
    expect(plan({ type: 'goto', config: { target: 'nudge' } })).toEqual({
      kind: 'next',
      next: 'nudge',
      branch: null,
      output: {},
      explanation: 'Went to "nudge".',
    });
  });
});

describe('the goal step', () => {
  const goal = (otherwise?: string) => ({
    type: 'goal',
    config: {
      events: [{ type: 'form.submitted', config: { form: 'frm_1' } }],
      ...(otherwise === undefined ? {} : { otherwise }),
    },
    next: 'thanks',
  });

  it('goes on with the event when the goal brought the run here', () => {
    const met = { eventId: 'evt_1', eventType: 'form.submitted', from: 'wait_2_days' };
    expect(plan(goal('end'), {}, { goal: { met } })).toEqual({
      kind: 'next',
      next: 'thanks',
      branch: null,
      output: { eventId: 'evt_1' },
      explanation:
        'The goal was met (form.submitted), so the run came straight here from "wait_2_days".',
    });
    expect(plan(goal(), {}, { goal: { met: { ...met, from: null } } })).toMatchObject({
      explanation: 'The goal was met (form.submitted), so the run came straight here.',
    });
  });

  it('goes on anyway by default when reached before the goal is met', () => {
    expect(plan(goal())).toEqual({
      kind: 'next',
      next: 'thanks',
      branch: null,
      output: {},
      explanation: 'Reached before the goal was met; this step is set to go on anyway.',
    });
  });

  it('ends the run when set to end', () => {
    expect(plan(goal('end'))).toEqual({
      kind: 'next',
      next: null,
      branch: null,
      output: {},
      explanation: 'Reached before the goal was met; this step is set to end the run here.',
    });
  });

  it('waits at the step when set to wait, for a year at most', () => {
    expect(GOAL_WAIT).toBe('P365D');
    expect(plan(goal('wait'))).toEqual({
      kind: 'arm',
      event: null,
      wakeAt: new Date('2027-10-09T12:00:00Z'),
      explanation: 'Waiting here until the goal is met, or until 2027-10-09T12:00:00.000Z.',
    });
    expect(plan(goal('wait'), {}, { armed: { receivedEventId: 'evt_2' } })).toEqual({
      kind: 'next',
      next: 'thanks',
      branch: null,
      output: { eventId: 'evt_2' },
      explanation: 'The goal was met while the run waited here, so it went on.',
    });
    expect(plan(goal('wait'), {}, { armed: { receivedEventId: null } })).toEqual({
      kind: 'next',
      next: null,
      branch: null,
      output: {},
      explanation: 'The goal was not met in 365 days of waiting here, so the run ended.',
    });
  });

  it('fails rather than wait past the last date that can be kept', () => {
    expect(
      planStep({
        key: 'here',
        step: automationStep.parse(goal('wait')),
        values: {},
        now: new Date(8.64e15),
        timeZone: 'UTC',
        enrolmentId: 'e1',
      }),
    ).toMatchObject({ kind: 'fail', error: 'date_out_of_range' });
  });

  it('lets a run through that has been through it before, whatever it is set to', () => {
    expect(plan(goal('wait'), {}, { goal: { passed: true } })).toEqual({
      kind: 'next',
      next: 'thanks',
      branch: null,
      output: {},
      explanation: 'This run has been through the goal step before, so it went on.',
    });
  });
});

const start = new Date('2026-10-09T09:00:00Z');
const simulate = (
  steps: Record<string, unknown>,
  events: readonly SimulatedEvent[] = [],
  more: Record<string, unknown> = {},
  values = {},
) =>
  simulateAutomation({
    document: automationDocument.parse({
      name: 'Flow',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: Object.keys(steps)[0],
      steps,
      ...more,
    }),
    values,
    events,
    start,
    timeZone: 'Africa/Nairobi',
    enrolmentId: 'test',
  });
const walked = (trace: ReturnType<typeof simulate>) =>
  trace.steps.map((step) => [step.step, step.kind, step.branch ?? null]);
const email = (next?: string) => ({
  type: 'email.send',
  config: { subject: 'Hello', body: 'Hello' },
  ...(next === undefined ? {} : { next }),
});
const wait = (duration: string, next?: string) => ({
  type: 'wait',
  config: { duration },
  ...(next === undefined ? {} : { next }),
});

describe('a test run', () => {
  it('takes a named branch, and none', () => {
    const steps = { size: sized, a: wait('PT1M'), b: wait('PT1M'), d: wait('PT1M') };
    expect(walked(simulate(steps, [], {}, { 'contact.custom.budget': 2000 }))).toEqual([
      ['size', 'branched', 'medium'],
      ['b', 'waited', null],
    ]);
    expect(walked(simulate(steps))).toEqual([
      ['size', 'branched', 'none'],
      ['d', 'waited', null],
    ]);
  });

  it('follows a Go To, and ends a loop at the 200 steps a test run takes', () => {
    const trace = simulate({
      nudge: wait('P1D', 'again'),
      again: { type: 'goto', config: { target: 'nudge' } },
    });
    expect(trace.steps.slice(0, 3).map((step) => [step.step, step.kind])).toEqual([
      ['nudge', 'waited'],
      ['again', 'moved'],
      ['nudge', 'waited'],
    ]);
    expect(trace.steps[1]?.explanation).toBe('Went to "nudge".');
    // A test run's own bound comes first: 200 steps, which is 100 turns of this loop, the
    // same hundred visits a real run allows one step.
    expect(trace.steps.filter((step) => step.step === 'nudge')).toHaveLength(MAX_STEP_VISITS);
    expect(trace.outcome).toEqual({ kind: 'limit', steps: 200 });
  });

  const withGoal = (otherwise: string, stopWhen: unknown[] = []) =>
    [
      {
        first: email('pause'),
        pause: wait('P2D', 'second'),
        second: email('booked'),
        booked: {
          type: 'goal',
          config: {
            events: [
              { type: 'appointment.booked', config: {} },
              { type: 'form.submitted', config: { form: 'frm_1' } },
            ],
            otherwise,
          },
          next: 'thanks',
        },
        thanks: email(),
      },
      { stopWhen },
    ] as const;

  it('moves to the goal step when a goal event falls in a wait, skipping what lay between', () => {
    const [steps, more] = withGoal('continue');
    const trace = simulate(steps, [{ event: 'form.submitted', after: 'P1D' }], more);
    expect(walked(trace)).toEqual([
      ['first', 'would_send', null],
      ['pause', 'waited', null],
      ['booked', 'moved', null],
      ['thanks', 'would_send', null],
    ]);
    expect(trace.steps[2]).toMatchObject({
      at: new Date('2026-10-10T09:00:00Z'),
      explanation: 'The goal was met (form.submitted), so the run came straight here from "pause".',
    });
    expect(trace.outcome).toEqual({ kind: 'completed' });
  });

  it('goes on, or ends, at a goal step reached before the goal is met', () => {
    const [steps, more] = withGoal('continue');
    // An event that is not one of the goal's changes nothing.
    expect(walked(simulate(steps, [{ event: 'tag.added', after: 'P1D' }], more))).toEqual([
      ['first', 'would_send', null],
      ['pause', 'waited', null],
      ['second', 'would_send', null],
      ['booked', 'moved', null],
      ['thanks', 'would_send', null],
    ]);
    const [ending, moreEnding] = withGoal('end');
    const ended = simulate(ending, [], moreEnding);
    expect(walked(ended).at(-1)).toEqual(['booked', 'ended', null]);
    expect(ended.outcome).toEqual({ kind: 'completed' });
  });

  it('waits at the goal step until the goal event, or for a year', () => {
    const [steps, more] = withGoal('wait');
    const met = simulate(steps, [{ event: 'appointment.booked', after: 'P5D' }], more);
    expect(walked(met).slice(3)).toEqual([
      ['booked', 'waited', null],
      ['booked', 'moved', null],
      ['thanks', 'would_send', null],
    ]);
    expect(met.steps[4]?.at).toEqual(new Date('2026-10-14T09:00:00Z'));
    const never = simulate(steps, [], more);
    expect(walked(never).slice(3)).toEqual([
      ['booked', 'waited', null],
      ['booked', 'ended', null],
    ]);
    expect(never.steps[4]?.explanation).toBe(
      'The goal was not met in 365 days of waiting here, so the run ended.',
    );
  });

  it('stops rather than moves when one event is both a stop and the goal', () => {
    const [steps, more] = withGoal('continue', [{ event: 'appointment.booked' }]);
    const trace = simulate(steps, [{ event: 'appointment.booked', after: 'P1D' }], more);
    expect(trace.outcome).toMatchObject({ kind: 'stopped', event: 'appointment.booked' });
    expect(walked(trace)).toEqual([
      ['first', 'would_send', null],
      ['pause', 'waited', null],
    ]);
  });

  it('moves out of a wait for an event, and out of a hold for the sending window', () => {
    const booked = {
      type: 'goal',
      config: { events: [{ type: 'appointment.booked', config: {} }] },
      next: 'thanks',
    };
    const waiting = simulate(
      {
        reply: {
          type: 'wait.event',
          config: { event: 'message.received', timeout: 'P3D' },
          next: { received: 'thanks', timed_out: 'thanks' },
        },
        booked,
        thanks: wait('PT1M'),
      },
      [
        { event: 'appointment.booked', after: 'P1D' },
        { event: 'message.received', after: 'P2D' },
      ],
    );
    expect(walked(waiting)).toEqual([
      ['reply', 'waited', null],
      ['booked', 'moved', null],
      ['thanks', 'waited', null],
    ]);
    expect(waiting.steps[1]?.explanation).toBe(
      'The goal was met (appointment.booked), so the run came straight here from "reply".',
    );
    // 2026-10-09 is a Friday: a message reached then waits for Monday's window, and the
    // booking on Saturday takes the run out of that hold before anything is sent.
    const held = simulate(
      { send: email('booked'), booked, thanks: wait('PT1M') },
      [{ event: 'appointment.booked', after: 'P1D' }],
      { settings: { sendingWindow: { days: ['monday'], start: '09:00', end: '17:00' } } },
    );
    expect(walked(held)).toEqual([
      ['send', 'waited', null],
      ['booked', 'moved', null],
      ['thanks', 'waited', null],
    ]);
  });

  it('stops a run waiting at the goal step when a stop condition is met there', () => {
    const [steps] = withGoal('wait');
    const trace = simulate(steps, [{ event: 'message.received', after: 'P4D' }], {
      stopWhen: [{ event: 'message.received' }],
    });
    expect(trace.outcome).toMatchObject({ kind: 'stopped', event: 'message.received' });
    expect(walked(trace).at(-1)).toEqual(['booked', 'waited', null]);
  });

  it('does not listen for the goal again once the run has been through the step', () => {
    const trace = simulate(
      {
        booked: {
          type: 'goal',
          config: { events: [{ type: 'appointment.booked', config: {} }] },
          next: 'pause',
        },
        pause: wait('P2D', 'after'),
        after: email(),
      },
      [{ event: 'appointment.booked', after: 'P1D' }],
    );
    expect(walked(trace)).toEqual([
      ['booked', 'moved', null],
      ['pause', 'waited', null],
      ['after', 'would_send', null],
    ]);
  });

  const narrow = { stopWhen: [{ event: 'message.received', repliedTo: 'this_run' }] };

  it('stops on a reply only once the run has sent a message, when the stop says so', () => {
    const steps = { pause: wait('P2D', 'send'), send: email('later'), later: wait('P2D') };
    // A message before the run has written is no reply to it.
    const early = simulate(steps, [{ event: 'message.received', after: 'P1D' }], narrow);
    expect(early.outcome).toEqual({ kind: 'completed' });
    const late = simulate(steps, [{ event: 'message.received', after: 'P3D' }], narrow);
    expect(late.outcome).toEqual({
      kind: 'stopped',
      event: 'message.received',
      at: new Date('2026-10-12T09:00:00Z'),
    });
    // Without the choice, any message stops it, as before.
    const wide = { stopWhen: [{ event: 'message.received' }] };
    expect(
      simulate(steps, [{ event: 'message.received', after: 'P1D' }], wide).outcome,
    ).toMatchObject({ kind: 'stopped' });
  });
});
