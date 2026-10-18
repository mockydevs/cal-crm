// Wait modes, planned: the resume window on every wait, a date already passed, a wait for a
// condition and a wait for an appointment. Every moment is a fixed date, so nothing depends
// on when the test runs.
import { automationDocument, automationStep, type AutomationStep } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { simulateAutomation } from './simulate.js';
import { planStep, type StepInput } from './steps.js';

const at = (iso: string) => new Date(iso);
const step = (input: unknown): AutomationStep => automationStep.parse(input);
// 2026-10-09 is a Friday; Nairobi is three hours ahead of UTC all year.
const friday = at('2026-10-09T12:00:00Z');
const plan = (input: unknown, more: Partial<StepInput> = {}) =>
  planStep({
    key: 'here',
    step: step(input),
    values: {},
    now: friday,
    timeZone: 'Africa/Nairobi',
    enrolmentId: 'e1',
    ...more,
  });

const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const office = { days: weekdays, start: '09:00', end: '17:00' };
const officeWords = 'monday, tuesday, wednesday, thursday, friday, 09:00 to 17:00, Africa/Nairobi';

describe('the resume window on a wait for a length of time', () => {
  it('leaves a wait alone that ends while the window is open', () => {
    // Friday 15:00 Nairobi plus three days is Monday 15:00: open.
    expect(
      plan({ type: 'wait', config: { duration: 'P3D', resumeWindow: office }, next: 'later' }),
    ).toEqual({
      kind: 'wait',
      wakeAt: at('2026-10-12T12:00:00Z'),
      next: 'later',
      explanation: 'Waiting 3 days, until 2026-10-12T12:00:00.000Z.',
    });
  });

  it('moves a wait that ends at the weekend to Monday morning', () => {
    expect(
      plan({ type: 'wait', config: { duration: 'P1D', resumeWindow: office }, next: 'later' }),
    ).toEqual({
      kind: 'wait',
      wakeAt: at('2026-10-12T06:00:00Z'),
      next: 'later',
      explanation: `Waiting 1 day, until 2026-10-10T12:00:00.000Z; the resume window (${officeWords}) is closed then, so it goes on at 2026-10-12T06:00:00.000Z.`,
    });
  });

  it('moves a wait that ends after hours to the next morning', () => {
    expect(
      plan({ type: 'wait', config: { duration: 'PT3H', resumeWindow: office } }),
    ).toMatchObject({ kind: 'wait', wakeAt: at('2026-10-12T06:00:00Z') });
  });

  it('opens at the hour the clocks skip, moved forward, and at the first of an hour that comes twice', () => {
    const night = { days: ['sunday'], start: '02:30', end: '04:00' };
    // New York: 02:30 on 2026-03-08 does not exist (it becomes 03:30 EDT, 07:30 UTC).
    expect(
      plan(
        { type: 'wait', config: { duration: 'PT1H', resumeWindow: night } },
        { now: at('2026-03-07T12:00:00Z'), timeZone: 'America/New_York' },
      ),
    ).toMatchObject({ wakeAt: at('2026-03-08T07:30:00Z') });
    // 01:30 on 2026-11-01 comes twice; the first is EDT (05:30 UTC).
    expect(
      plan(
        {
          type: 'wait',
          config: { duration: 'PT1H', resumeWindow: { ...night, start: '01:30' } },
        },
        { now: at('2026-10-31T12:00:00Z'), timeZone: 'America/New_York' },
      ),
    ).toMatchObject({ wakeAt: at('2026-11-01T05:30:00Z') });
  });

  it('fails when the zone is not one, or the window can never open', () => {
    expect(
      plan(
        { type: 'wait', config: { duration: 'P1D', resumeWindow: office } },
        { timeZone: 'Mars/Olympus' },
      ),
    ).toEqual({
      kind: 'fail',
      error: 'invalid_time_zone',
      explanation: 'Mars/Olympus is not a time zone.',
    });
    expect(
      plan({
        type: 'wait',
        config: { duration: 'P1D', resumeWindow: { ...office, end: '09:00' } },
      }),
    ).toEqual({
      kind: 'fail',
      error: 'invalid_resume_window',
      explanation: 'The resume window (09:00 to 09:00) never opens.',
    });
  });
});

