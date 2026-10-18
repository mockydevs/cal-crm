import { expect, it } from 'vitest';
import { mailboxSendingInput } from './index.js';

const settings = {
  dailyLimit: 300,
  pacingPerMinute: 5,
  warmupEnabled: true,
  useForConversations: true,
  useForCampaigns: false,
};
it('accepts explicit mailbox limits and refuses unbounded values and pause/security overrides', () => {
  expect(mailboxSendingInput.parse(settings)).toEqual(settings);
  for (const patch of [
    { dailyLimit: 0 },
    { dailyLimit: 1.5 },
    { dailyLimit: 100_001 },
    { pacingPerMinute: 0 },
    { pacingPerMinute: 601 },
    { warmupEnabled: 'false' },
    { sendingPausedUntil: null },
    { rejectUnauthorized: false },
    { businessId: 'foreign' },
  ])
    expect(mailboxSendingInput.safeParse({ ...settings, ...patch }).success).toBe(false);
});
