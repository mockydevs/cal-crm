import { readFileSync } from 'node:fs';

import { automationDocument } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { simulateAutomation } from './simulate.js';

const spec = readFileSync(new URL('../../../../docs/AUTOMATIONS.md', import.meta.url), 'utf8');
const example = automationDocument.parse(
  [...spec.matchAll(/```json\n([\s\S]*?)```/g)]
    .map(([, body]) => JSON.parse(body ?? '') as Record<string, unknown>)
    .find((block) => 'steps' in block),
);
const start = new Date('2026-10-09T09:00:00Z');
const run = (values = {}, events: Parameters<typeof simulateAutomation>[0]['events'] = []) =>
  simulateAutomation({
    document: example,
    values,
    events,
    start,
    timeZone: 'Africa/Nairobi',
    enrolmentId: 'test',
  });

describe('a test run of the AUTOMATIONS.md example', () => {
  it('follows the no branch for a contact who did not ask about video, with time fast-forwarded', () => {
    const trace = run({ 'contact.firstName': 'Ada' });
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps.map((step) => [step.step, step.kind, step.at.toISOString()])).toEqual([
      ['send_guide', 'would_send', '2026-10-09T09:00:00.000Z'],
      ['wait_2_days', 'waited', '2026-10-09T09:00:00.000Z'],
      ['asked_about_video', 'branched', '2026-10-11T09:00:00.000Z'],
      ['check_in', 'would_send', '2026-10-11T09:00:00.000Z'],
      ['wait_3_days', 'waited', '2026-10-11T09:00:00.000Z'],
      ['last_check_in', 'would_send', '2026-10-14T09:00:00.000Z'],
    ]);
    expect(trace.steps[2]).toMatchObject({
      branch: 'no',
      explanation: 'The condition was false, so the no branch was taken.',
    });
  });

  it('takes the yes branch for a contact interested in video', () => {
    const trace = run({ 'contact.services': ['Video'] });
    expect(trace.steps.map((step) => step.step)).toEqual([
      'send_guide',
      'wait_2_days',
      'asked_about_video',
      'send_reel',
    ]);
  });

  it('stops when a simulated reply arrives during a wait, as the stop condition says', () => {
    const trace = run({}, [{ event: 'message.received', after: 'P1D' }]);
    expect(trace.outcome).toEqual({
      kind: 'stopped',
      event: 'message.received',
      at: new Date('2026-10-10T09:00:00Z'),
    });
    expect(trace.steps.map((step) => step.step)).toEqual(['send_guide', 'wait_2_days']);
  });

  it('ignores simulated events no stop condition listens for', () => {
    expect(run({}, [{ event: 'tag.added', after: 'PT1H' }]).outcome).toEqual({ kind: 'completed' });
  });

  it('never sends or writes: messages and record changes are only described', () => {
    for (const step of run().steps)
      expect(['would_send', 'would_change', 'waited', 'branched', 'ended']).toContain(step.kind);
  });
});

describe('limits', () => {
  it('stops a run that would go on without end', () => {
    const loop = automationDocument.parse({
      name: 'Loop',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'again',
      steps: {
        again: { type: 'wait', config: { duration: 'P1D' }, next: 'tag' },
        tag: { type: 'tag.add', config: { tag: 'Ping' }, next: 'again' },
      },
    });
    const trace = simulateAutomation({
      document: loop,
      values: {},
      events: [],
      start,
      timeZone: 'UTC',
      enrolmentId: 'x',
    });
    expect(trace.outcome).toEqual({ kind: 'limit', steps: 200 });
    expect(trace.steps).toHaveLength(200);
  });
});

