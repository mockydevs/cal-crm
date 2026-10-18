import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { comparedValues } from './automation-run-steps';
import {
  explainedFailures,
  explainedStartOutcomes,
  failureWords,
  momentWords,
  outputWords,
  runOutcomeWords,
  runStatuses,
  runStatusWords,
  stepStatusWords,
  stopWords,
  valueWords,
} from './automation-run-words';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const run = (over: {
  status: string;
  currentStep?: string | null;
  exitReason?: string | null;
  wakeAt?: string | null;
}) => ({ currentStep: null, exitReason: null, wakeAt: null, ...over });
const named = (key: string): string => `“${key}”`;

describe('statuses', () => {
  it('have a word each, for runs and for steps', () => {
    expect(runStatuses.map(runStatusWords)).toEqual([
      'Running',
      'Waiting',
      'Finished',
      'Stopped early',
      'Failed',
      'Cancelled',
    ]);
    expect(
      ['succeeded', 'waiting', 'failed', 'running', 'skipped'].map((status) =>
        stepStatusWords(status),
      ),
    ).toEqual(['Done', 'Waiting', 'Failed', 'Running', 'Skipped']);
    // A wait the run has gone on from is over, whatever its row still says.
    expect(stepStatusWords('waiting', true)).toBe('Waited');
    expect(stepStatusWords('succeeded', true)).toBe('Done');
    // A status a later version adds is shown as it is, not hidden.
    expect(runStatusWords('paused')).toBe('paused');
    expect(stepStatusWords('retrying')).toBe('retrying');
  });
});

describe('where a run stands', () => {
  it('says what it is waiting for, or what comes next', () => {
    expect(runOutcomeWords(run({ status: 'waiting' }), named)).toBe('Waiting.');
    expect(
      runOutcomeWords(run({ status: 'waiting', wakeAt: '2026-10-11T09:00:00.000Z' }), named),
    ).toMatch(/^Waiting until Oct 11, 2026, .+\.$/);
    expect(runOutcomeWords(run({ status: 'running', currentStep: 'check_in' }), named)).toBe(
      'Running: next is “check_in”.',
    );
    expect(runOutcomeWords(run({ status: 'running' }), named)).toBe('Running.');
    expect(runOutcomeWords(run({ status: 'running', currentStep: 'x' }), () => undefined)).toBe(
      'Running.',
    );
  });

  it('says how it ended', () => {
    expect(runOutcomeWords(run({ status: 'completed' }), named)).toBe('Went through to the end.');
    expect(runOutcomeWords(run({ status: 'cancelled' }), named)).toBe('Cancelled.');
    expect(
      runOutcomeWords(run({ status: 'exited', exitReason: 'stop:message.received' }), named),
    ).toBe('Stopped early, because this happened: They reply.');
    expect(runOutcomeWords(run({ status: 'exited', exitReason: 'stop:deal.closed' }), named)).toBe(
      'Stopped early, because this happened: Their opportunity is won or lost.',
    );
    expect(runOutcomeWords(run({ status: 'exited', exitReason: 'removed' }), named)).toBe(
      'Stopped early: removed.',
    );
    expect(runOutcomeWords(run({ status: 'exited' }), named)).toBe('Stopped early.');
    expect(runOutcomeWords(run({ status: 'paused' }), named)).toBe('paused');
  });

  it('says why it failed, in words for the reasons a person can act on', () => {
    expect(runOutcomeWords(run({ status: 'failed', exitReason: 'consent_required' }), named)).toBe(
      "Failed: the contact hasn't agreed to marketing messages on this channel.",
    );
    expect(runOutcomeWords(run({ status: 'failed', exitReason: 'do_not_contact' }), named)).toBe(
      'Failed: the contact is marked do not contact.',
    );
    // A reason with no words of its own is shown as the engine names it.
    expect(runOutcomeWords(run({ status: 'failed', exitReason: 'http_error' }), named)).toBe(
      'Failed: http_error.',
    );
    expect(runOutcomeWords(run({ status: 'failed' }), named)).toBe('Failed.');
    expect(failureWords('')).toBeUndefined();
    expect(failureWords(undefined)).toBeUndefined();
    expect(failureWords('not_implemented')).toBe("the step isn't available yet");
  });

  it('has words for every reason it knows: a clause that completes "Failed:"', () => {
    expect(explainedFailures.length).toBeGreaterThan(15);
    for (const reason of explainedFailures) {
      const words = failureWords(reason) ?? '';
      expect(words, reason).not.toBe(reason);
      expect(words, reason).toMatch(/^[a-z].*[^.]$/);
    }
  });

  it('names the stop condition that was met, or the event when it has no words here', () => {
    expect(stopWords('stop:tag.added')).toBe('A tag is added to them');
    expect(stopWords('stop:something.new')).toBe('something.new');
    expect(stopWords('missing_step')).toBeUndefined();
    expect(stopWords(null)).toBeUndefined();
  });
});

