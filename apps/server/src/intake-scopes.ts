// What the public transports remember of the businesses behind public keys, for the limit
// each business has (public-intake-limit.ts, migration 0089).

/**
 * Which business a public key belongs to, as a transport learned it: a form's key or a
 * site's key names one business for as long as it exists. A transport knows the business
 * only after it has admitted a request for the key, so the first request for a key is
 * counted by its address and the install's ceiling alone, and every later one by its
 * business's too. Bounded: past `max` keys the oldest is forgotten, and is learned again.
 * A key that names nothing is never learned, so made-up keys fill nothing.
 */
export interface IntakeScopes {
  readonly get: (key: string) => string | undefined;
  readonly learn: (key: string, businessId: string) => void;
}

export function createIntakeScopes(max = 10_000): IntakeScopes {
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('The scope memory needs room.');
  const known = new Map<string, string>();
  return {
    get: (key) => known.get(key),
    learn(key, businessId) {
      if (known.get(key) === businessId) return;
      known.delete(key);
      known.set(key, businessId);
      if (known.size > max)
        for (const oldest of known.keys()) {
          known.delete(oldest);
          break;
        }
    },
  };
}
