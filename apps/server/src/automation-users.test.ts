import type { DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { readUserNames } from '@repo/module-auth';
import { readTaskAssignees } from '@repo/module-tenancy';
import { beforeEach, expect, it, vi } from 'vitest';
import { readAutomationUsers } from './automation-users.js';

vi.mock('@repo/module-auth', () => ({ readUserNames: vi.fn() }));
vi.mock('@repo/module-tenancy', () => ({ readTaskAssignees: vi.fn() }));

const trx = {} as DatabaseTransaction;
const context: TenantContext = {
  agencyId: '01890a5d-ac96-774b-bcce-b302099a8057',
  businessId: '01890a5d-ac96-774b-bcce-b302099a8058',
  actorKind: 'system',
  correlationId: 'automation-users',
};

beforeEach(() => {
  vi.resetAllMocks();
});

it('includes all eligible member pages and resolves their names once in the same tenant', async () => {
  const members = Array.from({ length: 101 }, (_, index) => ({
    id: `member-${String(index)}`,
    userId: `user-${String(index)}`,
  }));
  vi.mocked(readTaskAssignees)
    .mockResolvedValueOnce({ items: members.slice(0, 50), nextCursor: 'member-49' })
    .mockResolvedValueOnce({ items: members.slice(50, 100), nextCursor: 'member-99' })
    .mockResolvedValueOnce({ items: members.slice(100), nextCursor: null });
  vi.mocked(readUserNames).mockResolvedValue(
    new Map(members.map((member) => [member.userId, `Name ${member.id}`])),
  );
  expect(await readAutomationUsers(trx, context)).toEqual(
    members.map((member) => ({ id: member.id, name: `Name ${member.id}` })),
  );
  expect(readTaskAssignees).toHaveBeenNthCalledWith(1, trx, context, undefined);
  expect(readTaskAssignees).toHaveBeenNthCalledWith(2, trx, context, 'member-49');
  expect(readTaskAssignees).toHaveBeenNthCalledWith(3, trx, context, 'member-99');
  expect(readUserNames).toHaveBeenCalledExactlyOnceWith(
    trx,
    members.map((member) => member.userId),
  );
});

it('omits people whose names the canonical tenant-scoped reader cannot see', async () => {
  vi.mocked(readTaskAssignees).mockResolvedValue({
    items: [
      { id: 'visible-member', userId: 'visible-user' },
      { id: 'hidden-member', userId: 'hidden-user' },
    ],
    nextCursor: null,
  });
  vi.mocked(readUserNames).mockResolvedValue(new Map([['visible-user', 'Dana']]));
  expect(await readAutomationUsers(trx, context)).toEqual([{ id: 'visible-member', name: 'Dana' }]);
});

it('keeps an empty business catalog empty', async () => {
  vi.mocked(readTaskAssignees).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(readUserNames).mockResolvedValue(new Map());
  expect(await readAutomationUsers(trx, context)).toEqual([]);
});