describe('what a step was given and produced', () => {
  it('reads a moment in the reader’s locale, and nothing where there is none', () => {
    expect(momentWords('2026-10-09T09:00:00.000Z')).toMatch(/^Oct 9, 2026, /);
    expect(momentWords(null)).toBeUndefined();
    expect(momentWords(undefined)).toBeUndefined();
    expect(momentWords('soon')).toBeUndefined();
  });

  it('writes values as people say them', () => {
    expect([null, undefined, '', []].map(valueWords)).toEqual(['empty', 'empty', 'empty', 'empty']);
    expect(valueWords(['video', 'photo'])).toBe('video, photo');
    expect(valueWords(true)).toBe('yes');
    expect(valueWords(false)).toBe('no');
    expect(valueWords(120)).toBe('120');
    expect(valueWords('Ada')).toBe('Ada');
    expect(valueWords({ nested: 1 })).toBe('{"nested":1}');
  });

  it('lists the values a condition compared, each with its field in words', () => {
    expect(
      comparedValues({
        config: {},
        values: { 'contact.firstName': 'Ada', 'contact.custom.services': ['video'] },
      }),
    ).toEqual([
      { field: 'first name', value: 'Ada' },
      { field: 'services', value: 'video' },
    ]);
    expect(comparedValues({ config: {} })).toEqual([]);
    expect(comparedValues({ values: 'none' })).toEqual([]);
  });

  it('says what a step produced, for the results people ask about', () => {
    expect(outputWords({})).toEqual([]);
    expect(outputWords({ wakeAt: '2026-10-11T09:00:00.000Z' })[0]).toMatch(
      /^Its wait ends Oct 11, 2026, .+\.$/,
    );
    expect(outputWords({ wakeAt: 'never' })).toEqual([]);
    expect(outputWords({ messageId: 'msg_1' })).toEqual(['It queued a message to send.']);
    expect(outputWords({ taskId: 'tsk_1', dealId: 'deal_1' })).toEqual([
      'It created a task.',
      'It created an opportunity.',
    ]);
    expect(outputWords({ status: 202 })).toEqual(['The other app answered with status 202.']);
    expect(outputWords({ variant: 'b' })).toEqual(['It chose variant b.']);
  });

  it('says what starting another automation came to, for every outcome the engine records', () => {
    expect(explainedStartOutcomes.toSorted()).toEqual([
      'already_running',
      'already_went_through',
      'not_active',
      'refused_loop',
      'started',
    ]);
    expect(outputWords({ outcome: 'started', enrolmentId: 'aenr_1' })).toEqual([
      'It started the other automation for this contact.',
    ]);
    expect(outputWords({ outcome: 'already_running' })).toEqual([
      'It started nothing: the contact was already in the other automation.',
    ]);
    expect(outputWords({ outcome: 'already_went_through' })).toEqual([
      'It started nothing: the contact had been through the other automation, which takes a contact once.',
    ]);
    expect(outputWords({ outcome: 'not_active' })).toEqual([
      "It started nothing: the other automation isn't published.",
    ]);
    expect(outputWords({ outcome: 'refused_loop' })).toEqual([
      'It started nothing: the automations would have gone on starting each other.',
    ]);
    // A manual action's outcome is its own, said by its step.
    expect(outputWords({ outcome: 'completed' })).toEqual([]);
    expect(outputWords({ outcome: 'toString' })).toEqual([]);
  });

  it('says why a run that kept looping was ended', () => {
    expect(failureWords('step_visit_limit')).toBe(
      'one action ran 100 times in this run, the most allowed: a path keeps leading back to it',
    );
    expect(failureWords('run_step_limit')).toBe(
      'the run took 5,000 actions, the most one run may take',
    );
  });

  it('says how many runs a removal ended', () => {
    expect(outputWords({ removed: 0 })).toEqual([
      'It ended no run: the contact was in none of those automations.',
    ]);
    expect(outputWords({ removed: 1 })).toEqual(['It ended 1 run of this contact.']);
    expect(outputWords({ removed: 3 })).toEqual(['It ended 3 runs of this contact.']);
    expect(outputWords({ removed: '3' })).toEqual([]);
  });

  it('says when a removal action ended a run, naming its automation where it can', () => {
    const run = {
      status: 'exited',
      currentStep: null,
      exitReason: 'removed:aut_other',
      wakeAt: null,
    };
    expect(runOutcomeWords(run, () => undefined)).toBe(
      'Stopped early: a “Remove from automations” action took the contact out.',
    );
    expect(
      runOutcomeWords(
        run,
        () => undefined,
        (id) => (id === 'aut_other' ? 'Win back' : undefined),
      ),
    ).toBe('Stopped early: a “Remove from automations” action in “Win back” took the contact out.');
    expect(
      runOutcomeWords(
        run,
        () => undefined,
        () => undefined,
      ),
    ).toBe('Stopped early: a “Remove from automations” action took the contact out.');
  });
});
