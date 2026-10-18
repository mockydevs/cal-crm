// A change that comes while a record's run is going. An automation that lets a
// record in again (settings.reEnrollment: after_finished) holds a record once at a time, so
// an event that would start the record while its run is going cannot start it then. It is
// not lost: the live run is marked, and when that run ends by completing or failing, the
// record starts once more. However many events came during the run, one run follows it, and
// that run reads the record as it is when it runs, so the newest change is what it acts on.
// A run a stop condition, a removal or a deletion ended was ended on purpose, and nothing
// starts after it.
//
// The guarantees, and what keeps each:
// - Nothing is lost between the run ending and the mark being made. The match holds the
//   record's runs (lockRecordRuns) and the enrolment lock, and reads the live run FOR
//   UPDATE, so it waits for a step that is ending the run. When that step has ended it,
//   the read finds no live run and the match starts the record itself.
// - One run follows, never two. The mark is one key of the run's state, which every event
//   during the run overwrites with the newest; the job that starts the record again
//   records what it did on the ended run, so the job run twice starts nothing more.
// - A change the run already sees marks nothing. Events of the same request as the one
//   that started the run (one correlation: a contact created with its fields, a form that
//   creates a contact and fills its fields) were committed before the run read anything,
//   and so were the run's own writes. This is also what keeps a workflow that writes the
//   field it listens for from going round.
// - The job is written with the step that ended the run, in its transaction, so it exists
//   exactly when the ending was kept.
import type { TaskReference } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';
import * as z from 'zod';

/** What a live run keeps of the newest event that came for its record while it ran. */
export const reentryMark = z.object({
  eventId: z.uuid(),
  eventType: z.string(),
  recordedAt: z.string(),
  correlationId: z.uuid(),
  triggerId: z.string(),
  /** What the run started again begins its state with, as the event's own run would have. */
  state: z.record(z.string(), z.unknown()),
  /** How many events came during the run. */
  events: z.int().min(1),
  /** Set once the record was started again, or could not be: what came of it. */
  outcome: z.string().optional(),
  enrolmentId: z.uuid().optional(),
});
export type ReentryMark = z.infer<typeof reentryMark>;

/** The mark a run's state holds, if it holds one. */
export function reentryOf(state: unknown): ReentryMark | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const parsed = reentryMark.safeParse((state as { reentry?: unknown }).reentry);
  return parsed.success ? parsed.data : undefined;
}

/** Whether a run that ends with this state is to start its record again. */
export const startsAgain = (state: unknown): ReentryMark | undefined => {
  const mark = reentryOf(state);
  return mark !== undefined && mark.outcome === undefined ? mark : undefined;
};

/** The newer of two marks, counting the events both stand for. */
export function mergeMarks(
  kept: ReentryMark | undefined,
  next: Omit<ReentryMark, 'events'>,
): ReentryMark {
  if (kept === undefined) return { ...next, events: 1 };
  const newer = Date.parse(next.recordedAt) >= Date.parse(kept.recordedAt) ? next : kept;
  return { ...newer, events: kept.events + 1 };
}

/** What a match did with an event for a record whose run was going. */
export type Queued =
  /** The live run was marked: the record starts again when it ends. */
  | { readonly outcome: 'queued' }
  /** The live run came from the same request, so it already reads this change. */
  | { readonly outcome: 'same_change' }
  /** The run had ended by the time it could be read: the record can be started now. */
  | { readonly outcome: 'ended' };

/**
 * Marks the record's live run of the automation so the record starts again when it ends.
 * The caller holds the record's runs and the enrolment lock. The live run is read FOR
 * UPDATE, so a step ending it is waited for.
 */
export async function queueReentry(
  trx: DatabaseTransaction,
  input: {
    readonly automationId: string;
    readonly recordId: string;
    readonly event: {
      readonly id: string;
      readonly type: string;
      readonly recordedAt: Date;
      readonly correlationId: string;
    };
    readonly triggerId: string;
    readonly state: Readonly<Record<string, unknown>>;
  },
): Promise<Queued> {
  const live = await trx
    .selectFrom('automation.enrolments')
    .select(['id', 'state', 'correlation_id'])
    .where('automation_id', '=', input.automationId)
    .where('record_id', '=', input.recordId)
    .where('status', 'in', ['running', 'waiting'])
    .forUpdate()
    .executeTakeFirst();
  if (live === undefined) return { outcome: 'ended' };
  if (live.correlation_id === input.event.correlationId) return { outcome: 'same_change' };
  const state = (live.state ?? {}) as Readonly<Record<string, unknown>>;
  const mark = mergeMarks(startsAgain(state), {
    eventId: input.event.id,
    eventType: input.event.type,
    recordedAt: input.event.recordedAt.toISOString(),
    correlationId: input.event.correlationId,
    triggerId: input.triggerId,
    state: { ...input.state },
  });
  await trx
    .updateTable('automation.enrolments')
    .set({
      state: sql`state || ${JSON.stringify({ reentry: mark })}::jsonb`,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', live.id)
    .execute();
  return { outcome: 'queued' };
}

export const startAgainReference = {
  name: 'automations.start_again',
  data: z.strictObject({
    /** The run that ended with a mark. */
    enrolmentId: z.uuid(),
    /** The marked event's correlation, which the run started again carries. */
    correlationId: z.uuid(),
  }),
} satisfies TaskReference<z.ZodType>;
