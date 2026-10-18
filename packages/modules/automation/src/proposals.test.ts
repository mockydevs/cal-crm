import { expect, it } from 'vitest';
import { createAutomationProposables } from './proposals.js';

it('uses the native publish command and refuses an invalid draft version', () => {
  const [proposal] = createAutomationProposables({
    setup: () => Promise.reject(new Error('Not needed for input validation')),
  });
  expect(proposal?.commandName).toBe('automation.publish');
  expect(proposal?.permission).toBe('automations.publish');
  expect(() => proposal?.check({ id: 'invalid', baseDraftVersion: -1 })).toThrow();
});
