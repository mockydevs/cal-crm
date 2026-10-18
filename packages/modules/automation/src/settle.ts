// Ending what is still open of a run. A step row is 'waiting', and unfinished, only while
// its run waits at it: when the run goes on, the wait succeeded; when the run is stopped or
// cancelled in the wait, the rest of it was skipped. Either way the row then says so, and
// the statistics, which count rows by status, stay true.
import type { DatabaseTransaction } from '@repo/db';
import { sql, type RawBuilder } from 'kysely';

/** Closes an enrolment's waiting step rows, as succeeded or as skipped. */
export async function settleWaitingSteps(
  trx: DatabaseTransaction,
  enrolmentId: string,
  as: 'succeeded' | 'skipped',
): Promise<void> {
  await trx
    .updateTable('automation.step_runs')
    .set({ status: as, finished_at: sql<Date>`now()` })
    .where('enrolment_id', '=', enrolmentId)
    .where('status', '=', 'waiting')
    .execute();
}

/** Why a run was cancelled when its automation was deleted. */
export const AUTOMATION_DELETED = 'automation_deleted';

/** A run that was ended, with what telling of it needs. */
export interface EndedRun {
  readonly id: string;
  readonly record_id: string;
  readonly automation_id: string;
}

// The one statement that ends runs still going: each takes the status and the reason,
// listens for nothing more, and its wait is closed as skipped. `which` names the runs, as a
// condition on automation.enrolments e. What follows it reads `ended`.
const ending = (which: RawBuilder<unknown>, status: 'cancelled' | 'exited', reason: string) => sql`
  with ended as (
    update automation.enrolments e
    set status = ${status}, exit_reason = ${reason}, current_step = null,
        wake_at = null, finished_at = now(), updated_at = now()
    where ${which} and e.status in ('running', 'waiting')
    returning e.id, e.record_id, e.automation_id
  ),
  unheard as (
    delete from automation.event_waits w using ended where w.enrolment_id = ended.id
  ),
  closed as (
    update automation.step_runs s set status = 'skipped', finished_at = now()
    from ended where s.enrolment_id = ended.id and s.status = 'waiting'
  )`;

/**
 * Cancels the runs still going of a deleted automation, or one such run: each ends as
 * cancelled, with the reason, listens for nothing more, and its wait is closed as skipped.
 * One statement, so thousands of runs are ended without being read. Gives how many.
 */
export async function cancelRuns(
  trx: DatabaseTransaction,
  of: { readonly automationId: string } | { readonly enrolmentId: string },
): Promise<number> {
  const which =
    'automationId' in of
      ? sql`e.automation_id = ${of.automationId}`
      : sql`e.id = ${of.enrolmentId}`;
  const { rows } = await sql<{ cancelled: number }>`
    ${ending(which, 'cancelled', AUTOMATION_DELETED)}
    select count(*)::int as cancelled from ended
  `.execute(trx);
  return rows[0]?.cancelled ?? 0;
}

/**
 * Ends the runs still going that `which` names (a condition on automation.enrolments e) as
 * exited, with the reason, by the same statement a deletion cancels with: nothing more is
 * listened for, and the wait each was in is closed as skipped. Gives the runs it ended, so
 * each can be told of.
 */
export async function exitRuns(
  trx: DatabaseTransaction,
  which: RawBuilder<unknown>,
  reason: string,
): Promise<readonly EndedRun[]> {
  const { rows } = await sql<EndedRun>`
    ${ending(which, 'exited', reason)}
    select id, record_id, automation_id from ended order by id
  `.execute(trx);
  return rows;
}