describe('stop conditions in a test run', () => {
  const steps = {
    wait_week: { type: 'wait', config: { duration: 'P7D' }, next: 'nudge' },
    nudge: { type: 'sms.send', config: { message: 'Still interested?' } },
  };
  const test = (
    stopWhen: unknown,
    values: Parameters<typeof simulateAutomation>[0]['values'],
    events: Parameters<typeof simulateAutomation>[0]['events'],
  ) =>
    simulateAutomation({
      document: automationDocument.parse({
        name: 'Nudge',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        stopWhen,
        start: 'wait_week',
        steps,
      }),
      values,
      events,
      start,
      timeZone: 'UTC',
      enrolmentId: 't',
    });

  it('stops on an event only when the stop condition holds for the contact', () => {
    const stopWhen = [
      {
        event: 'deal.closed',
        if: { field: 'deal.status', operator: 'equals', value: 'won' },
      },
    ];
    const closed = [{ event: 'deal.closed', after: 'P2D' }];
    expect(test(stopWhen, { 'deal.status': 'won' }, closed)).toEqual({
      steps: [
        {
          step: 'wait_week',
          type: 'wait',
          kind: 'waited',
          at: start,
          explanation: 'Waiting 7 days, until 2026-10-16T09:00:00.000Z.',
        },
      ],
      outcome: { kind: 'stopped', event: 'deal.closed', at: new Date('2026-10-11T09:00:00Z') },
    });
    const lost = test(stopWhen, { 'deal.status': 'lost' }, closed);
    expect(lost.outcome).toEqual({ kind: 'completed' });
    expect(lost.steps.map((each) => each.step)).toEqual(['wait_week', 'nudge']);
  });

  it('carries on through a simulated reply when the stop is for messages from the team', () => {
    const reply = [{ event: 'message.received', after: 'P1D' }];
    expect(test([{ event: 'message.received', from: 'team' }], {}, reply).outcome).toEqual({
      kind: 'completed',
    });
    expect(test([{ event: 'message.received' }], {}, reply).outcome).toEqual({
      kind: 'stopped',
      event: 'message.received',
      at: new Date('2026-10-10T09:00:00Z'),
    });
  });

  it('stops on the first of several events that end the run', () => {
    const trace = test([{ event: 'appointment.booked' }, { event: 'deal.closed' }], {}, [
      { event: 'deal.closed', after: 'P5D' },
      { event: 'appointment.booked', after: 'P3D' },
    ]);
    expect(trace.outcome).toEqual({
      kind: 'stopped',
      event: 'appointment.booked',
      at: new Date('2026-10-12T09:00:00Z'),
    });
  });
});

describe('a test run that cannot go on', () => {
  const test = (steps: unknown) =>
    simulateAutomation({
      document: automationDocument.parse({
        name: 'Broken',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: 'tag',
        steps,
      }),
      values: {},
      events: [],
      start,
      timeZone: 'UTC',
      enrolmentId: 't',
    });

  it('fails at a next that names a step the document does not have', () => {
    const trace = test({ tag: { type: 'tag.add', config: { tag: 'New' }, next: 'gone' } });
    expect(trace.outcome).toEqual({ kind: 'failed', step: 'gone', error: 'missing_step' });
    expect(trace.steps.map((each) => [each.step, each.kind])).toEqual([['tag', 'would_change']]);
  });

  it('fails at a wait that ends beyond the last date there is, keeping the steps before it', () => {
    const trace = test({
      tag: { type: 'tag.add', config: { tag: 'New' }, next: 'forever' },
      forever: { type: 'wait', config: { duration: 'P300000Y' }, next: 'never' },
      never: { type: 'sms.send', config: { message: 'Hello' } },
    });
    expect(trace.outcome).toEqual({ kind: 'failed', step: 'forever', error: 'date_out_of_range' });
    expect(trace.steps.map((each) => each.step)).toEqual(['tag']);
  });
});

