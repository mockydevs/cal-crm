// The opportunity a run has in hand: the deal its deal.move, deal.close and deal.update
// steps act on, and whose values its conditions and merge fields read as deal.*. It is, in
// this order:
//
//   1. the deal the run's latest deal.find found, or its latest deal.create made, whichever
//      came last (automation.enrolments.deal_in_hand_id);
//   2. the deal the run is for, when the enrolled record is a deal. That is how a deal's
//      own event reaches a run: the CRM puts a deal event on the deal's timeline, so
//      deal.stage_changed and deal.closed enrol the deal itself.
//
// Only a run with neither falls back to "the contact's one open deal".
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

/** Where a run's deal in hand comes from. */
export type DealInHand =
  /** A step of this run found or created it. */
  | { readonly id: string; readonly from: 'step' }
  /** The run is for it: the enrolled record is the deal. */
  | { readonly id: string; readonly from: 'run' };

/** The deal the run has in hand, by its stored id, or nothing when it has none. */
export async function readDealInHand(
  trx: DatabaseTransaction,
  enrolmentId: string,
): Promise<DealInHand | undefined> {
  const { rows } = await sql<{
    deal_in_hand_id: string | null;
    record_id: string;
    record_kind: string;
  }>`
    select run.deal_in_hand_id, run.record_id, record.kind as record_kind
    from automation.enrolments run
    join crm.records record on record.business_id = run.business_id and record.id = run.record_id
    where run.id = ${enrolmentId}
  `.execute(trx);
  const [run] = rows;
  if (run === undefined) return undefined;
  if (run.deal_in_hand_id !== null) return { id: run.deal_in_hand_id, from: 'step' };
  return run.record_kind === 'deal' ? { id: run.record_id, from: 'run' } : undefined;
}

/**
 * Puts a deal in the run's hand, in the step's own transaction: a step that fails after it
 * rolls this back with the rest of what it did.
 */
export async function keepDealInHand(
  trx: DatabaseTransaction,
  enrolmentId: string,
  dealId: string,
): Promise<void> {
  await sql`
    update automation.enrolments set deal_in_hand_id = ${dealId} where id = ${enrolmentId}
  `.execute(trx);
}
