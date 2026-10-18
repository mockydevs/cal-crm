// The built-in lead sources (packages/contracts/src/lead-sources.ts), as the controls that
// offer them need them: the names a lead source is usually one of. A lead source can also
// be the text an address carried in source=, so each is offered, never required. On its
// own, so that only the controls that offer them carry the list.
import { attributionLeafAt, leadSources } from '@repo/contracts';

/** The built-in lead sources by what people read, in the order the rules are tried. */
export const leadSourceNames: readonly string[] = leadSources.map((each) => each.label);

const leadSourceKeys: readonly string[] = leadSources.map((each) => each.key);

/**
 * What a field usually holds, offered while its value is typed: the built-in names for a
 * lead source, their keys for the rule that decided it. Nothing for any other field.
 */
export function suggestionsFor(path: string): readonly string[] | undefined {
  const leaf = attributionLeafAt(path)?.leaf.key;
  return leaf === 'source' ? leadSourceNames : leaf === 'sourceKey' ? leadSourceKeys : undefined;
}

/** The lead sources a trigger lists that are not built-in names: kept, and shown as written. */
export function customSources(chosen: readonly string[]): string[] {
  const known = new Set(leadSourceNames.map((name) => name.toLowerCase()));
  return chosen.filter((each) => !known.has(each.trim().toLowerCase()));
}

/** The lead sources of a trigger's filter, as the document holds them: text, each once. */
export function sourcesOf(value: unknown): string[] {
  const given = Array.isArray(value) ? (value as readonly unknown[]) : [];
  const seen = new Set<string>();
  return given.flatMap((each) => {
    if (typeof each !== 'string' || each.trim() === '') return [];
    const key = each.trim().toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [each.trim()];
  });
}

/** The list after one source is ticked or unticked; nothing when none is left. */
export function toggledSource(
  chosen: readonly string[],
  source: string,
  on: boolean,
): string[] | undefined {
  const same = (each: string): boolean => each.trim().toLowerCase() === source.trim().toLowerCase();
  const next = on
    ? chosen.some(same)
      ? [...chosen]
      : [...chosen, source.trim()]
    : chosen.filter((each) => !same(each));
  return next.length === 0 ? undefined : next;
}
