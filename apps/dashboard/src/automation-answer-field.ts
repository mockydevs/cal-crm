// One answer of a form submission as a field to choose from. On its own so the list of
// filter rows (automation-filters.ts) and what a submission offers (automation-submission.ts)
// can both name it without importing each other.
import type { AutomationFieldType } from '@repo/contracts';

export interface AnswerField {
  readonly path: string;
  readonly label: string;
  readonly type: AutomationFieldType;
  readonly options: readonly { readonly key: string; readonly label: string }[];
  readonly heading: string;
}
