// One submission of a form at a time, in each server process, and a short line behind it.
//
// Submissions of one form are stored one after the other whatever is done here: each holds
// the form's row while it counts the ones before it and looks for a repeat of itself
// (public.ts). Without this gate every submission that arrives meanwhile opens a
// transaction and waits in the database for that row, holding a pooled connection while it
// waits. A flood on one form then takes every connection the server has, and the requests
// of every other business, and the limiter itself, wait behind it. (Measured: the intake
// load test answered a quiet business's visitors with 503 while its neighbour was flooded.)
//
// With the gate a waiting submission waits here, holding nothing: one form uses one
// connection at a time, however many are sent. The line is bounded. A submission that
// finds it full is told to wait and send again, which the form on the page does with the
// same submission id, so nothing is stored twice and nothing typed is lost.

export interface SubmitGateOptions {
  /** How many submissions of one form may wait for the one being stored. Default 32. */
  readonly maxWaiting?: number;
}

/** What a submission that found the line full is told: how many seconds to wait. */
export const GATE_RETRY_SECONDS = 2;

/** Says the line was full: the work was not started. */
export const GATE_FULL = Symbol('the line of this form is full');

export type SubmitGate = <T>(
  formId: string,
  work: () => Promise<T>,
) => Promise<T | typeof GATE_FULL>;

export function createSubmitGate(options: SubmitGateOptions = {}): SubmitGate {
  const maxWaiting = options.maxWaiting ?? 32;
  if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 0)
    throw new Error('A form’s line is a whole number of submissions, none or more.');
  // A form is here only while a submission of it is being stored: its line, in order.
  const lines = new Map<string, (() => void)[]>();

  return async (formId, work) => {
    const line = lines.get(formId);
    if (line === undefined) lines.set(formId, []);
    else {
      if (line.length >= maxWaiting) return GATE_FULL;
      await new Promise<void>((resolve) => {
        line.push(resolve);
      });
    }
    try {
      return await work();
    } finally {
      // The next in line goes; with nobody waiting the form is forgotten.
      const next = lines.get(formId)?.shift();
      if (next === undefined) lines.delete(formId);
      else next();
    }
  };
}
