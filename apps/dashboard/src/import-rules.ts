// What the CSV import works out before it draws: which target each column of the file
// fills, the mapping the API is sent, how far a running import has got, and the file as it
// is uploaded.
import {
  importTargetKey,
  type ImportColumnMapping,
  type ImportFileInspection,
  type ImportTarget,
} from '@repo/contracts';
import type { Upload } from '@repo/sdk';

/**
 * A column's choice in the mapping step: importTargetKey's text for the target it fills
 * ("attribute:email", "field:fld_…"), or '' for a column that is left out.
 */
export type ColumnChoice = string;

/** One choice for each column of the file, starting from the server's suggestion. */
export function choicesOf(inspection: ImportFileInspection): ColumnChoice[] {
  return inspection.columns.map((column) => {
    const suggested = inspection.suggestedMapping.find((entry) => entry.column === column.index);
    return suggested === undefined ? '' : importTargetKey(suggested.target);
  });
}

/** The target a choice names, when it is one the file can fill. */
export function targetOf(
  choice: ColumnChoice,
  inspection: ImportFileInspection,
): ImportTarget | undefined {
  const attribute = inspection.attributes.find((each) => `attribute:${each}` === choice);
  if (attribute !== undefined) return { kind: 'attribute', attribute };
  const field = inspection.fields.find((each) => `field:${each.id}` === choice);
  return field === undefined ? undefined : { kind: 'field', fieldId: field.id };
}

/** The mapping the API is sent: an entry for each column that fills something. */
export function mappingOf(
  choices: readonly ColumnChoice[],
  inspection: ImportFileInspection,
): ImportColumnMapping[] {
  return inspection.columns.flatMap((column, at) => {
    const target = targetOf(choices[at] ?? '', inspection);
    return target === undefined ? [] : [{ column: column.index, target }];
  });
}

/** Whether another column than this one already fills the target: nothing is filled twice. */
export function takenBy(
  choices: readonly ColumnChoice[],
  choice: ColumnChoice,
  column: number,
): boolean {
  return choices.some((each, at) => at !== column && each === choice);
}

/** How far an import has got, as a whole percentage of the rows the file holds. */
export function progressOf(counts: { readonly found: number; readonly processed: number }): number {
  return counts.found === 0
    ? 0
    : Math.min(100, Math.floor((counts.processed / counts.found) * 100));
}

export const isCsvName = (name: string): boolean => /.\.csv$/i.test(name);

/**
 * The file as it is uploaded: always as text/csv. A browser on a machine with a spreadsheet
 * program reports a .csv file as application/vnd.ms-excel, which the files service refuses.
 */
export function csvUpload(file: File): Upload {
  return { content: file, type: 'text/csv' };
}