describe('a test run with a wait until a date', () => {
  const test = (config: unknown, values: Parameters<typeof simulateAutomation>[0]['values']) =>
    simulateAutomation({
      document: automationDocument.parse({
        name: 'Reminder',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: 'until',
        steps: {
          until: { type: 'wait.until', config, next: 'remind' },
          remind: { type: 'sms.send', config: { message: 'See you soon.' } },
        },
      }),
      values,
      events: [],
      start,
      timeZone: 'Africa/Nairobi',
      enrolmentId: 't',
    });
  const eventDate = { field: 'contact.custom.event_date', time: '09:00' };

  it('fast-forwards to the date, at its time in the time zone', () => {
    const trace = test(eventDate, { 'contact.custom.event_date': '2026-10-20' });
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps.map((each) => [each.step, each.kind, each.at.toISOString()])).toEqual([
      ['until', 'waited', '2026-10-09T09:00:00.000Z'],
      ['until', 'waited', '2026-10-20T06:00:00.000Z'],
      ['remind', 'would_send', '2026-10-20T06:00:00.000Z'],
    ]);
  });

  it('goes on at once, on no branch, when the date has passed or the contact has none', () => {
    expect(test({ at: '2026-01-01T00:00:00Z' }, {}).steps).toEqual([
      {
        step: 'until',
        type: 'wait.until',
        kind: 'waited',
        at: start,
        explanation: '2026-01-01T00:00:00.000Z has passed, so it went on at once.',
      },
      {
        step: 'remind',
        type: 'sms.send',
        kind: 'would_send',
        at: start,
        explanation: 'Would send text; nothing is sent or changed in a test run.',
      },
    ]);
    const missing = test(eventDate, {});
    expect(missing.steps[0]).toEqual({
      step: 'until',
      type: 'wait.until',
      kind: 'waited',
      at: start,
      explanation: 'contact.custom.event_date has no date, so there was nothing to wait for.',
    });
    expect(missing.steps[0]).not.toHaveProperty('branch');
    expect(missing.steps[1]?.at).toEqual(start);
  });
});

