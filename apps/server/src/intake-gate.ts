// One public request of a business at a time, in each server process, and a short line
// behind it: for the public surfaces whose every request holds one row of the business.
//
// A public booking request (a calendar's page, a day's slots, a booking, a change) opens a
// transaction and takes its business's row before anything else, so that a suspension or a
// change of the calendar is seen by all of them in one order. Requests of one business
// therefore run one after the other whatever is done here. Without this gate each request
// that arrives meanwhile waits in the database for that row, holding a pooled connection
// while it waits: a flood on one business's calendar takes every connection the server
// has, and the requests of every other business, and the limiter itself, wait behind it.
// (Measured, bench/neighbours.load.ts: a quiet business's visitors were answered 503 on 11
// of 40 calendar pages and 4 of 29 bookings while its neighbour was flooded.)
//
// With the gate a waiting request waits here, holding nothing: one business uses one
// connection at a time, however many requests are sent. The line is bounded. A request
// that finds it full is told to wait and ask again (429 with Retry-After), which a booking
// can do safely: it carries its own request id, so nothing is booked twice.
//
// The forms module keeps the same gate for a form's submissions (its submit-gate.ts); this
// one is the transport's, for a surface whose module leaves the waiting to it.

export interface IntakeGateOptions {
  /** How many requests of one key may wait for the one that is running. Default 32. */
  readonly maxWaiting?: number;
}

/** What a request that found the line full is told: how many seconds to wait. */
export const INTAKE_GATE_RETRY_SECONDS = 2;

/** Says the line was full: the work was not started. */
export const INTAKE_GATE_FULL = Symbol('the line of this business is full');

export type IntakeGate = <T>(
  key: string,
  work: () => Promise<T>,
) => Promise<T | typeof INTAKE_GATE_FULL>;

export function createIntakeGate(options: IntakeGateOptions = {}): IntakeGate {
  const maxWaiting = options.maxWaiting ?? 32;
  if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 0)
    throw new Error('A line is a whole number of requests, none or more.');
  // A key is here only while a request of it is running: its line, in order.
  const lines = new Map<string, (() => void)[]>();

  return async (key, work) => {
    const line = lines.get(key);
    if (line === undefined) lines.set(key, []);
    else {
      if (line.length >= maxWaiting) return INTAKE_GATE_FULL;
      await new Promise<void>((resolve) => {
        line.push(resolve);
      });
    }
    try {
      return await work();
    } finally {
      // The next in line goes; with nobody waiting the key is forgotten.
      const next = lines.get(key)?.shift();
      if (next === undefined) lines.delete(key);
      else next();
    }
  };
}
