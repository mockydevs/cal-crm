// On its own so the runner and the matcher can each read a condition's fields without
// importing each other.

/** The field paths a condition compares, however deeply it nests all, any and not. */
export function comparedFields(condition: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(condition)) for (const each of condition) comparedFields(each, found);
  else if (typeof condition === 'object' && condition !== null)
    for (const [key, value] of Object.entries(condition))
      if (key === 'field' && typeof value === 'string') found.add(value);
      else if (key === 'all' || key === 'any' || key === 'not') comparedFields(value, found);
  return found;
}
