import { expect, it } from 'vitest';
import { inviteMemberInput } from './team.js';
it('normalizes the invited email and rejects invalid email and role ids', () => {
  const roleId = 'role_01h455vb4pex5vsknk084sn02q';
  expect(inviteMemberInput.parse({ email: ' RILEY@Example.test ', roleId }).email).toBe(
    'riley@example.test',
  );
  expect(inviteMemberInput.safeParse({ email: 'not-an-email', roleId }).success).toBe(false);
  expect(
    inviteMemberInput.safeParse({ email: 'riley@example.test', roleId: 'member' }).success,
  ).toBe(false);
});
