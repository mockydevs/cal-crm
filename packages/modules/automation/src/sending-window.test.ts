// The sending window (settings.sendingWindow): when
// it is open, and when it next opens, in a time zone, across the days the clocks change.
// Every moment here is a fixed date, so nothing depends on when the test runs.
import { automationDocument } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { simulateAutomation } from './simulate.js';
import { planSendingHold, sendingWindowOpening, WINDOWED_STEPS } from './steps.js';

const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const office = { days: weekdays, start: '09:00', end: '17:00' };
const at = (iso: string) => new Date(iso);
const opening = (window: typeof office, iso: string, timeZone: string) =>
  sendingWindowOpening(window, at(iso), timeZone);
const opensAt = (iso: string) => ({ open: false, opensAt: at(iso) });

describe('a window inside one day', () => {
  // Nairobi is three hours ahead of UTC all year. 2026-10-12 is a Monday.
  it('is open from its start until its end, on its days', () => {
    expect(opening(office, '2026-10-12T06:00:00Z', 'Africa/Nairobi')).toEqual({ open: true });
    expect(opening(office, '2026-10-12T13:59:59Z', 'Africa/Nairobi')).toEqual({ open: true });
  });

  it('opens later the same day when it is reached before its start', () => {
    expect(opening(office, '2026-10-12T05:59:59Z', 'Africa/Nairobi')).toEqual(
      opensAt('2026-10-12T06:00:00Z'),
    );
  });

  it('opens the next day once its end has come, the end itself included', () => {
    expect(opening(office, '2026-10-12T14:00:00Z', 'Africa/Nairobi')).toEqual(
      opensAt('2026-10-13T06:00:00Z'),
    );
  });

  it('skips the days it does not have: Friday evening waits for Monday', () => {
    expect(opening(office, '2026-10-16T15:00:00Z', 'Africa/Nairobi')).toEqual(
      opensAt('2026-10-19T06:00:00Z'),
    );
    // A window with one day waits up to a week for it.
    expect(
      opening({ ...office, days: ['monday'] }, '2026-10-12T14:00:00Z', 'Africa/Nairobi'),
    ).toEqual(opensAt('2026-10-19T06:00:00Z'));
  });

  it("goes by the zone's own calendar day, not the day in UTC", () => {
    // 21:30 UTC on Sunday is 10:30 on Monday in Auckland (UTC+13 in October): open.
    expect(opening(office, '2026-10-11T21:30:00Z', 'Pacific/Auckland')).toEqual({ open: true });
    // 01:00 UTC on Monday is 18:00 on Sunday in Los Angeles: closed until Monday 09:00 there.
    expect(opening(office, '2026-10-12T01:00:00Z', 'America/Los_Angeles')).toEqual(
      opensAt('2026-10-12T16:00:00Z'),
    );
    // Half-hour zones too: 09:00 in Kolkata is 03:30 UTC.
    expect(opening(office, '2026-10-12T03:00:00Z', 'Asia/Kolkata')).toEqual(
      opensAt('2026-10-12T03:30:00Z'),
    );
  });
});

describe('where the clocks change', () => {
  // New York: clocks go forward on Sunday 2026-03-08, back on Sunday 2026-11-01.
  it('opens at the same wall-clock time the Monday after the clocks go forward', () => {
    // Friday 18:00 EST. Monday 09:00 is EDT, an hour earlier in UTC than the Friday's 09:00.
    expect(opening(office, '2026-03-06T23:00:00Z', 'America/New_York')).toEqual(
      opensAt('2026-03-09T13:00:00Z'),
    );
    expect(opening(office, '2026-03-06T13:59:59Z', 'America/New_York')).toEqual(
      opensAt('2026-03-06T14:00:00Z'),
    );
  });

  it('opens at the same wall-clock time the Monday after the clocks go back', () => {
    // Friday 18:00 EDT. Monday 09:00 is EST, an hour later in UTC.
    expect(opening(office, '2026-10-30T22:00:00Z', 'America/New_York')).toEqual(
      opensAt('2026-11-02T14:00:00Z'),
    );
  });

  it('opens when the clocks land, for a start they skip', () => {
    // 02:30 on 8 March does not happen in New York: the window opens at 03:30 EDT.
    const early = { days: ['sunday'], start: '02:30', end: '05:00' };
    expect(opening(early, '2026-03-08T06:00:00Z', 'America/New_York')).toEqual(
      opensAt('2026-03-08T07:30:00Z'),
    );
    expect(opening(early, '2026-03-08T07:30:00Z', 'America/New_York')).toEqual({ open: true });
  });

  it('opens at the first of the two, for a start that comes twice', () => {
    // 01:30 on 1 November happens twice in New York: at 05:30 and at 06:30 UTC.
    const night = { days: ['sunday'], start: '01:30', end: '04:00' };
    expect(opening(night, '2026-11-01T05:00:00Z', 'America/New_York')).toEqual(
      opensAt('2026-11-01T05:30:00Z'),
    );
    // And stays open through the repeated hour, until 04:00 EST.
    expect(opening(night, '2026-11-01T06:45:00Z', 'America/New_York')).toEqual({ open: true });
    expect(opening(night, '2026-11-01T09:00:00Z', 'America/New_York')).toEqual(
      opensAt('2026-11-08T06:30:00Z'),
    );
  });
});

