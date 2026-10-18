import type { DatabaseTransaction } from '@repo/db';
import { requireBusiness } from '@repo/commands';
import { NotFoundError, type TenantContext } from '@repo/kernel';

import { mergedText } from './actions-text.js';
import { runValues } from './run-values.js';

/** The notification service is composed by the server, which owns both modules. */
export type NotifyAutomationTeam = (
  trx: DatabaseTransaction,
  context: TenantContext,
  notice: {
    readonly to: 'everyone' | readonly string[];
    readonly message: string;
    readonly automation: { readonly id: string; readonly name: string };
    readonly recordId: string;
    readonly visitKey: string;
  },
) => Promise<readonly string[]>;

export async function notifyStepTeam(
  trx: DatabaseTransaction,
  context: TenantContext,
  notify: NotifyAutomationTeam,
  input: {
    readonly enrolmentId: string;
    readonly recordId: string;
    readonly visitKey: string;
    /**
     * contact_owner tells the owner, and nobody when the contact has none;
     * owner_or_everyone tells the owner, or everyone when there is none to tell.
     */
    readonly to: 'everyone' | 'contact_owner' | 'owner_or_everyone';
    readonly message: string;
  },
): Promise<number> {
  const businessId = requireBusiness(context);
  const automation = await trx
    .selectFrom('automation.enrolments as run')
    .innerJoin('automation.automations as automation', 'automation.id', 'run.automation_id')
    .select(['automation.id', 'automation.name'])
    .where('run.id', '=', input.enrolmentId)
    .where('run.business_id', '=', businessId)
    .where('run.record_id', '=', input.recordId)
    .executeTakeFirst();
  if (automation === undefined) throw new NotFoundError('automation_run', input.enrolmentId);
  const message = mergedText(
    { title: '', notes: input.message },
    await runValues(trx, input.recordId, input.enrolmentId),
  ).notes;
  const owner =
    input.to === 'everyone'
      ? undefined
      : await trx
          .selectFrom('crm.contacts')
          .select('owner_user_id')
          .where('id', '=', input.recordId)
          .where('business_id', '=', businessId)
          .executeTakeFirst();
  const ownerId = owner?.owner_user_id ?? null;
  const recipients =
    input.to === 'everyone'
      ? 'everyone'
      : ownerId !== null
        ? [ownerId]
        : input.to === 'owner_or_everyone'
          ? 'everyone'
          : [];
  const told = await notify(trx, context, {
    to: recipients,
    message,
    automation,
    recordId: input.recordId,
    visitKey: input.visitKey,
  });
  return told.length;
}
