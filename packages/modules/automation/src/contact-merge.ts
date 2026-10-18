// Automation's part in a contact merge (crm contacts/merge.ts). Runs of the contact merged
// away carry on as the contact kept's, as GoHighLevel moves active workflows to the master;
// where the master is already in that workflow, its own run is kept and the other ends as
// exited, contact_merged. What a run listens for, and the trigger bookkeeping that says a
// date trigger fired, move with it.
//
// Locks, in `lock`, before any contact's row: the record's runs (lockRecordRuns), as every
// writer that starts or ends more than one run of a record takes them; then the live runs'
// rows, sorted by id, as a step holds its run's row before it touches the contact. A step
// therefore either finishes before the merge reads its run, or waits for the merge and then
// finds its run moved.
import { requireBusiness, type CommandContext } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import {
  countContactRows,
  moveContactRows,
  type ContactMergeParticipant,
  type MergeCounts,
} from '@repo/module-crm';
import { sql } from 'kysely';

import { lockRecordRuns } from './enrolment.js';
import { exitRuns } from './settle.js';

/** Why a run ended when its contact was merged into one already in the workflow. */
export const CONTACT_MERGED = 'contact_merged';

const plainRows = {
  // A manual action waits at a step of a run, which moves to the contact kept.
  manualActions: { table: 'automation.manual_actions', column: 'contact_id' },
} as const;

const counted = {
  runs: { table: 'automation.enrolments', column: 'record_id' },
  waits: { table: 'automation.event_waits', column: 'record_id' },
  triggerFirings: { table: 'automation.trigger_firings', column: 'record_id' },
  triggerEvaluations: { table: 'automation.trigger_evaluations', column: 'record_id' },
  ...plainRows,
} as const;

const affected = (result: { numAffectedRows?: bigint }): number =>
  Number(result.numAffectedRows ?? 0n);

async function mergeRuns(
  trx: DatabaseTransaction,
  command: CommandContext,
  move: { readonly from: string; readonly into: string },
): Promise<MergeCounts> {
  const businessId = requireBusiness(command.context);
  const { from, into } = move;
  // The kept contact is in that workflow already: its run stays, the other ends.
  const ended = await exitRuns(
    trx,
    sql`e.business_id = ${businessId} and e.record_id = ${from} and exists (
      select 1 from automation.enrolments k
      where k.business_id = e.business_id and k.automation_id = e.automation_id
        and k.record_id = ${into} and k.status in ('running', 'waiting'))`,
    CONTACT_MERGED,
  );
  for (const run of ended)
    await command.emit({
      type: 'automation.run.stopped',
      subject: { kind: 'automation_run', id: run.id },
      records: [into],
      payload: {
        automationId: toPublicId('automation', run.automation_id),
        reason: CONTACT_MERGED,
      },
    });
  // Every other run, finished ones too (re-enrolment "never" counts them), is the kept
  // contact's. The re-entry key of a contact's run is its record id, so a live run keeps
  // its place in the one-live-run-per-record rule.
  const runs = affected(
    await sql`
      update automation.enrolments set record_id = ${into},
        reentry_key = case when reentry_key = ${from}::uuid then ${into}::uuid else reentry_key end
      where business_id = ${businessId} and record_id = ${from}
    `.execute(trx),
  );
  const waits = affected(
    await sql`
      update automation.event_waits set record_id = ${into}
      where business_id = ${businessId} and record_id = ${from}
    `.execute(trx),
  );
  // What fired for a record, and why a trigger didn't: on a clash the kept contact's row
  // stays, so a date trigger that fired for it once does not fire again.
  await sql`
    delete from automation.trigger_firings l
    where l.business_id = ${businessId} and l.record_id = ${from} and exists (
      select 1 from automation.trigger_firings k
      where k.business_id = l.business_id and k.automation_id = l.automation_id
        and k.trigger_id = l.trigger_id and k.record_id = ${into} and k.occurrence = l.occurrence)
  `.execute(trx);
  const triggerFirings = affected(
    await sql`
      update automation.trigger_firings set record_id = ${into}
      where business_id = ${businessId} and record_id = ${from}
    `.execute(trx),
  );
  await sql`
    delete from automation.trigger_evaluations l
    where l.business_id = ${businessId} and l.record_id = ${from} and exists (
      select 1 from automation.trigger_evaluations k
      where k.business_id = l.business_id and k.automation_id = l.automation_id
        and k.event_id = l.event_id and k.record_id = ${into}
        and k.trigger_id is not distinct from l.trigger_id)
  `.execute(trx);
  const triggerEvaluations = affected(
    await sql`
      update automation.trigger_evaluations set record_id = ${into}
      where business_id = ${businessId} and record_id = ${from}
    `.execute(trx),
  );
  return {
    runs,
    runsEnded: ended.length,
    waits,
    triggerFirings,
    triggerEvaluations,
    ...(await moveContactRows(trx, businessId, plainRows, move)),
  };
}

/** Automation's part in a contact merge, wired by the server into crm's merge. */
export const automationContactMerge: ContactMergeParticipant = {
  name: 'automation',
  async lock(trx, command, contactIds) {
    for (const id of contactIds) await lockRecordRuns(trx, id);
    await sql`
      select id from automation.enrolments
      where business_id = ${requireBusiness(command.context)}
        and record_id = any (${sql.val(contactIds)}::uuid[]) and status in ('running', 'waiting')
      order by id for update
    `.execute(trx);
  },
  count: (trx, invocation, contactIds, atMost) =>
    countContactRows(trx, requireBusiness(invocation.context), counted, contactIds, atMost),
  merge: mergeRuns,
};
