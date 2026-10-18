// How many report queries one person may run in a minute. Kept in the memory of this server
// process: with several app instances each allows the limit, which only bounds what one
// person's browser can ask of one instance. Nothing is stored.

export interface QueryLimiter {
  /** Counts one query for the person now. False when they have run their minute's worth. */
  admit(person: string): boolean;
}

const WINDOW_MS = 60_000;
/** People remembered at once; past it, the ones whose minute is over are forgotten first. */
const MAX_PEOPLE = 10_000;

export function createQueryLimiter(
  perMinute: number,
  now: () => number = () => Date.now(),
  maxPeople = MAX_PEOPLE,
): QueryLimiter {
  const windows = new Map<string, { started: number; count: number }>();
  return {
    admit(person) {
      const moment = now();
      if (windows.size >= maxPeople)
        for (const [key, window] of windows)
          if (moment - window.started >= WINDOW_MS) windows.delete(key);
      const window = windows.get(person);
      if (window === undefined || moment - window.started >= WINDOW_MS) {
        windows.set(person, { started: moment, count: 1 });
        return true;
      }
      if (window.count >= perMinute) return false;
      window.count += 1;
      return true;
    },
  };
}
