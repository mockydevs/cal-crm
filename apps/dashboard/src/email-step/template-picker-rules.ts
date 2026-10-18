// What the template picker works out before it draws (template-picker.tsx): each template
// as a row with its subject and whether it is formatted, under the path of the folder it
// is filed in, and what the closed control reads for the template a step names.
import type { MessageTemplateSummary } from '@repo/contracts';
import type { PickerItem } from '../search-picker-rules';

/** As many templates as one read brings: the most the list endpoint gives at once. */
export const TEMPLATE_PAGE = 100;

/** How long typing rests before the server is asked, in milliseconds. */
export const SEARCH_REST = 250;

export interface TemplateMarks {
  readonly formatted: string;
  readonly plain: string;
}

/** The path of the folder a template is filed in, as a heading: "Sales / Follow-ups". */
export const folderPath = (template: Pick<MessageTemplateSummary, 'folder'>): string | undefined =>
  template.folder === null || template.folder.path.length === 0
    ? undefined
    : template.folder.path.join(' / ');

/**
 * The templates as rows. Unfiled templates lead, then each folder by its path; inside a
 * folder the server's order (by name) stands.
 */
export function templateItems(
  templates: readonly MessageTemplateSummary[],
  marks: TemplateMarks,
): PickerItem[] {
  const rows = templates.map((template) => ({
    id: template.id,
    name: template.name,
    detail: template.subject,
    mark: template.format === 'html' ? marks.formatted : marks.plain,
    group: folderPath(template),
  }));
  // Sorted as text, with "no folder" as the empty path: a sort never asks about undefined.
  const paths = [...new Set(rows.map((row) => row.group ?? ''))].sort((left, right) =>
    left.localeCompare(right),
  );
  return paths.flatMap((path) => rows.filter((row) => (row.group ?? '') === path));
}

/**
 * The template a step names, among those read: by id, or by name as an older step may.
 * Nothing when it is not among them.
 */
export function namedTemplate<Named extends { readonly id: string; readonly name: string }>(
  templates: readonly Named[],
  written: string | undefined,
): Named | undefined {
  if (written === undefined || written === '') return undefined;
  const wanted = written.trim().toLowerCase();
  return (
    templates.find((template) => template.id === written) ??
    templates.find((template) => template.name.trim().toLowerCase() === wanted)
  );
}
