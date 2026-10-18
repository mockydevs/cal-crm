// What an automation's "Notify the team" step writes (AUTOMATIONS.md section 3): a
// notification to team members, in the words the step was given. It goes to the people of
// the business only, through the same door as every other notification, so membership, each
// person's preferences, the ceiling and "once per source" all hold for it.
import { requireBusiness } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';

import { deliver } from './deliver.js';
import { everyoneIn } from './recipients.js';

export interface TeamNotice {
  /** Everyone with a membership of the business, or the people named. */
  readonly to: 'everyone' | readonly string[];
  /** The step's words, with its merge fields already filled in. */
  readonly message: string;
  /** The automation the step belongs to, and its name as the notification's title. */
  readonly automation: { readonly id: string; readonly name: string };
  /** The record the run is on, if it is a contact, company or deal. */
  readonly recordId?: string | undefined;
  /** The visit to the step: the notice is written once for it, however often its job runs. */
  readonly visitKey: string;
}

/**
 * Tells team members what an automation step says, and gives the ids of those told.
 * Someone named who does not belong to the business is told nothing: a contact, or
 * anyone outside the team, can never be reached this way.
 */
export async function notifyTeam(
  trx: DatabaseTransaction,
  context: TenantContext,
  notice: TeamNotice,
): Promise<string[]> {
  const businessId = requireBusiness(context);
  return deliver(trx, context, {
    kind: 'automation.notice',
    recipients: notice.to === 'everyone' ? await everyoneIn(trx, businessId) : notice.to,
    sourceKey: notice.visitKey,
    cause: { kind: 'automation', id: notice.automation.id },
    subject: { kind: 'automation', id: notice.automation.id },
    recordId: notice.recordId,
    title: notice.automation.name,
    body: notice.message,
  });
}
