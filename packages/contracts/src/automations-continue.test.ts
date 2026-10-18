// Continuing a waiting run now: the endpoint, what it takes, and what a run says about
// whether it can be continued.
import { describe, expect, it } from 'vitest';

import { endpoints } from './api.js';
import {
  automationRunSummary,
  continueAutomationRun,
  continueAutomationRunInput,
  retryAutomationRun,
} from './automations-api.js';

const RUN = 'arun_01h455vb4pex5vsknk084sn02q';

const summary = {
  id: RUN,
  automationId: 'aut_01h455vb4pex5vsknk084sn02q',
  automationName: 'Follow up',
  version: 1,
  status: 'waiting',
  recordId: 'con_01h455vb4pex5vsknk084sn02q',
  record: { id: 'con_01h455vb4pex5vsknk084sn02q', name: 'Ada', trashed: false },
  currentStep: 'reply',
  exitReason: null,
  wakeAt: '2026-10-19T09:00:00.000Z',
  startedAt: '2026-10-12T09:00:00.000Z',
  finishedAt: null,
};

describe('the endpoint that continues a run', () => {
  it('is a post beside the retry, in the public API', () => {
    expect(continueAutomationRun).toMatchObject({
      operationId: 'continueAutomationRun',
      method: 'post',
      path: '/automation-runs/{runId}/continue',
      group: 'Automations',
    });
    expect(continueAutomationRun.response.status).toBe(200);
    const listed = endpoints.map((endpoint) => endpoint.operationId);
    expect(listed.indexOf('continueAutomationRun')).toBe(
      listed.indexOf(retryAutomationRun.operationId) + 1,
    );
  });

  it('takes a branch, the revision the run was read at, both or neither', () => {
    for (const body of [
      {},
      { branch: 'timed_out' },
      { revision: '4' },
      { branch: 'no_appointment', revision: '12' },
    ])
      expect(continueAutomationRunInput.parse(body)).toEqual(body);
    for (const body of [{ branch: '' }, { branch: 5 }, { revision: 4 }, { step: 'reply' }])
      expect(continueAutomationRunInput.safeParse(body).success).toBe(false);
  });
});

describe('what a run says about continuing it', () => {
  it('carries its revision and the branches to choose between', () => {
    const parsed = automationRunSummary.parse({
      ...summary,
      revision: '3',
      continuable: { branches: ['received', 'timed_out'] },
    });
    expect(parsed).toMatchObject({
      revision: '3',
      continuable: { branches: ['received', 'timed_out'] },
    });
    expect(automationRunSummary.parse({ ...summary, continuable: null }).continuable).toBeNull();
  });

  it('still reads a run written before either existed', () => {
    const parsed = automationRunSummary.parse(summary);
    expect(parsed.revision).toBeUndefined();
    expect(parsed.continuable).toBeUndefined();
  });
});