describe('wait.until', () => {
  const until = (config: Record<string, unknown>) => ({
    type: 'wait.until',
    config: { at: '2026-10-10T09:00:00Z', ...config },
    next: 'later',
  });

  it('moves a moment outside the resume window to the next opening', () => {
    expect(plan(until({ resumeWindow: office }))).toEqual({
      kind: 'wait',
      wakeAt: at('2026-10-12T06:00:00Z'),
      next: 'later',
      explanation: `Waiting until 2026-10-10T09:00:00.000Z; the resume window (${officeWords}) is closed then, so it goes on at 2026-10-12T06:00:00.000Z.`,
    });
  });

  it('goes on at once when its time has passed, as before, or ends the run when told to', () => {
    const passed = { now: at('2026-10-12T08:00:00Z') };
    expect(plan(until({}), passed)).toEqual({
      kind: 'next',
      next: 'later',
      branch: null,
      output: {},
      explanation: '2026-10-10T09:00:00.000Z has passed, so it went on at once.',
    });
    expect(plan(until({ ifPassed: 'continue' }), passed)).toMatchObject({ next: 'later' });
    expect(plan(until({ ifPassed: 'end' }), passed)).toEqual({
      kind: 'next',
      next: null,
      branch: null,
      output: {},
      explanation: '2026-10-10T09:00:00.000Z has passed, and this step is set to end the run then.',
    });
    // Not passed, the choice changes nothing.
    expect(plan(until({ ifPassed: 'end' }))).toMatchObject({
      kind: 'wait',
      wakeAt: at('2026-10-10T09:00:00Z'),
    });
  });

  it('holds a time that has passed until the window opens', () => {
    // Saturday: the moment has passed and the window is closed.
    expect(plan(until({ resumeWindow: office }), { now: at('2026-10-10T10:00:00Z') })).toEqual({
      kind: 'wait',
      wakeAt: at('2026-10-12T06:00:00Z'),
      next: 'later',
      explanation: `2026-10-10T09:00:00.000Z has passed; the resume window (${officeWords}) is closed, so it goes on at 2026-10-12T06:00:00.000Z.`,
    });
    // A field with a date already passed ends the run when told to.
    expect(
      plan(
        {
          type: 'wait.until',
          config: { field: 'contact.custom.event_date', ifPassed: 'end' },
          next: 'later',
        },
        { values: { 'contact.custom.event_date': '2026-10-01' } },
      ),
    ).toMatchObject({ kind: 'next', next: null });
  });
});

describe('wait.event with a resume window', () => {
  const reply = {
    type: 'wait.event',
    config: { event: 'message.received', timeout: 'P3D', resumeWindow: office },
    next: { received: 'thanks', timed_out: 'nudge' },
  };
  const saturday = at('2026-10-10T10:00:00Z');
  const held = {
    branch: 'received',
    output: { eventId: 'event-1' },
    explanation: 'message.received arrived, so the received branch was taken.',
  };

  it('takes its branch at once when the event arrives inside the window', () => {
    expect(plan(reply, { armed: { receivedEventId: 'event-1' } })).toEqual({
      kind: 'next',
      next: 'thanks',
      ...held,
    });
  });

  it('keeps what was decided and sleeps until the opening when the event arrives outside it', () => {
    expect(plan(reply, { now: saturday, armed: { receivedEventId: 'event-1' } })).toEqual({
      kind: 'arm',
      wakeAt: at('2026-10-12T06:00:00Z'),
      event: null,
      again: true,
      carry: { decided: held },
      explanation: `It would go on now (received), but the resume window (${officeWords}) is closed, so it goes on at 2026-10-12T06:00:00.000Z.`,
    });
  });

  it('goes on with what was decided once the window is open, and waits again if it is not', () => {
    const woken = (now: Date) =>
      plan(reply, { now, armed: { receivedEventId: null, carry: { decided: held } } });
    expect(woken(at('2026-10-12T06:00:00Z'))).toEqual({ kind: 'next', next: 'thanks', ...held });
    // Woken late, after the window closed again: Monday evening waits for Tuesday.
    expect(woken(at('2026-10-12T15:00:00Z'))).toMatchObject({
      kind: 'arm',
      wakeAt: at('2026-10-13T06:00:00Z'),
      carry: { decided: held },
    });
  });

  it('holds a timeout outside the window too', () => {
    expect(plan(reply, { now: saturday, armed: { receivedEventId: null } })).toMatchObject({
      kind: 'arm',
      wakeAt: at('2026-10-12T06:00:00Z'),
      carry: { decided: { branch: 'timed_out', output: {} } },
    });
  });

  it('ignores a kept decision that is not one', () => {
    expect(
      plan(reply, { armed: { receivedEventId: null, carry: { decided: { branch: 7 } } } }),
    ).toMatchObject({ kind: 'next', branch: 'timed_out' });
  });
});

