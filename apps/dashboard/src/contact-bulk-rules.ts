// What the Contacts → Bulk Actions page works out before it draws: the label a row shows,
// how far an action has got, and whether it is still going and so worth reading again.
import { contactBulkOutcomes, type ContactBulkAction } from '@repo/contracts';

/** What "Show stats" can list: every contact, one outcome, or the ones still waiting. */
export const itemOutcomeFilters = ['all', ...contactBulkOutcomes, 'pending'] as const;
export type ItemOutcomeFilter = (typeof itemOutcomeFilters)[number];

/**
 * The label of a row: the name the action was given, or else when it was started, so two
 * unnamed actions can still be told apart.
 */
export function bulkActionLabel(
  action: Pick<ContactBulkAction, 'name' | 'createdAt'>,
  locale: string,
): string {
  if (action.name !== null && action.name.trim() !== '') return action.name;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(action.createdAt),
  );
}

/** How many of an action's contacts have an outcome, of how many it covers. */
export function bulkProgress(
  action: Pick<ContactBulkAction, 'requested' | 'done' | 'unchanged' | 'skipped'>,
): { readonly settled: number; readonly requested: number } {
  const settled = Math.min(action.done + action.unchanged + action.skipped, action.requested);
  return { settled, requested: action.requested };
}

/** Whether the worker may still change contacts for this action. */
export function bulkStillGoing(action: Pick<ContactBulkAction, 'status'>): boolean {
  return action.status === 'queued' || action.status === 'running';
}
