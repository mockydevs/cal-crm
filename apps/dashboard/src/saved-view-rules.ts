// What a saved view keeps of a list, and whether two of them are the same list: shared by
// the row of views above a list (saved-views.tsx) and the panel that adds or edits one
// (saved-view-panel.tsx).
import type { SavedView } from '@repo/contracts';
import type { ReactNode } from 'react';
import { dealColumnsOfView } from './deal-list-rules';
import { nameFirst } from './list-rules';

/**
 * What a view keeps of a list. A view has two lists of columns: `tableColumns` is the
 * table's own, and `columns` the ones the first table had (four for contacts, five for
 * opportunities), which the API still asks for; a view saved before the table had more has
 * only those.
 */
export type ViewConfiguration =
  | Pick<
      Extract<SavedView, { objectKey: 'contact' }>,
      'objectKey' | 'state' | 'columns' | 'tableColumns' | 'columnLayout' | 'columnWidths'
    >
  | Pick<
      Extract<SavedView, { objectKey: 'deal' }>,
      'objectKey' | 'state' | 'columns' | 'tableColumns'
    >;

/**
 * A part of the list a view keeps, changed from inside the panel: the list's own Filters,
 * Sort or Manage fields form, as a step with a way back. What a step applies, it applies
 * to the list, which shows behind the panel; the view is saved as the list then is.
 */
export interface ViewStep {
  readonly key: string;
  readonly label: string;
  /** Beside the label, such as "7 selected". */
  readonly summary?: string;
  /** What the step shows; `back` returns to the panel's first page. */
  readonly render: (back: () => void) => ReactNode;
}

function stateFingerprint(configuration: ViewConfiguration): string {
  return JSON.stringify(
    Object.entries(configuration.state)
      .filter(
        ([key, value]) =>
          value !== undefined &&
          !(
            configuration.objectKey === 'deal' &&
            ((key === 'status' && value === 'open') || (key === 'layout' && value === 'board'))
          ),
      )
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * The columns a view's table shows, in order: the name is always the first. A contact
 * view's whole layout, with its custom fields, comes before the built-in columns alone.
 */
function tableColumnsOf(configuration: ViewConfiguration): readonly string[] {
  return configuration.objectKey === 'contact'
    ? nameFirst(configuration.columnLayout ?? configuration.tableColumns ?? configuration.columns)
    : dealColumnsOfView(configuration);
}

/** The widths a contact view's columns were dragged to, in one order. */
function widthsFingerprint(configuration: ViewConfiguration): string {
  if (configuration.objectKey !== 'contact') return '';
  return JSON.stringify(
    Object.entries(configuration.columnWidths ?? {}).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export function sameConfiguration(left: ViewConfiguration, right: ViewConfiguration): boolean {
  return (
    left.objectKey === right.objectKey &&
    stateFingerprint(left) === stateFingerprint(right) &&
    JSON.stringify(tableColumnsOf(left)) === JSON.stringify(tableColumnsOf(right)) &&
    widthsFingerprint(left) === widthsFingerprint(right)
  );
}
