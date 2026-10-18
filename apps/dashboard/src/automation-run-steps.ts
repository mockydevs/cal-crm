// What a step of a run was given, in words, for the run's own page in the builder.
import { isRecord } from './automation-document';
import { valueWords } from './automation-run-words';
import { fieldWords } from './automation-summary';

/** The values a condition compared, each with its field in words. */
export function comparedValues(
  input: Readonly<Record<string, unknown>>,
): { readonly field: string; readonly value: string }[] {
  const values = input['values'];
  if (!isRecord(values)) return [];
  return Object.entries(values).map(([path, value]) => ({
    field: fieldWords(path) ?? path,
    value: valueWords(value),
  }));
}