describe('wait.condition', () => {
  const vip = { field: 'contact.tags', operator: 'includes', value: 'VIP' };
  const waiting = (more: Record<string, unknown> = {}) => ({
    type: 'wait.condition',
    config: { if: vip, timeout: 'P2D', ...more },
    next: { met: 'welcome', timed_out: 'nudge' },
  });
  const until = '2026-10-11T12:00:00.000Z';

  it('takes met at once when the condition already holds', () => {
    expect(plan(waiting(), { values: { 'contact.tags': ['VIP'] } })).toEqual({
      kind: 'next',
      next: 'welcome',
      branch: 'met',
      output: {},
      explanation: 'The condition already held, so the met branch was taken.',
    });
  });

  it('waits to its deadline when it does not hold, keeping the deadline', () => {
    expect(plan(waiting(), { values: { 'contact.tags': [] } })).toEqual({
      kind: 'arm',
      wakeAt: at(until),
      event: null,
      carry: { until },
      explanation: `Waiting until the condition holds, or until ${until}.`,
    });
  });

  it('goes on waiting to the same deadline when the record changed and it still does not hold', () => {
    expect(
      plan(waiting(), {
        now: at('2026-10-10T08:00:00Z'),
        values: { 'contact.tags': ['Lead'] },
        armed: { receivedEventId: 'event-1', carry: { until } },
      }),
    ).toEqual({
      kind: 'arm',
      wakeAt: at(until),
      event: null,
      again: true,
      carry: { until },
      explanation: `The record changed, but the condition does not hold yet; still waiting until ${until}.`,
    });
  });

  it('takes met when a change makes it hold', () => {
    expect(
      plan(waiting(), {
        now: at('2026-10-10T08:00:00Z'),
        values: { 'contact.tags': ['VIP'] },
        armed: { receivedEventId: 'event-1', carry: { until } },
      }),
    ).toEqual({
      kind: 'next',
      next: 'welcome',
      branch: 'met',
      output: {},
      explanation: 'The condition held when the record changed, so the met branch was taken.',
    });
  });

  it('is judged once more at the deadline: met if it holds then, timed_out if not', () => {
    const atDeadline = (values: Record<string, string[]>) =>
      plan(waiting(), {
        now: at(until),
        values,
        armed: { receivedEventId: null, carry: { until } },
      });
    expect(atDeadline({ 'contact.tags': ['VIP'] })).toMatchObject({
      branch: 'met',
      explanation: 'The condition held when the wait ended, so the met branch was taken.',
    });
    expect(atDeadline({ 'contact.tags': [] })).toEqual({
      kind: 'next',
      next: 'nudge',
      branch: 'timed_out',
      output: {},
      explanation: 'The condition did not hold before the timeout.',
    });
  });

  it('times out on a change that comes after the deadline, or when the deadline was lost', () => {
    expect(
      plan(waiting(), {
        now: at('2026-10-12T00:00:00Z'),
        armed: { receivedEventId: 'event-2', carry: { until } },
      }),
    ).toMatchObject({ branch: 'timed_out' });
    expect(plan(waiting(), { armed: { receivedEventId: 'event-2' } })).toMatchObject({
      branch: 'timed_out',
    });
    expect(
      plan(waiting(), { armed: { receivedEventId: 'event-2', carry: { until: 'soon' } } }),
    ).toMatchObject({ branch: 'timed_out' });
  });

  it('holds a met condition for the resume window, and fails on a timeout that is none', () => {
    expect(
      plan(waiting({ resumeWindow: office }), {
        now: at('2026-10-10T10:00:00Z'),
        values: { 'contact.tags': ['VIP'] },
      }),
    ).toEqual({
      kind: 'arm',
      wakeAt: at('2026-10-12T06:00:00Z'),
      event: null,
      carry: {
        decided: {
          branch: 'met',
          output: {},
          explanation: 'The condition already held, so the met branch was taken.',
        },
      },
      explanation: `It would go on now (met), but the resume window (${officeWords}) is closed, so it goes on at 2026-10-12T06:00:00.000Z.`,
    });
    expect(
      planStep({
        key: 'here',
        step: { type: 'wait.condition', config: { if: vip, timeout: 'soon' } } as AutomationStep,
        values: {},
        now: friday,
        timeZone: 'UTC',
        enrolmentId: 'e',
      }),
    ).toEqual({
      kind: 'fail',
      error: 'invalid_duration',
      explanation: 'soon is not a length of time.',
    });
    expect(plan(waiting({ timeout: 'P300000Y' }))).toMatchObject({
      kind: 'fail',
      error: 'date_out_of_range',
    });
  });
});

