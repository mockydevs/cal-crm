import type { Invocation } from '@repo/commands';
import type { Permission } from '@repo/contracts';
import { ForbiddenError } from '@repo/kernel';

/** Every step uses current membership grants, including revocation during a turn. */
export async function refreshAssistantInvocation(
  invocation: Invocation,
  read: () => Promise<ReadonlySet<Permission> | undefined>,
): Promise<Invocation & { readonly permissions: ReadonlySet<Permission> }> {
  const permissions = await read();
  if (permissions?.has('assistant.use') !== true)
    throw new ForbiddenError('Assistant access is no longer available.', 'assistant.use');
  return { ...invocation, permissions };
}
