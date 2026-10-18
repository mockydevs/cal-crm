// A contact moved to the trash leaves its workflows, as GoHighLevel removes a deleted
// contact from its workflows: each run still going ends as exited, contact_trashed, and is
// told of as automation.run.stopped. The trash's own event ends them at once
// (enrolment.ts), and a step that finds its contact in the trash ends its run before doing
// anything (runner.ts), so a run never acts on a trashed contact and never fails, or
// retries, because the contact's commands refuse it.
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { sql, type RawBuilder } from 'kysely';

import { exitRuns } from './settle.js';
import type { EmitEvent } from './stops.js';

/** Why a run ended when its contact was moved to the trash. */
export const CONTACT_TRASHED = 'contact_trashed';

/** Whether the record is a contact in the trash. */
export async function inTrash(trx: DatabaseTransaction, recordId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('crm.contacts')
    .select('id')
    .where('id', '=', recordId)
    .where('deleted_at', 'is not', null)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Ends the runs still going that `which` names (a condition on automation.enrolments e), as
 * their contact is in the trash, and tells of each. Gives the runs ended.
 */
export async function endTrashedRuns(
  trx: DatabaseTransaction,
  which: RawBuilder<unknown>,
  emit: EmitEvent | undefined,
): Promise<readonly string[]> {
  const ended = await exitRuns(trx, which, CONTACT_TRASHED);
  if (emit !== undefined)
    for (const run of ended)
      await emit({
        type: 'automation.run.stopped',
        subject: { kind: 'automation_run', id: run.id },
        records: [run.record_id],
        payload: {
          automationId: toPublicId('automation', run.automation_id),
          reason: CONTACT_TRASHED,
        },
      });
  return ended.map((run) => run.id);
}

/** The runs still going of these contacts, when they are in the trash. */
export const trashedContactsRuns = (recordIds: readonly string[]): RawBuilder<unknown> =>
  sql`e.record_id = any(${[...recordIds]}::uuid[]) and exists (
    select 1 from crm.contacts c
    where c.id = e.record_id and c.business_id = e.business_id and c.deleted_at is not null)`;