describe('wait.appointment', () => {
  const before = (more: Record<string, unknown> = {}) => ({
    type: 'wait.appointment',
    config: { offset: 'PT2H', ...more },
    next: { reached: 'remind', passed: 'late', no_appointment: 'none' },
  });
  const starts = at('2026-10-14T09:00:00Z');
  const booked = { id: 'apt_1', startsAt: starts, status: 'booked' };
  const out = { appointmentId: 'apt_1', startsAt: '2026-10-14T09:00:00.000Z' };
  const target = '2026-10-14T07:00:00.000Z';

  it('waits until its time before the start, keeping the appointment and the time', () => {
    expect(plan(before(), { appointment: booked })).toEqual({
      kind: 'arm',
      wakeAt: at(target),
      event: null,
      carry: { appointment: 'apt_1', target },
      explanation: `Waiting until 2 hours before the appointment starts (2026-10-14T09:00:00.000Z), at ${target}.`,
    });
  });

  it('waits until the start itself without an offset, and after it when told to', () => {
    expect(plan({ type: 'wait.appointment', config: {} }, { appointment: booked })).toMatchObject({
      kind: 'arm',
      wakeAt: starts,
      explanation: 'Waiting until the appointment starts, at 2026-10-14T09:00:00.000Z.',
    });
    expect(
      plan(before({ offset: 'P1D', direction: 'after' }), { appointment: booked }),
    ).toMatchObject({
      kind: 'arm',
      wakeAt: at('2026-10-15T09:00:00Z'),
      explanation:
        'Waiting until 1 day after the appointment starts (2026-10-14T09:00:00.000Z), at 2026-10-15T09:00:00.000Z.',
    });
  });

  it('takes passed when its time has gone by when the step is reached', () => {
    expect(plan(before(), { now: at('2026-10-14T08:00:00Z'), appointment: booked })).toEqual({
      kind: 'next',
      next: 'late',
      branch: 'passed',
      output: out,
      explanation: `The time to wait for (${target}) had already passed, so the passed branch was taken.`,
    });
  });

  it('takes no_appointment when there is none, or it is cancelled', () => {
    expect(plan(before(), { appointment: null })).toEqual({
      kind: 'next',
      next: 'none',
      branch: 'no_appointment',
      output: {},
      explanation:
        'The contact has no upcoming appointment, so the no_appointment branch was taken.',
    });
    expect(plan(before())).toMatchObject({ branch: 'no_appointment' });
    expect(plan(before(), { appointment: { ...booked, status: 'cancelled' } })).toEqual({
      kind: 'next',
      next: 'none',
      branch: 'no_appointment',
      output: { appointmentId: 'apt_1' },
      explanation: 'The appointment is cancelled, so the no_appointment branch was taken.',
    });
  });

  it('at version 2, takes no_appointment for a no-show or an invalid one too; at 1 it waits on', () => {
    const second = { ...before(), typeVersion: 2 };
    const waiting = { receivedEventId: 'event-1', carry: { appointment: 'apt_1', target } };
    expect(plan(second, { appointment: { ...booked, status: 'no_show' }, armed: waiting })).toEqual(
      {
        kind: 'next',
        next: 'none',
        branch: 'no_appointment',
        output: { appointmentId: 'apt_1' },
        explanation: 'The appointment is marked no-show, so the no_appointment branch was taken.',
      },
    );
    expect(plan(second, { appointment: { ...booked, status: 'invalid' } })).toMatchObject({
      branch: 'no_appointment',
      explanation: 'The appointment is marked invalid, so the no_appointment branch was taken.',
    });
    expect(plan(second, { appointment: { ...booked, status: 'cancelled' } })).toMatchObject({
      branch: 'no_appointment',
      explanation: 'The appointment is cancelled, so the no_appointment branch was taken.',
    });
    // A completed or confirmed one still takes place.
    for (const status of ['completed', 'confirmed'])
      expect(plan(second, { appointment: { ...booked, status } })).toMatchObject({ kind: 'arm' });
    // A step stored before version 2 goes on waiting, as it always did.
    for (const stored of [before(), { ...before(), typeVersion: 1 }])
      expect(
        plan(stored, { appointment: { ...booked, status: 'no_show' }, armed: waiting }),
      ).toMatchObject({ kind: 'arm', again: true, wakeAt: at(target) });
  });

  it('takes reached when its time comes', () => {
    expect(
      plan(before(), {
        now: at(target),
        appointment: { ...booked, status: 'confirmed' },
        armed: { receivedEventId: null, carry: { appointment: 'apt_1', target } },
      }),
    ).toEqual({
      kind: 'next',
      next: 'remind',
      branch: 'reached',
      output: out,
      explanation: 'The time came, so the reached branch was taken.',
    });
  });

  it('waits to the new time when the appointment is moved later', () => {
    const moved = { ...booked, startsAt: at('2026-10-16T09:00:00Z') };
    expect(
      plan(before(), {
        now: at('2026-10-12T08:00:00Z'),
        appointment: moved,
        armed: { receivedEventId: 'event-1', carry: { appointment: 'apt_1', target } },
      }),
    ).toEqual({
      kind: 'arm',
      wakeAt: at('2026-10-16T07:00:00Z'),
      event: null,
      again: true,
      carry: { appointment: 'apt_1', target: '2026-10-16T07:00:00.000Z' },
      explanation:
        'The appointment was moved to 2026-10-16T09:00:00.000Z, so the wait now ends at 2026-10-16T07:00:00.000Z.',
    });
    // Woken at the old time with the move's event lost: the start is read again.
    expect(
      plan(before(), {
        now: at(target),
        appointment: moved,
        armed: { receivedEventId: null, carry: { appointment: 'apt_1', target } },
      }),
    ).toMatchObject({ kind: 'arm', wakeAt: at('2026-10-16T07:00:00Z') });
  });

  it('takes reached at once when it is moved to a time whose moment has passed', () => {
    expect(
      plan(before(), {
        now: at('2026-10-12T08:00:00Z'),
        appointment: { ...booked, startsAt: at('2026-10-12T09:00:00Z') },
        armed: { receivedEventId: 'event-1', carry: { appointment: 'apt_1', target } },
      }),
    ).toEqual({
      kind: 'next',
      next: 'remind',
      branch: 'reached',
      output: { appointmentId: 'apt_1', startsAt: '2026-10-12T09:00:00.000Z' },
      explanation:
        'The appointment was moved to 2026-10-12T09:00:00.000Z; its time to wait for (2026-10-12T07:00:00.000Z) has come, so the reached branch was taken.',
    });
  });

  it('goes on waiting when woken by something that changed nothing', () => {
    expect(
      plan(before(), {
        now: at('2026-10-12T08:00:00Z'),
        appointment: booked,
        armed: { receivedEventId: 'event-1', carry: { appointment: 'apt_1', target } },
      }),
    ).toEqual({
      kind: 'arm',
      wakeAt: at(target),
      event: null,
      again: true,
      carry: { appointment: 'apt_1', target },
      explanation: `Still waiting until ${target}.`,
    });
  });

  it('takes no_appointment when it is cancelled, or gone, during the wait', () => {
    const waitingFor = { receivedEventId: 'event-1', carry: { appointment: 'apt_1', target } };
    expect(
      plan(before(), { appointment: { ...booked, status: 'cancelled' }, armed: waitingFor }),
    ).toMatchObject({ branch: 'no_appointment', output: { appointmentId: 'apt_1' } });
    expect(plan(before(), { appointment: null, armed: waitingFor })).toEqual({
      kind: 'next',
      next: 'none',
      branch: 'no_appointment',
      output: {},
      explanation: 'The appointment no longer exists, so the no_appointment branch was taken.',
    });
  });

  it('holds reached for the resume window, and fails on an offset that is none', () => {
    expect(
      plan(before({ resumeWindow: { ...office, start: '12:00' } }), {
        now: at(target),
        appointment: booked,
        armed: { receivedEventId: null, carry: { appointment: 'apt_1', target } },
      }),
    ).toMatchObject({
      kind: 'arm',
      wakeAt: at('2026-10-14T09:00:00Z'),
      again: true,
      carry: { decided: { branch: 'reached', output: out } },
    });
    expect(
      planStep({
        key: 'here',
        step: {
          type: 'wait.appointment',
          config: { offset: '2h', direction: 'before' },
        },
        values: {},
        now: friday,
        timeZone: 'UTC',
        enrolmentId: 'e',
        appointment: booked,
      }),
    ).toMatchObject({ kind: 'fail', error: 'invalid_duration' });
    expect(plan(before({ offset: 'P300000Y' }), { appointment: booked })).toMatchObject({
      kind: 'fail',
      error: 'date_out_of_range',
    });
  });
});

