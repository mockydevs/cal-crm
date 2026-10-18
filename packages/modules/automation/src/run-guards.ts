// What keeps an event from starting a run that would only feed a loop. Two rules, both read
// from the record's runs of the automation:
//
// - A run's own change starts nothing more. Every event a run's steps write carries the
//   correlation of the change that started the run (private.enqueue_automation_step, 0101),
//   and so does every run that change led to, in this automation or another. An event whose
//   correlation is that of an ended run of this automation for this record is the run's own
//   doing, or the doing of a run it led to: the run already read the change that started it,
//   so the event is not a new change and starts nothing (as it already did while the
//   run was going). This ends a workflow that writes the field it listens for, and two
//   workflows that write each other's fields, after one round.
// - A circuit breaker. A loop that leaves the CRM and comes back (a webhook whose receiver
//   writes the contact through the API) comes back under a new correlation. However it came
//   about, an automation that has started RUN_LIMIT_STARTS runs for one record within
//   RUN_LIMIT_WINDOW starts no more for it until the oldest of them is older than that. The
//   first refusal in a window is said on the record's timeline (automation.loop_stopped).
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

/** The most runs an automation may start for one record within RUN_LIMIT_WINDOW_MINUTES. */
export const RUN_LIMIT_STARTS = 20;

/** The window RUN_LIMIT_STARTS is counted in, in minutes. */
export const RUN_LIMIT_WINDOW_MINUTES = 60;

/** Why a start was refused, as a trigger evaluation's detail keeps it. */
export type StartRefusal =
  /** This same event already started a run (a match job run twice): nothing more to do. */
  | { readonly cause: 'same_event' }
  | { readonly cause: 'own_change' }
  | {
      readonly cause: 'run_limit';
      readonly starts: number;
      readonly windowMinutes: number;
      /** Whether this is the first refusal in the window: the one that is told of. */
      readonly first: boolean;
    };

/**
 * Why the automation may not start a run for the record from this event, if it may not. A
 * run this same event started means the match ran twice, and nothing more is started. A
 * live run of the same correlation is not a refusal: the event is then a change of the run's
 * own request, which marks nothing, and the caller's rules say so.
 */
export async function startRefusal(
  trx: DatabaseTransaction,
  input: {
    readonly automationId: string;
    readonly recordId: string;
    readonly correlationId: string;
    /** The event, when an event is starting it; null for a start again (reentry.ts). */
    readonly eventId: string | null;
    readonly now: Date;
  },
): Promise<StartRefusal | undefined> {
  const since = new Date(input.now.getTime() - RUN_LIMIT_WINDOW_MINUTES * 60_000);
  const { rows } = await sql<{
    by_event: boolean;
    own_ended: boolean;
    own_live: boolean;
    recent: number;
  }>`
    select
      coalesce(bool_or(trigger_event_id = ${input.eventId}::uuid), false) as by_event,
      coalesce(bool_or(correlation_id = ${input.correlationId}
        and status not in ('running', 'waiting')
        and trigger_event_id is distinct from ${input.eventId}::uuid), false) as own_ended,
      coalesce(bool_or(correlation_id = ${input.correlationId}
        and status in ('running', 'waiting')), false) as own_live,
      (count(*) filter (where started_at > ${since}))::int as recent
    from automation.enrolments
    where automation_id = ${input.automationId} and record_id = ${input.recordId}
  `.execute(trx);
  const [found] = rows;
  if (found === undefined) return undefined;
  if (found.by_event) return { cause: 'same_event' };
  if (found.own_ended && !found.own_live) return { cause: 'own_change' };
  if (found.recent < RUN_LIMIT_STARTS) return undefined;
  // Told of once a window: an earlier refusal for the same reason is already on record.
  const told = await sql<{ one: number }>`
    select 1 as one from automation.trigger_evaluations
    where automation_id = ${input.automationId} and record_id = ${input.recordId}
      and reason = 'refused_loop' and detail ->> 'cause' = 'run_limit'
      and evaluated_at > ${since}
    limit 1
  `.execute(trx);
  return {
    cause: 'run_limit',
    starts: found.recent,
    windowMinutes: RUN_LIMIT_WINDOW_MINUTES,
    first: told.rows.length === 0,
  };
}

/** What a trigger evaluation keeps of a refusal: the first flag is how it was told, not why. */
export function refusalDetail(
  refusal: Exclude<StartRefusal, { readonly cause: 'same_event' }>,
): Readonly<Record<string, unknown>> {
  if (refusal.cause === 'own_change') return { cause: refusal.cause };
  return { cause: refusal.cause, starts: refusal.starts, windowMinutes: refusal.windowMinutes };
}