describe('a window that runs past midnight', () => {
  const evenings = { days: ['friday'], start: '22:00', end: '06:00' };

  it('belongs to the day it opens on, and stays open into the next', () => {
    // Friday 2026-10-16 in Nairobi: opens 19:00 UTC, closes Saturday 03:00 UTC.
    expect(opening(evenings, '2026-10-16T18:59:00Z', 'Africa/Nairobi')).toEqual(
      opensAt('2026-10-16T19:00:00Z'),
    );
    expect(opening(evenings, '2026-10-16T21:30:00Z', 'Africa/Nairobi')).toEqual({ open: true });
    // Saturday 05:59 there: still Friday's window, though Saturday is not one of its days.
    expect(opening(evenings, '2026-10-17T02:59:00Z', 'Africa/Nairobi')).toEqual({ open: true });
    expect(opening(evenings, '2026-10-17T03:00:00Z', 'Africa/Nairobi')).toEqual(
      opensAt('2026-10-23T19:00:00Z'),
    );
  });
});

describe('a window that cannot be judged', () => {
  it('is neither open nor closed in a zone that is not one, or when it never opens', () => {
    expect(opening(office, '2026-10-12T06:00:00Z', 'Mars/Olympus')).toBeUndefined();
    expect(
      opening({ ...office, end: '09:00' }, '2026-10-12T06:00:00Z', 'Africa/Nairobi'),
    ).toBeUndefined();
    // No day of the window ever comes.
    expect(
      opening({ ...office, days: ['someday'] }, '2026-10-12T06:00:00Z', 'Africa/Nairobi'),
    ).toBeUndefined();
  });

  it('fails the step with the reason, rather than wait for ever or send anyway', () => {
    expect(planSendingHold(office, at('2026-10-12T06:00:00Z'), 'Mars/Olympus')).toEqual({
      kind: 'fail',
      error: 'invalid_time_zone',
      explanation: 'Mars/Olympus is not a time zone.',
    });
    expect(
      planSendingHold({ ...office, end: '09:00' }, at('2026-10-12T06:00:00Z'), 'Africa/Nairobi'),
    ).toEqual({
      kind: 'fail',
      error: 'invalid_sending_window',
      explanation: 'The sending window (09:00 to 09:00) never opens.',
    });
  });
});

describe('what the window does to a message step', () => {
  it('lets it through while open, and holds it until the opening otherwise', () => {
    expect(planSendingHold(office, at('2026-10-12T06:00:00Z'), 'Africa/Nairobi')).toBeUndefined();
    expect(planSendingHold(office, at('2026-10-16T15:00:00Z'), 'Africa/Nairobi')).toEqual({
      kind: 'hold',
      wakeAt: at('2026-10-19T06:00:00Z'),
      explanation:
        'Outside the sending window (09:00 to 17:00, Africa/Nairobi), so it waits until 2026-10-19T06:00:00.000Z.',
    });
  });

  it('holds messages to the contact, and nothing else', () => {
    expect([...WINDOWED_STEPS].sort()).toEqual(['email.send', 'sms.send']);
  });
});

describe('a test run with a sending window', () => {
  const document = (stopWhen: unknown[] = []) =>
    automationDocument.parse({
      name: 'Office hours',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      stopWhen,
      start: 'mark',
      steps: {
        mark: { type: 'tag.add', config: { tag: 'tag_1' }, next: 'write' },
        write: { type: 'sms.send', config: { message: 'Hello' }, next: 'pause' },
        pause: { type: 'wait', config: { duration: 'PT1H' } },
      },
      settings: { sendingWindow: office },
    });
  const run = (
    start: string,
    written = document(),
    events: { event: string; after: string }[] = [],
  ) =>
    simulateAutomation({
      document: written,
      values: {},
      events,
      start: at(start),
      timeZone: 'Africa/Nairobi',
      enrolmentId: 'test',
    });

  it('sends at once inside the window, and never holds a step that is not a message', () => {
    expect(
      run('2026-10-12T06:00:00Z').steps.map((step) => [
        step.step,
        step.kind,
        step.at.toISOString(),
      ]),
    ).toEqual([
      ['mark', 'would_change', '2026-10-12T06:00:00.000Z'],
      ['write', 'would_send', '2026-10-12T06:00:00.000Z'],
      ['pause', 'waited', '2026-10-12T06:00:00.000Z'],
    ]);
  });

  it('waits at the message step until the window opens, then sends, as a real run does', () => {
    const trace = run('2026-10-16T15:00:00Z');
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(
      trace.steps.map((step) => [step.step, step.kind, step.at.toISOString(), step.explanation]),
    ).toEqual([
      ['mark', 'would_change', '2026-10-16T15:00:00.000Z', expect.any(String)],
      [
        'write',
        'waited',
        '2026-10-16T15:00:00.000Z',
        'Outside the sending window (09:00 to 17:00, Africa/Nairobi), so it waits until 2026-10-19T06:00:00.000Z.',
      ],
      ['write', 'would_send', '2026-10-19T06:00:00.000Z', expect.any(String)],
      ['pause', 'waited', '2026-10-19T06:00:00.000Z', expect.any(String)],
    ]);
  });

  it('ends on a stop event that comes while the message is held', () => {
    const trace = run('2026-10-16T15:00:00Z', document([{ event: 'tag.added' }]), [
      { event: 'tag.added', after: 'P1D' },
    ]);
    expect(trace.outcome).toEqual({
      kind: 'stopped',
      event: 'tag.added',
      at: at('2026-10-17T15:00:00Z'),
    });
    expect(trace.steps.map((step) => [step.step, step.kind])).toEqual([
      ['mark', 'would_change'],
      ['write', 'waited'],
    ]);
  });

  it('fails where a real run would when the window never opens', () => {
    const never = automationDocument.parse({
      name: 'Never',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'write',
      steps: { write: { type: 'email.send', config: { template: 'tmpl_1' } } },
      settings: { sendingWindow: { ...office, end: '09:00' } },
    });
    expect(run('2026-10-12T06:00:00Z', never)).toEqual({
      steps: [],
      outcome: { kind: 'failed', step: 'write', error: 'invalid_sending_window' },
    });
  });
});