describe('a test run with a wait for a reply', () => {
  const document = automationDocument.parse({
    name: 'Reply or nudge',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'wait_reply',
    steps: {
      wait_reply: {
        type: 'wait.event',
        config: { event: 'message.received', timeout: 'P3D' },
        next: { received: 'thanks', timed_out: 'nudge' },
      },
      thanks: { type: 'tag.add', config: { tag: 'Replied' } },
      nudge: { type: 'sms.send', config: { message: 'Still interested?' } },
    },
  });
  const test = (events: Parameters<typeof simulateAutomation>[0]['events']) =>
    simulateAutomation({ document, values: {}, events, start, timeZone: 'UTC', enrolmentId: 't' });

  it('takes received when the simulated reply comes before the timeout', () => {
    const trace = test([{ event: 'message.received', after: 'P1D' }]);
    // The wait, then the same step again when it is woken: the branch it took, and why.
    expect(trace.steps.map((each) => [each.step, each.kind, each.at.toISOString()])).toEqual([
      ['wait_reply', 'waited', '2026-10-09T09:00:00.000Z'],
      ['wait_reply', 'branched', '2026-10-10T09:00:00.000Z'],
      ['thanks', 'would_change', '2026-10-10T09:00:00.000Z'],
    ]);
    expect(trace.steps[1]).toMatchObject({
      branch: 'received',
      explanation: 'message.received arrived, so the received branch was taken.',
    });
  });

  it('takes timed_out when it comes after, or not at all', () => {
    expect(
      test([{ event: 'message.received', after: 'P4D' }]).steps.map((each) => each.step),
    ).toEqual(['wait_reply', 'wait_reply', 'nudge']);
    const silent = test([]);
    expect(silent.steps.map((each) => [each.step, each.at.toISOString()])).toEqual([
      ['wait_reply', '2026-10-09T09:00:00.000Z'],
      ['wait_reply', '2026-10-12T09:00:00.000Z'],
      ['nudge', '2026-10-12T09:00:00.000Z'],
    ]);
    expect(silent.steps[1]).toMatchObject({
      kind: 'branched',
      branch: 'timed_out',
      explanation: 'No message.received came before the timeout.',
    });
  });

  it('waits only for its own event, so another kind of event does not count as the reply', () => {
    expect(
      test([{ event: 'form.submitted', after: 'P1D' }]).steps.map((each) => each.step),
    ).toEqual(['wait_reply', 'wait_reply', 'nudge']);
  });

  const withStop = (next: unknown, events: Parameters<typeof simulateAutomation>[0]['events']) =>
    simulateAutomation({
      document: automationDocument.parse({
        name: 'Reply, booking or nudge',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        stopWhen: [{ event: 'appointment.booked' }],
        start: 'wait_reply',
        steps: {
          wait_reply: {
            type: 'wait.event',
            config: { event: 'message.received', timeout: 'P3D' },
            ...(next === undefined ? {} : { next }),
          },
          thanks: { type: 'tag.add', config: { tag: 'Replied' } },
          nudge: { type: 'sms.send', config: { message: 'Still interested?' } },
        },
      }),
      values: {},
      events,
      start,
      timeZone: 'UTC',
      enrolmentId: 't',
    });
  const branches = { received: 'thanks', timed_out: 'nudge' };

  it('stops when a stop event comes while it waits, before the reply or the timeout', () => {
    const booked = { kind: 'stopped', event: 'appointment.booked' };
    const beforeReply = withStop(branches, [
      { event: 'appointment.booked', after: 'PT12H' },
      { event: 'message.received', after: 'P1D' },
    ]);
    expect(beforeReply.outcome).toEqual({ ...booked, at: new Date('2026-10-09T21:00:00Z') });
    expect(beforeReply.steps.map((each) => each.step)).toEqual(['wait_reply']);
    const beforeTimeout = withStop(branches, [{ event: 'appointment.booked', after: 'P2D' }]);
    expect(beforeTimeout.outcome).toEqual({ ...booked, at: new Date('2026-10-11T09:00:00Z') });
    expect(beforeTimeout.steps.map((each) => each.step)).toEqual(['wait_reply']);
  });

  it('takes received when the stop event only comes after the reply', () => {
    const trace = withStop(branches, [
      { event: 'message.received', after: 'P1D' },
      { event: 'appointment.booked', after: 'P2D' },
    ]);
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps.map((each) => each.step)).toEqual(['wait_reply', 'wait_reply', 'thanks']);
  });

  it('ends the path when the branch taken names no step', () => {
    const reply = [{ event: 'message.received', after: 'P1D' }];
    const onlyReceived = withStop({ received: 'thanks' }, []);
    expect(onlyReceived.outcome).toEqual({ kind: 'completed' });
    // The wait, and the branch it took when it timed out; that branch leads nowhere.
    expect(onlyReceived.steps.map((each) => [each.step, each.branch])).toEqual([
      ['wait_reply', undefined],
      ['wait_reply', 'timed_out'],
    ]);
    expect(withStop({ received: 'thanks' }, reply).steps.map((each) => each.step)).toEqual([
      'wait_reply',
      'wait_reply',
      'thanks',
    ]);
    const noNext = withStop(undefined, reply);
    expect(noNext.outcome).toEqual({ kind: 'completed' });
    expect(noNext.steps.map((each) => [each.step, each.branch])).toEqual([
      ['wait_reply', undefined],
      ['wait_reply', 'received'],
    ]);
  });
});

describe('a step the engine cannot run yet', () => {
  it('fails the test run where a real run would fail, rather than describe it as done', () => {
    const trace = simulateAutomation({
      document: automationDocument.parse({
        name: 'Tag, then tell',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: 'tag',
        steps: {
          tag: { type: 'tag.add', config: { tag: 'VIP' }, next: 'tell' },
          tell: { type: 'ai.ask', config: { prompt: 'What did they ask for?' } },
        },
      }),
      values: {},
      events: [],
      start: new Date('2026-10-09T09:00:00Z'),
      timeZone: 'UTC',
      enrolmentId: 't',
    });
    expect(trace.steps.map((each) => [each.step, each.kind])).toEqual([['tag', 'would_change']]);
    expect(trace.outcome).toEqual({ kind: 'failed', step: 'tell', error: 'not_implemented' });
  });
});
