// What the worker is given to run: the delivery task exists only with a vault to open the
// signing secret, and the rest (matching, starting a record again after a run, steps)
// never depends on one.
import { describe, expect, it } from 'vitest';

import { createAutomationTasks } from './index.js';

const tasks = {
  actorNames: {},
  assignees: {
    resolve: () => Promise.resolve(null),
    read: () => Promise.resolve({ items: [], nextCursor: null }),
    memberships: () => Promise.resolve(new Map<string, string>()),
  },
};

describe('the automation worker tasks', () => {
  it('runs matching, steps and email checks without a vault, and has no delivery task', () => {
    expect(createAutomationTasks({ tasks }).map((task) => task.name)).toEqual([
      'automations.match_event',
      'automations.start_again',
      'automations.run_step',
      'automations.check_email',
    ]);
  });

  it('adds webhook delivery when the worker has a vault', () => {
    const vault = { read: () => Promise.reject(new Error('Not opened here.')) };
    expect(createAutomationTasks({ tasks, vault }).map((task) => task.name)).toEqual([
      'automations.match_event',
      'automations.start_again',
      'automations.run_step',
      'automations.check_email',
      'automations.call_webhook',
    ]);
  });
});