describe('a test run', () => {
  const run = (
    steps: Record<string, unknown>,
    more: Partial<Parameters<typeof simulateAutomation>[0]> = {},
  ) =>
    simulateAutomation({
      document: automationDocument.parse({
        name: 'Waits',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: Object.keys(steps)[0],
        steps,
      }),
      values: {},
      events: [],
      start: friday,
      timeZone: 'Africa/Nairobi',
      enrolmentId: 'test',
      ...more,
    });
  const done = { type: 'wait', config: { duration: 'PT1M' } };
  const kinds = (trace: ReturnType<typeof run>) =>
    trace.steps.map(
      (each) => `${each.step}:${each.kind}${each.branch === undefined ? '' : `:${each.branch}`}`,
    );

  it('moves a wait to the opening of its resume window', () => {
    const trace = run({
      a: { type: 'wait', config: { duration: 'P1D', resumeWindow: office }, next: 'b' },
      b: done,
    });
    expect(trace.steps[1]?.at).toEqual(at('2026-10-12T06:00:00Z'));
    expect(trace.outcome).toEqual({ kind: 'completed' });
  });

  it('holds a reply that arrives outside the window, then takes received', () => {
    const trace = run(
      {
        a: {
          type: 'wait.event',
          config: { event: 'message.received', timeout: 'P7D', resumeWindow: office },
          next: { received: 'b' },
        },
        b: done,
      },
      { events: [{ event: 'message.received', after: 'P1D' }] },
    );
    expect(kinds(trace)).toEqual(['a:waited', 'a:waited', 'a:branched:received', 'b:waited']);
    expect(trace.steps[1]?.at).toEqual(at('2026-10-10T12:00:00Z'));
    expect(trace.steps[2]?.at).toEqual(at('2026-10-12T06:00:00Z'));
  });

  it('ends on a stop event that falls while a decision is held for the window', () => {
    const trace = run(
      {
        a: {
          type: 'wait.event',
          config: { event: 'message.received', timeout: 'P7D', resumeWindow: office },
          next: { received: 'b' },
        },
        b: done,
      },
      {
        events: [
          { event: 'message.received', after: 'P1D' },
          { event: 'tag.added', after: 'P2D' },
        ],
        document: automationDocument.parse({
          name: 'Waits',
          triggers: [{ id: 'created', type: 'contact.created', config: {} }],
          stopWhen: [{ event: 'tag.added' }],
          start: 'a',
          steps: {
            a: {
              type: 'wait.event',
              config: { event: 'message.received', timeout: 'P7D', resumeWindow: office },
              next: { received: 'b' },
            },
            b: done,
          },
        }),
      },
    );
    expect(trace.outcome).toMatchObject({ kind: 'stopped', event: 'tag.added' });
  });

  it('judges a condition on arrival and at its deadline, with the values of the test', () => {
    const waiting = {
      a: {
        type: 'wait.condition',
        config: {
          if: { field: 'contact.tags', operator: 'includes', value: 'VIP' },
          timeout: 'P2D',
        },
        next: { met: 'b', timed_out: 'c' },
      },
      b: done,
      c: done,
    };
    expect(kinds(run(waiting, { values: { 'contact.tags': ['VIP'] } }))).toEqual([
      'a:branched:met',
      'b:waited',
    ]);
    const timedOut = run(waiting, { values: { 'contact.tags': [] } });
    expect(kinds(timedOut)).toEqual(['a:waited', 'a:branched:timed_out', 'c:waited']);
    expect(timedOut.steps[1]?.at).toEqual(at('2026-10-11T12:00:00Z'));
  });

  it('waits for the appointment it is given, and takes no_appointment without one', () => {
    const waiting = {
      a: {
        type: 'wait.appointment',
        config: { offset: 'PT2H' },
        next: { reached: 'b', no_appointment: 'c' },
      },
      b: done,
      c: done,
    };
    const reached = run(waiting, {
      appointment: { id: 'apt_1', startsAt: at('2026-10-14T09:00:00Z'), status: 'booked' },
    });
    expect(kinds(reached)).toEqual(['a:waited', 'a:branched:reached', 'b:waited']);
    expect(reached.steps[1]?.at).toEqual(at('2026-10-14T07:00:00Z'));
    expect(kinds(run(waiting))).toEqual(['a:branched:no_appointment', 'c:waited']);
  });
});
