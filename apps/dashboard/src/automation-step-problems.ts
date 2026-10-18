// What the checks found wrong with one step's settings, or one trigger's, by the setting
// each names, so its panel can say it under that setting. The checks are the server's when the draft
// is as it was saved (or as a save or a publish was refused), else the contract's own.
import { pointerParts, pointerToken } from './automation-json';

interface Found {
  readonly level: string;
  readonly path: string;
  readonly message: string;
}

/**
 * A place a refusal names, as a place in the document. A refused save names places in what
 * was sent, where the document is under /document; a refused publish names them as they are.
 */
export const placeInDocument = (path: string): string =>
  path.startsWith('/document/') ? path.slice('/document'.length) : path;

/** Whether a place is in the flow, where a trigger's card or a step's can show what's wrong. */
export const inFlow = (path: string): boolean =>
  path.startsWith('/steps/') || path.startsWith('/triggers/');

/**
 * The errors under the settings of a step, by its id, or of a trigger, by its place among
 * the triggers: the first for each setting, by the setting's key. One about a field a step
 * writes (its `fields`) is kept by that field: `fields/contact.custom.budget`.
 */
export function problemsAt(
  issues: readonly Found[],
  of: string | number,
  /**
   * The setting a refusal of the step as a whole, or of where it leads, is said under: for
   * a step whose one setting is what the refusal is about, such as a Go To's target.
   */
  whole?: string,
): Record<string, string> {
  const under =
    typeof of === 'number'
      ? `/triggers/${String(of)}/config/`
      : `/steps/${pointerToken(of)}/config/`;
  const problems: Record<string, string> = {};
  const at = under.slice(0, -'/config/'.length);
  for (const issue of issues) {
    if (
      whole !== undefined &&
      issue.level === 'error' &&
      (issue.path === at || issue.path === `${at}/next`)
    )
      problems[whole] ??= issue.message;
    if (issue.level !== 'error' || !issue.path.startsWith(under)) continue;
    const [key, inside] = pointerParts(issue.path.slice(under.length - 1));
    if (key === undefined || key === '') continue;
    // What is wrong with one field a step writes is said under that field's own row.
    problems[key === 'fields' && inside !== undefined ? `fields/${inside}` : key] ??= issue.message;
  }
  return problems;
}
