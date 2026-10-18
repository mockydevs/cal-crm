import type { Invocation } from '@repo/commands';
import type { Permission } from '@repo/contracts';
import { ForbiddenError } from '@repo/kernel';
import { expect, it } from 'vitest';
import { refreshAssistantInvocation } from './assistant-permissions.js';

it('uses the person’s current permissions instead of the grants captured at turn start', async () => {
  const invocation: Invocation = {
    context: {
      agencyId: '01890a5d-ac96-774b-bcce-b302099a8050',
      actorKind: 'ai_agent',
      correlationId: '01890a5d-ac96-774b-bcce-b302099a8053',
    },
    permissions: new Set<Permission>(['assistant.use', 'forms.manage']),
  };
  const current = new Set<Permission>(['assistant.use']);
  expect(
    (await refreshAssistantInvocation(invocation, () => Promise.resolve(current))).permissions,
  ).toBe(current);
  await expect(
    refreshAssistantInvocation(invocation, () => Promise.resolve(undefined)),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    refreshAssistantInvocation(invocation, () => Promise.resolve(new Set())),
  ).rejects.toBeInstanceOf(ForbiddenError);
});
