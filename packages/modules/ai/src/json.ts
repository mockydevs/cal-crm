// Reading JSON a provider sent: everything is unknown until it has been looked at.

export type JsonRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The parsed text, or undefined when it is not JSON. */
export function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

export function recordAt(value: unknown, key: string): JsonRecord | undefined {
  const found = isRecord(value) ? value[key] : undefined;
  return isRecord(found) ? found : undefined;
}

export function stringAt(value: unknown, key: string): string | undefined {
  const found = isRecord(value) ? value[key] : undefined;
  return typeof found === 'string' ? found : undefined;
}

/** A count of tokens: a whole number from zero. Anything else is undefined. */
export function countAt(value: unknown, key: string): number | undefined {
  const found = isRecord(value) ? value[key] : undefined;
  return typeof found === 'number' && Number.isSafeInteger(found) && found >= 0 ? found : undefined;
}

export function listAt(value: unknown, key: string): readonly unknown[] | undefined {
  const found = isRecord(value) ? value[key] : undefined;
  return Array.isArray(found) ? found : undefined;
}

/**
 * The same value with every object's keys in order, all the way down, so that it is always
 * written as the same bytes. A provider's prompt cache matches on bytes: a tool's schema
 * written in another key order would miss it (ARCHITECTURE.md section 8.4).
 */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}
