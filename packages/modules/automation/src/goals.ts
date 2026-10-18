// The goal step: a run listens for its goal's events from its start until it has been
// through the goal step. When one arrives the run is taken out of whatever it waits in and
// moved straight to the step. The waiting rows are event_waits of kind 'goal', beside the
// stop conditions' rows, so an event finds the runs it moves with one index lookup.
import {
  automationDocument,
  type AutomationDocument,
  type AutomationTrigger,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

import { queueStep } from './queue-step.js';
import { settleWaitingSteps } from './settle.js';
import { eventPassesTrigger, TRIGGER_EVENTS } from './triggers.js';

/** What a run that the goal moved keeps until its goal step has run. */
export interface GoalMet {
  readonly step: string;
  readonly eventId: string;
  /** The event's own type, as it was emitted, such as tag.assigned. */
  readonly eventType: string;
  /** The step the run was at, or waiting in, when the goal was met. */
  readonly from: string | null;
}

/** Records the waiting rows for a run's goal step, as the run starts. */
export async function addGoalWaits(
  trx: DatabaseTransaction,
  businessId: string,
  enrolmentId: string,
  recordId: string,
  document: AutomationDocument,
): Promise<void> {
  const rows = Object.entries(document.steps).flatMap(([key, step]) =>
    step.type !== 'goal'
      ? []
      : // One row per event type heard, however many of the goal's events share it.
        [...new Set(step.config.events.flatMap((each) => TRIGGER_EVENTS[each.type].events))].map(
          (eventType) => ({
            business_id: businessId,
            enrolment_id: enrolmentId,
            kind: 'goal',
            event_type: eventType,
            record_id: recordId,
            conditions: JSON.stringify({ step: key }),
          }),
        ),
  );
  if (rows.length > 0) await trx.insertInto('automation.event_waits').values(rows).execute();
}

/**
 * Moves the live runs of these records whose goal this event meets to their goal step, and
 * queues it. A run waiting at the goal step itself is let go on from there. Each event of a
 * goal is judged with its trigger's own filters. The run's row is locked first, then its
 * job queued, as everywhere else. Returns the runs moved.
 */
export async function applyGoals(
  trx: DatabaseTransaction,
  event: {
    readonly id: string;
    readonly type: string;
    readonly payload: Readonly<Record<string, unknown>>;
  },
  recordIds: readonly string[],
): Promise<readonly string[]> {
  if (recordIds.length === 0) return [];
  const waits = await trx
    .selectFrom('automation.event_waits as wait')
    .innerJoin('automation.enrolments as enrolment', 'enrolment.id', 'wait.enrolment_id')
    .innerJoin('automation.versions as version', 'version.id', 'enrolment.version_id')
    .select([
      'enrolment.id',
      'enrolment.state',
      'enrolment.current_step',
      'wait.conditions',
      'version.document',
    ])
    .where('wait.kind', '=', 'goal')
    .where('wait.event_type', '=', event.type)
    .where('wait.record_id', 'in', [...recordIds])
    .where('enrolment.status', 'in', ['running', 'waiting'])
    .orderBy('enrolment.id')
    .forUpdate('enrolment')
    .execute();
  const moved: string[] = [];
  for (const wait of waits) {
    // The row names its goal step, in the version the run is pinned to.
    const stepKey = String((wait.conditions as { step?: unknown }).step);
    const step = automationDocument.parse(wait.document).steps[stepKey];
    if (step?.type !== 'goal') continue;
    const met = step.config.events.some((each) =>
      eventPassesTrigger(
        // A goal's event is a trigger's type and config; only a trigger's id is missing.
        { id: stepKey, type: each.type, config: each.config } as AutomationTrigger,
        event.type,
        event.payload,
      ),
    );
    if (!met) continue;
    const state = (wait.state ?? {}) as Readonly<Record<string, unknown>>;
    const armedAt = (state['armed'] as { step?: unknown } | undefined)?.step;
    if (armedAt === stepKey) {
      // It waits at the goal step itself: the event lets it go on from there.
      await trx
        .updateTable('automation.enrolments')
        .set({
          state: JSON.stringify({ ...state, received: event.id }),
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', wait.id)
        .execute();
    } else {
      const waitingAt = await trx
        .selectFrom('automation.step_runs')
        .select('step_key')
        .where('enrolment_id', '=', wait.id)
        .where('status', '=', 'waiting')
        .executeTakeFirst();
      // The rest of what it waited in never happened, and a person need not act on it.
      await settleWaitingSteps(trx, wait.id, 'skipped');
      await trx
        .updateTable('automation.manual_actions')
        .set({ status: 'cancelled', closed_at: sql<Date>`now()`, closed_by_kind: 'system' })
        .where('enrolment_id', '=', wait.id)
        .where('status', '=', 'pending')
        .execute();
      // Whatever the run waited on is dropped with the wait: an answer that still comes for
      // it (a webhook's, a closed action's) finds nothing waiting and is ignored.
      const {
        armed: _a,
        received: _r,
        webhook: _w,
        emailCheck: _e,
        held: _h,
        manual: _m,
        ...rest
      } = state;
      const sequence = typeof state['sequence'] === 'number' ? state['sequence'] : 0;
      const from = waitingAt?.step_key ?? wait.current_step;
      const goal: GoalMet = {
        step: stepKey,
        eventId: event.id,
        eventType: event.type,
        // A run that was about to run the goal step anyway came from nowhere else.
        from: from === stepKey ? null : from,
      };
      await trx
        .updateTable('automation.enrolments')
        .set({
          status: 'running',
          current_step: stepKey,
          wake_at: null,
          updated_at: sql<Date>`now()`,
          // The sequence moves on, so the job queued for where the run was does nothing.
          state: JSON.stringify({ ...rest, sequence: sequence + 1, goal }),
        })
        .where('id', '=', wait.id)
        .execute();
    }
    // Met once: the run listens for the goal, and for the event it waited on, no more.
    await trx
      .deleteFrom('automation.event_waits')
      .where('enrolment_id', '=', wait.id)
      .where('kind', 'in', ['goal', 'event'])
      .execute();
    await queueStep(trx, wait.id);
    moved.push(wait.id);
  }
  return moved;
}
