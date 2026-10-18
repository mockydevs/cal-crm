// Current record values, those of the deal the run has in hand, how the run's own lead
// arrived, the appointment it is about, and the completed outputs of this enrolment, for
// conditions and native merges.
import type { ConditionValue, ConditionValues } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import * as z from 'zod';

import { appointmentValues, type AppointmentLinks } from './appointment-values.js';
import { readDealInHand } from './deal-in-hand.js';
import { contactValues, dealValues, NO_DEAL } from './values.js';
import { runTriggerValues } from './trigger-values.js';

const mergeValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
  z.null(),
]);
const storedOutput = z.record(z.string(), z.unknown());

export async function runValues(
  trx: DatabaseTransaction,
  recordId: string,
  enrolmentId?: string,
  /** A message's send only: what fills appointment.manageUrl. */
  links?: AppointmentLinks,
): Promise<ConditionValues> {
  const values: Record<string, ConditionValue | undefined> = {
    ...(await contactValues(trx, recordId)),
  };
  if (enrolmentId === undefined) return values;
  // The deal the run has in hand, read as it is now; every deal.* path is null without one.
  const inHand = await readDealInHand(trx, enrolmentId);
  Object.assign(values, NO_DEAL, inHand === undefined ? {} : await dealValues(trx, inHand.id));
  Object.assign(values, await runTriggerValues(trx, recordId, enrolmentId));
  // The appointment the run is about, read as it is now; every appointment.* path is null
  // without one.
  Object.assign(values, await appointmentValues(trx, recordId, enrolmentId, links));
  const rows = await trx
    .selectFrom('automation.step_runs as step')
    .innerJoin('automation.enrolments as run', 'run.id', 'step.enrolment_id')
    .select(['step.step_key', 'step.output'])
    .distinctOn('step.step_key')
    .where('run.id', '=', enrolmentId)
    .where('run.record_id', '=', recordId)
    .where('step.status', '=', 'succeeded')
    .orderBy('step.step_key')
    .orderBy('step.started_at', 'desc')
    .orderBy('step.id', 'desc')
    .execute();
  for (const row of rows) {
    for (const [key, value] of Object.entries(storedOutput.parse(row.output))) {
      const parsed = mergeValue.safeParse(value);
      if (parsed.success) values[`steps.${row.step_key}.${key}`] = parsed.data;
    }
  }
  return values;
}
