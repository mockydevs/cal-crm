import type { AutomationNamed } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { readUserNames } from '@repo/module-auth';
import { readTaskAssignees, type EligibleTaskMember } from '@repo/module-tenancy';

/** Compose tenancy's eligible people and auth's visible names within one tenant. */
export async function readAutomationUsers(
  trx: DatabaseTransaction,
  context: TenantContext,
): Promise<readonly AutomationNamed[]> {
  const members: EligibleTaskMember[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await readTaskAssignees(trx, context, after);
    members.push(...page.items);
    if (page.nextCursor === null) break;
    after = page.nextCursor;
  }
  const names = await readUserNames(
    trx,
    members.map((member) => member.userId),
  );
  return members.flatMap((member) => {
    const name = names.get(member.userId);
    return name === undefined ? [] : [{ id: member.id, name }];
  });
}
