// Queueing an enrolment's step. On its own so the runner, the waits and the matcher can
// each queue one without importing each other.
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

/** Queues the enrolment's current step, after locking its row (enrolment, then job). */
export async function queueStep(
  trx: DatabaseTransaction,
  enrolmentId: string,
  runAt?: Date,
): Promise<void> {
  await sql`select private.enqueue_automation_step(${enrolmentId}::uuid, ${runAt ?? null}::timestamptz)`.execute(
    trx,
  );
}
