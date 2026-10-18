// Failure handling, planned: when a failed step is tried again, where a run goes when a
// step fails for good, and the same in a test run. The engine's side through real runs is
// in failures.int.test.ts.
import { automationDocument, automationStep, type AutomationStep } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { simulateAutomation } from './simulate.js';
import { failurePath, retryTime } from './steps.js';

const at = (iso: string) => new Date(iso);
const now = at('2027-03-01T10:00:00Z');
const step = (input: unknown): AutomationStep => automationStep.parse(input);
const tagging = (more: Record<string, unknown> = {}) =>
  step({ type: 'tag.add', config: { tag: 'tag_vip' }, next: 'after', ...more });

describe('trying a failed step again', () => {
  it('waits a minute, then twice as long each time, while tries are left', () => {
    const retried = tagging({ retry: { times: 3 } });
    expect(retryTime(retried, 'conflict', 1, now)).toEqual(at('2027-03-01T10:01:00Z'));
    expect(retryTime(retried, 'conflict', 2, now)).toEqual(at('2027-03-01T10:02:00Z'));
    expect(retryTime(retried, 'conflict', 3, now)).toEqual(at('2027-03-01T10:04:00Z'));
    // Three retries are used up by the fourth failure.
    expect(retryTime(retried, 'conflict', 4, now)).toBeUndefined();
  });

  it('takes its own first wait, and keeps it when the backoff is fixed', () => {
    const fixed = tagging({ retry: { times: 5, wait: 'PT10M', backoff: 'fixed' } });
    expect(retryTime(fixed, 'conflict', 1, now)).toEqual(at('2027-03-01T10:10:00Z'));
    expect(retryTime(fixed, 'conflict', 4, now)).toEqual(at('2027-03-01T10:10:00Z'));
    const doubling = tagging({ retry: { times: 5, wait: 'PT10M', backoff: 'double' } });
    expect(retryTime(doubling, 'conflict', 3, now)).toEqual(at('2027-03-01T10:40:00Z'));
  });

  it('retries the three reasons that can pass, and no other', () => {
    const retried = tagging({ retry: { times: 3 } });
    for (const reason of ['conflict', 'mailbox_unavailable', 'number_unavailable'])
      expect(retryTime(retried, reason, 1, now)).toBeInstanceOf(Date);
    for (const reason of ['notfound', 'missing_values', 'no_consent', 'unknown_field', 'forbidden'])
      expect(retryTime(retried, reason, 1, now)).toBeUndefined();
  });

  it('retries nothing without a retry, on a step that is not retried, or with a wait that is none', () => {
    expect(retryTime(tagging(), 'conflict', 1, now)).toBeUndefined();
    // A stored document is not validated again when it runs, so the engine checks too.
    const waiting = { type: 'wait', config: { duration: 'P1D' }, retry: { times: 2 } };
    expect(retryTime(waiting as AutomationStep, 'conflict', 1, now)).toBeUndefined();
    const unreadable = { ...tagging(), retry: { times: 2, wait: 'soon' } };
    expect(retryTime(unreadable as AutomationStep, 'conflict', 1, now)).toBeUndefined();
    const endless = { ...tagging(), retry: { times: 2, wait: 'P300000Y' } };
    expect(retryTime(endless as AutomationStep, 'conflict', 1, now)).toBeUndefined();
    // A wait that doubles past the last date there is ends the retries.
    const far = { ...tagging(), retry: { times: 5, wait: 'P200000Y' } };
    expect(retryTime(far as AutomationStep, 'conflict', 3, now)).toBeUndefined();
  });
});

describe('where a run goes when a step fails for good', () => {
  it('stops unless the step says otherwise', () => {
    expect(failurePath(tagging())).toBeUndefined();
    expect(failurePath(tagging({ onFailure: 'stop' }))).toBeUndefined();
  });

  it('goes on to the next step, or ends there when there is none', () => {
    expect(failurePath(tagging({ onFailure: 'continue' }))).toEqual({
      next: 'after',
      branch: null,
      words: 'This step is set to go on when it fails, so the run went on to "after".',
    });
    expect(failurePath(tagging({ onFailure: 'continue', next: undefined }))).toEqual({
      next: null,
      branch: null,
      words:
        'This step is set to go on when it fails, and nothing comes after it, so the run ended here.',
    });
  });

  it('goes to the step named, as the branch failed', () => {
    expect(failurePath(tagging({ onFailure: { goTo: 'rescue' } }))).toEqual({
      next: 'rescue',
      branch: 'failed',
      words: 'This step is set to go to "rescue" when it fails, so the run went on there.',
    });
  });
});

describe('a test run', () => {
  const run = (steps: Record<string, unknown>, tags = [{ id: 'tag_vip', name: 'VIP' }]) =>
    simulateAutomation({
      document: automationDocument.parse({
        name: 'Failures',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: Object.keys(steps)[0],
        steps,
      }),
      values: {},
      events: [],
      start: now,
      timeZone: 'UTC',
      enrolmentId: 'test',
      tags,
    });
  const done = { type: 'wait', config: { duration: 'PT1M' } };
  // A tag the business does not have: the step fails as unknown_reference.
  const unknown = (more: Record<string, unknown>) => ({
    type: 'tag.add',
    config: { tag: 'tag_gone' },
    ...more,
  });

  it('ends at a step that fails, as before', () => {
    expect(run({ a: unknown({ next: 'b' }), b: done })).toEqual({
      steps: [],
      outcome: { kind: 'failed', step: 'a', error: 'unknown_reference' },
    });
  });

  it('goes on past a step set to continue, and says the step would fail', () => {
    const trace = run({ a: unknown({ next: 'b', onFailure: 'continue' }), b: done });
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps[0]).toEqual({
      step: 'a',
      type: 'tag.add',
      kind: 'moved',
      at: now,
      explanation:
        'Would fail here (unknown_reference). This step is set to go on when it fails, so the run went on to "b".',
    });
    expect(trace.steps.map((each) => each.step)).toEqual(['a', 'b']);
  });

  it('ends as completed when a step set to continue fails and nothing comes after it', () => {
    const trace = run({ a: unknown({ onFailure: 'continue' }) });
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps).toHaveLength(1);
  });

  it('takes the failed path, as a branch', () => {
    const trace = run({
      a: unknown({ next: 'b', onFailure: { goTo: 'rescue' } }),
      b: done,
      rescue: done,
    });
    expect(trace.steps[0]).toMatchObject({ step: 'a', kind: 'branched', branch: 'failed' });
    expect(trace.steps.map((each) => each.step)).toEqual(['a', 'rescue']);
  });

  it('follows the policy for a step the engine cannot run and for one that cannot be planned', () => {
    const unavailable = run({
      a: { type: 'ai.ask', config: { prompt: 'Why?' }, next: 'b', onFailure: 'continue' },
      b: done,
    });
    expect(unavailable.steps[0]?.explanation).toContain('Would fail here (not_implemented).');
    expect(unavailable.outcome).toEqual({ kind: 'completed' });
    const unplanned = run({
      a: {
        type: 'wait.until',
        config: { field: 'contact.custom.event_date' },
        next: 'b',
        onFailure: { goTo: 'c' },
      },
      b: done,
      c: done,
    });
    // No date to plan with here: the wait goes on at once, and nothing fails.
    expect(unplanned.steps.map((each) => each.step)).toEqual(['a', 'b']);
  });
});
