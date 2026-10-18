import { describe, expect, it } from 'vitest';

import { AI_JOBS, DEFAULT_JOB_MODELS } from '../gateway.js';
import { listed, type TestedEntry } from './entry.js';
import { TESTED } from './tested.gen.js';
import { isTested } from './tested.js';

const entry: TestedEntry = {
  job: 'replies',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  suiteVersion: 'replies/1',
  datasetHash: 'a'.repeat(64),
  passed: 9,
  total: 10,
  score: 0.9,
  testedOn: '2026-10-10',
  report: 'evals/reports/replies/anthropic--claude-sonnet-5-5.json',
};

describe('whether a model is Tested for a job', () => {
  it('is whether the registry lists that job, provider and model together', () => {
    expect(listed([entry], 'replies', 'anthropic', 'claude-sonnet-5-5')).toBe(true);
    expect(listed([entry], 'sorting', 'anthropic', 'claude-sonnet-5-5')).toBe(false);
    expect(listed([entry], 'replies', 'openai', 'claude-sonnet-5-5')).toBe(false);
    expect(listed([entry], 'replies', 'anthropic', 'claude-opus-5-5')).toBe(false);
    expect(listed([], 'replies', 'anthropic', 'claude-sonnet-5-5')).toBe(false);
  });

  it('answers from the registry the record command writes', () => {
    for (const each of TESTED) expect(isTested(each.job, each.provider, each.model)).toBe(true);
    expect(isTested('replies', 'anthropic', 'a-model-nobody-evaluated')).toBe(false);
    for (const job of AI_JOBS) {
      const { provider, model } = DEFAULT_JOB_MODELS[job];
      expect(isTested(job, provider, model)).toBe(listed(TESTED, job, provider, model));
    }
  });
});
