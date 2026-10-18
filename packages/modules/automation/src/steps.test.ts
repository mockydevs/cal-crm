import { automationStep, automationStepTypes, type AutomationStep } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { planStep, splitBucket, UNAVAILABLE_STEPS } from './steps.js';

const now = new Date('2026-10-09T12:00:00Z');
const step = (input: unknown): AutomationStep => automationStep.parse(input);
const plan = (input: unknown, values = {}, timeZone = 'Africa/Nairobi', enrolmentId = 'e1') =>
  planStep({ key: 'here', step: step(input), values, now, timeZone, enrolmentId });

describe('waits', () => {
  it('wait sets the wake time after its duration and moves on to next', () => {
    expect(plan({ type: 'wait', config: { duration: 'P2D' }, next: 'later' })).toEqual({
      kind: 'wait',
      wakeAt: new Date('2026-10-11T12:00:00Z'),
      next: 'later',
      explanation: 'Waiting 2 days, until 2026-10-11T12:00:00.000Z.',
    });
  });

  it('wait.until a date field waits until that date, at a time in the time zone', () => {
    expect(
      plan(
        {
          type: 'wait.until',
          config: {
            field: 'contact.custom.event_date',
            offset: 'P2D',
            direction: 'before',
            time: '09:00',
          },
          next: 'remind',
        },
        { 'contact.custom.event_date': '2026-10-20' },
      ),
    ).toMatchObject({
      kind: 'arm',
      wakeAt: new Date('2026-10-18T06:00:00Z'),
      event: null,
      carry: { target: '2026-10-18T06:00:00.000Z' },
    });
  });

  it('wait.until a date and time field keeps its instant, whatever the time zone', () => {
    expect(
      plan(
        { type: 'wait.until', config: { field: 'contact.custom.event_date' }, next: 'remind' },
        { 'contact.custom.event_date': '2026-10-20T10:00:00.000Z' },
        'America/New_York',
      ),
    ).toEqual({
      kind: 'arm',
      wakeAt: new Date('2026-10-20T10:00:00Z'),
      event: null,
      carry: { target: '2026-10-20T10:00:00.000Z' },
      explanation: 'Waiting until 2026-10-20T10:00:00.000Z.',
    });
  });

  it('wait.until a fixed moment, and goes on at once when it has passed or the date is missing', () => {
    expect(plan({ type: 'wait.until', config: { at: '2026-12-01T09:00:00+03:00' } })).toMatchObject(
      {
        kind: 'wait',
        wakeAt: new Date('2026-12-01T06:00:00Z'),
        next: null,
      },
    );
    expect(
      plan({ type: 'wait.until', config: { at: '2026-01-01T00:00:00Z' }, next: 'go' }),
    ).toMatchObject({
      kind: 'next',
      next: 'go',
    });
    expect(
      plan({ type: 'wait.until', config: { field: 'contact.custom.event_date' }, next: 'go' }, {}),
    ).toEqual({
      kind: 'next',
      next: 'go',
      branch: null,
      output: {},
      explanation: 'contact.custom.event_date has no date, so there was nothing to wait for.',
    });
  });
});

describe('branches', () => {
  const condition = {
    type: 'condition',
    config: { if: { field: 'contact.custom.services', operator: 'includes', value: 'opt_video' } },
    next: { yes: 'reel', no: 'check_in' },
  };

  it('condition takes yes or no, and says why', () => {
    expect(plan(condition, { 'contact.custom.services': ['opt_video'] })).toEqual({
      kind: 'next',
      next: 'reel',
      branch: 'yes',
      output: {},
      explanation: 'The condition was true, so the yes branch was taken.',
    });
    expect(plan(condition, {})).toMatchObject({ next: 'check_in', branch: 'no' });
  });

  it('ends the path when the branch taken has no next step', () => {
    expect(plan({ ...condition, next: { yes: 'reel' } }, {})).toMatchObject({
      kind: 'next',
      next: null,
      branch: 'no',
    });
  });

  it('split sends the same enrolment down the same variant, in proportion', () => {
    const split = {
      type: 'split',
      config: {
        variants: [
          { name: 'a', percent: 30 },
          { name: 'b', percent: 70 },
        ],
      },
      next: { a: 'first', b: 'second' },
    };
    const first = plan(split, {}, 'UTC', 'enrolment-7');
    expect(plan(split, {}, 'UTC', 'enrolment-7')).toEqual(first);
    const counts = { a: 0, b: 0 };
    for (let index = 0; index < 1000; index++) {
      const result = plan(split, {}, 'UTC', `enrolment-${String(index)}`);
      if (result.kind === 'next' && (result.branch === 'a' || result.branch === 'b'))
        counts[result.branch] += 1;
    }
    expect(counts.a).toBeGreaterThan(220);
    expect(counts.a).toBeLessThan(380);
    expect(counts.a + counts.b).toBe(1000);
  });

  it('ends the path when a branching step names no next steps at all', () => {
    expect(plan({ type: 'condition', config: condition.config }, {})).toEqual({
      kind: 'next',
      next: null,
      branch: 'no',
      output: {},
      explanation: 'The condition was false, so the no branch was taken.',
    });
  });

  it('split gives the last variant whatever the percentages leave over', () => {
    const split = {
      type: 'split',
      config: {
        variants: [
          { name: 'a', percent: 10 },
          { name: 'b', percent: 10 },
        ],
      },
      next: { a: 'first', b: 'second' },
    };
    const left = { a: 0, b: 0 };
    for (let index = 0; index < 500; index++) {
      const id = `enrolment-${String(index)}`;
      const bucket = splitBucket(id, 'here');
      const name = bucket < 10 ? 'a' : 'b';
      expect(plan(split, {}, 'UTC', id)).toEqual({
        kind: 'next',
        next: name === 'a' ? 'first' : 'second',
        branch: name,
        output: { variant: name },
        explanation: `Bucket ${String(bucket)} of 100 fell in variant ${name}.`,
      });
      if (bucket >= 20) left[name] += 1;
    }
    // Buckets 20 to 99 belong to no variant by the percentages; none may be left without one.
    expect(left.a).toBe(0);
    expect(left.b).toBeGreaterThan(300);
  });

  it('buckets fall in 0 to 99', () => {
    for (const id of ['x', 'y', 'z', 'a long enrolment id']) {
      const bucket = splitBucket(id, 'step');
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });
});

describe('actions', () => {
  const configs: Readonly<Record<string, unknown>> = {
    'email.send': { template: 'Pricing guide' },
    'sms.send': { message: 'Still interested?' },
    'whatsapp.send': { template: 'Booking reminder' },
    'team.notify': { message: 'A new lead came in.' },
    'contact.update': { fields: { 'contact.firstName': 'Ada' } },
    'deal.create': { pipeline: 'Sales', stage: 'New' },
    'deal.move': { stage: 'Quoted' },
    'deal.close': { outcome: 'lost', lostReason: 'Price' },
    'deal.find': { status: 'open' },
    'deal.update': { name: 'Renewal' },
    'task.create': { title: 'Call back', dueIn: 'P1D' },
    'note.create': { text: 'New lead' },
    'owner.remove': {},
    'dnd.set': { channel: 'all', action: 'enable', reason: 'Requested by the contact.' },
    'owner.assign': { user: 'Ada' },
    'followers.add': { users: ['Ada'] },
    'followers.remove': { all: true },
    'score.modify': { calculation: 'add', points: 10 },
    'email.verify': {},
    'tag.add': { tag: 'VIP' },
    'tag.remove': { tag: 'VIP' },
    'ai.ask': { prompt: 'What did they ask for?' },
    'ai.classify': { categories: ['hot', 'cold'] },
    'ai.draft_reply': {},
    'webhook.call': { url: 'https://example.com/hook' },
    'automation.run': { automation: 'Welcome' },
    'automation.remove': { from: 'all_others' },
    'manual.call': { notes: 'Ask about the quote' },
    'manual.sms': { message: 'Hi {{contact.firstName}}' },
  };

  it('are never performed by the planner: the engine runs them, each through its command', () => {
    const catalog = Object.entries(automationStepTypes)
      .filter(([, definition]) => definition.group !== 'timing' && definition.group !== 'logic')
      .map(([type]) => type);
    expect(Object.keys(configs).toSorted()).toEqual(catalog.toSorted());
    for (const [type, config] of Object.entries(configs))
      expect(plan({ type, config }), type).toMatchObject({
        kind: 'fail',
        error: 'not_implemented',
      });
    expect(plan({ type: 'tag.add', config: { tag: 'VIP' }, next: 'x' })).toEqual({
      kind: 'fail',
      error: 'not_implemented',
      explanation: 'tag.add steps are run by the engine, not planned.',
    });
  });

  it('say why, for each step the engine cannot run yet', () => {
    expect(Object.keys(UNAVAILABLE_STEPS).toSorted()).toEqual([
      'ai.ask',
      'ai.classify',
      'ai.draft_reply',
      'whatsapp.send',
    ]);
    for (const [type, reason] of Object.entries(UNAVAILABLE_STEPS))
      expect(plan({ type, config: configs[type] })).toEqual({
        kind: 'fail',
        error: 'not_implemented',
        explanation: `${type} steps are not available yet. ${reason}`,
      });
  });
});

describe('dates that cannot be kept', () => {
  const untilField = { type: 'wait.until', config: { field: 'contact.custom.event_date' } };
  const until = (value: string, timeZone = 'Africa/Nairobi') =>
    plan(untilField, { 'contact.custom.event_date': value }, timeZone);

  it('fail a wait.until whose field holds a date that does not exist', () => {
    for (const value of ['2026-13-45', '2026-02-30', '2026-10-20 at noon', '2026-10-20T25:00:00Z'])
      expect(until(value)).toEqual({
        kind: 'fail',
        error: 'invalid_date',
        explanation: `contact.custom.event_date holds ${value}, which is not a date.`,
      });
  });

  it('fail a wait.until whose time zone is unknown', () => {
    expect(until('2026-10-20', 'Not/A_Zone')).toEqual({
      kind: 'fail',
      error: 'invalid_time_zone',
      explanation: 'Not/A_Zone is not a time zone.',
    });
  });

  it('fail a wait.until whose fixed moment is not a date', () => {
    const fixed: AutomationStep = { type: 'wait.until', config: { at: 'soon' } };
    expect(
      planStep({ key: 'here', step: fixed, values: {}, now, timeZone: 'UTC', enrolmentId: 'e' }),
    ).toEqual({ kind: 'fail', error: 'invalid_date', explanation: 'soon is not a date.' });
  });

  it('fail a wait whose length cannot be read, rather than not waiting at all', () => {
    // Only a document that skipped the schema can hold these; it must still never run on.
    const direct = (bad: AutomationStep) =>
      planStep({
        key: 'here',
        step: bad,
        values: { 'contact.custom.event_date': '2026-10-20' },
        now,
        timeZone: 'UTC',
        enrolmentId: 'e',
      });
    const unreadable = (duration: string) => ({
      kind: 'fail',
      error: 'invalid_duration',
      explanation: `${duration} is not a length of time.`,
    });
    expect(direct({ type: 'wait', config: { duration: 'two days' } })).toEqual(
      unreadable('two days'),
    );
    expect(
      direct({ type: 'wait.event', config: { event: 'message.received', timeout: 'soon' } }),
    ).toEqual(unreadable('soon'));
    expect(
      direct({
        type: 'wait.until',
        config: { field: 'contact.custom.event_date', offset: '2d', direction: 'before' },
      }),
    ).toEqual(unreadable('2d'));
  });

  it('fail a wait that ends beyond the last date there is', () => {
    const beyond = {
      kind: 'fail',
      error: 'date_out_of_range',
      explanation: 'The wait ends beyond the last date that can be kept.',
    };
    expect(plan({ type: 'wait', config: { duration: 'P300000Y' } })).toEqual(beyond);
    expect(
      plan({
        type: 'wait.event',
        config: { event: 'message.received', timeout: 'P300000Y' },
        next: { received: 'thanks' },
      }),
    ).toEqual(beyond);
    expect(
      plan(
        { type: 'wait.until', config: { ...untilField.config, offset: 'P300000Y' } },
        { 'contact.custom.event_date': '2026-10-20' },
      ),
    ).toEqual(beyond);
    expect(
      plan(
        {
          type: 'wait.until',
          config: { ...untilField.config, offset: 'P300000Y', direction: 'after' },
        },
        { 'contact.custom.event_date': '2026-10-20T10:00:00.000Z' },
      ),
    ).toEqual(beyond);
  });
});

describe('wait.event', () => {
  const waitForReply = {
    type: 'wait.event',
    config: { event: 'message.received', from: 'contact', timeout: 'P3D' },
    next: { received: 'thanks', timed_out: 'nudge' },
  };

  it('arms on its first visit, until the timeout', () => {
    expect(plan(waitForReply)).toEqual({
      kind: 'arm',
      wakeAt: new Date('2026-10-12T12:00:00Z'),
      event: 'message.received',
      explanation: 'Waiting for message.received until 2026-10-12T12:00:00.000Z.',
    });
  });

  it('takes received when the event arrived, and timed_out when it did not', () => {
    const armed = (receivedEventId: string | null) =>
      planStep({
        key: 'here',
        step: step(waitForReply),
        values: {},
        now,
        timeZone: 'UTC',
        enrolmentId: 'e',
        armed: { receivedEventId },
      });
    expect(armed('event-1')).toEqual({
      kind: 'next',
      next: 'thanks',
      branch: 'received',
      output: { eventId: 'event-1' },
      explanation: 'message.received arrived, so the received branch was taken.',
    });
    expect(armed(null)).toMatchObject({ next: 'nudge', branch: 'timed_out', output: {} });
  });

  it('ends the path at the timeout when no timed_out step is named', () => {
    expect(
      planStep({
        key: 'here',
        step: step({ ...waitForReply, next: { received: 'thanks' } }),
        values: {},
        now,
        timeZone: 'UTC',
        enrolmentId: 'e',
        armed: { receivedEventId: null },
      }),
    ).toEqual({
      kind: 'next',
      next: null,
      branch: 'timed_out',
      output: {},
      explanation: 'No message.received came before the timeout.',
    });
  });
});

describe('wait.until a date field, while the run waits', () => {
  const field = 'contact.custom.event_date';
  const until = (config: Record<string, unknown> = {}, typeVersion?: number) => ({
    type: 'wait.until',
    config: { field, ...config },
    next: 'remind',
    ...(typeVersion === undefined ? {} : { typeVersion }),
  });
  const visit = (
    input: unknown,
    value: string | undefined,
    options: { at?: Date; carry?: Record<string, unknown>; zone?: string; woken?: boolean } = {},
  ) =>
    planStep({
      key: 'here',
      step: step(input),
      values: value === undefined ? {} : { [field]: value },
      now: options.at ?? now,
      timeZone: options.zone ?? 'Africa/Nairobi',
      enrolmentId: 'e1',
      ...(options.carry === undefined && options.woken !== true
        ? {}
        : {
            armed: {
              receivedEventId: options.woken === true ? 'event' : null,
              carry: options.carry,
            },
          }),
    });

  it('moves the wait when the date moves later, and says so', () => {
    expect(
      visit(until({ time: '09:00' }), '2026-11-20', {
        woken: true,
        carry: { target: '2026-10-20T06:00:00.000Z' },
      }),
    ).toEqual({
      kind: 'arm',
      wakeAt: new Date('2026-11-20T06:00:00Z'),
      event: null,
      again: true,
      carry: { target: '2026-11-20T06:00:00.000Z' },
      explanation: `${field} changed, so the wait now ends at 2026-11-20T06:00:00.000Z.`,
    });
    // Woken by another change, the same date: still waiting.
    expect(
      visit(until({ time: '09:00' }), '2026-11-20', {
        woken: true,
        carry: { target: '2026-11-20T06:00:00.000Z' },
      }),
    ).toMatchObject({
      kind: 'arm',
      again: true,
      explanation: 'Waiting until 2026-11-20T06:00:00.000Z.',
    });
  });

  it('goes on when its time comes, inside the resume window', () => {
    const target = '2026-10-09T12:00:00.000Z';
    expect(visit(until(), '2026-10-09T12:00:00.000Z', { carry: { target } })).toMatchObject({
      kind: 'next',
      next: 'remind',
      explanation: `The time came (${target}), so it went on.`,
    });
    // Friday 15:00 in Nairobi; the window opens Monday 09:00.
    expect(
      visit(
        until({ resumeWindow: { days: ['monday'], start: '09:00', end: '17:00' } }),
        '2026-10-09T12:00:00.000Z',
        { carry: { target } },
      ),
    ).toMatchObject({ kind: 'wait', wakeAt: new Date('2026-10-12T06:00:00Z'), next: 'remind' });
    expect(
      visit(
        until({ resumeWindow: { days: ['monday'], start: '09:00', end: '17:00' } }),
        '2026-10-09T12:00:00.000Z',
        { carry: { target }, zone: 'Not/A_Zone' },
      ),
    ).toMatchObject({ kind: 'fail', error: 'invalid_time_zone' });
  });

  it('follows ifPassed when the date moves into the past', () => {
    expect(
      visit(until({ ifPassed: 'end' }), '2026-10-01T00:00:00.000Z', {
        woken: true,
        carry: { target: '2026-12-01T00:00:00.000Z' },
      }),
    ).toMatchObject({ kind: 'next', next: null });
  });

  it('waits for a value while the field is empty, by default, up to 365 days', () => {
    expect(visit(until({}, 2), undefined)).toEqual({
      kind: 'arm',
      wakeAt: new Date('2027-10-09T12:00:00Z'),
      event: null,
      carry: { emptyUntil: '2027-10-09T12:00:00.000Z' },
      explanation: `${field} has no date yet, so the run waits here for one, until 2027-10-09T12:00:00.000Z at the latest.`,
    });
    // Woken by a change that left it empty: the same deadline.
    expect(
      visit(until({}, 2), '', { woken: true, carry: { emptyUntil: '2027-10-09T12:00:00.000Z' } }),
    ).toMatchObject({ kind: 'arm', again: true, wakeAt: new Date('2027-10-09T12:00:00Z') });
    // The deadline came with nothing: the run ends.
    expect(
      visit(until({}, 2), undefined, {
        at: new Date('2027-10-09T12:00:00Z'),
        carry: { emptyUntil: '2027-10-09T12:00:00.000Z' },
      }),
    ).toMatchObject({ kind: 'next', next: null });
    // A date that arrives ends the empty wait: the step now waits for the date.
    expect(
      visit(until({ time: '09:00' }, 2), '2026-10-20', {
        woken: true,
        carry: { emptyUntil: '2027-10-09T12:00:00.000Z' },
      }),
    ).toMatchObject({ kind: 'arm', wakeAt: new Date('2026-10-20T06:00:00Z') });
  });

  it('goes on or ends while empty when it says so, and goes on at version 1', () => {
    expect(visit(until({ ifEmpty: 'continue' }, 2), undefined)).toMatchObject({
      kind: 'next',
      next: 'remind',
    });
    expect(
      visit(until({ ifEmpty: 'continue' }, 2), undefined, { woken: true, carry: { target: 'x' } }),
    ).toMatchObject({
      kind: 'next',
      explanation: `${field} was emptied while the run waited, so it went on.`,
    });
    expect(visit(until({ ifEmpty: 'end' }, 2), undefined)).toMatchObject({
      kind: 'next',
      next: null,
    });
    expect(visit(until({}, 1), undefined)).toMatchObject({ kind: 'next', next: 'remind' });
    expect(visit(until(), undefined)).toMatchObject({ kind: 'next', next: 'remind' });
  });

  it('counts days before a date on the zone calendar, across a clock change', () => {
    const before = until({ offset: 'P1D', direction: 'before', time: '09:00' });
    const zone = 'America/New_York';
    const at = new Date('2026-06-01T00:00:00Z');
    // 09:00 EDT the day before 1 November, and 09:00 EST the day before 14 March.
    expect(visit(before, '2026-11-01', { zone, at })).toMatchObject({
      wakeAt: new Date('2026-10-31T13:00:00Z'),
    });
    expect(visit(before, '2027-03-14', { zone, at })).toMatchObject({
      wakeAt: new Date('2027-03-13T14:00:00Z'),
    });
    // A date and time keeps its time of day on the zone's clock: 14:00 EST, a day before.
    expect(
      visit(until({ offset: 'P1DT1H', direction: 'before' }), '2026-11-02T19:00:30.000Z', {
        zone,
        at,
      }),
    ).toMatchObject({ wakeAt: new Date('2026-11-01T18:00:30Z') });
  });

  it('fails a date, offset or zone it cannot read', () => {
    expect(visit(until(), '2026-13-45')).toMatchObject({ kind: 'fail', error: 'invalid_date' });
    expect(visit(until(), '2026-10-20Tlater')).toMatchObject({
      kind: 'fail',
      error: 'invalid_date',
    });
    expect(visit(until(), '2026-10-20', { zone: 'Not/A_Zone' })).toMatchObject({
      kind: 'fail',
      error: 'invalid_time_zone',
    });
  });
});
