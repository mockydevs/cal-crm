// What the contact page says once it opens on a merged contact: that others were just
// merged into it, or that the contact asked for was merged into it. The dialog or the page
// that followed the merge leaves it here and the contact page reads it as it opens; it is
// not kept in the address, so a reload says nothing. Small, as the contact page loads it.
import { ApiError } from '@repo/sdk';

export type MergeNotice =
  { readonly kind: 'merged'; readonly count: number } | { readonly kind: 'followed' };

let waiting: { readonly contactId: string; readonly notice: MergeNotice } | undefined;

/** Leaves a notice for the contact page of `contactId`. */
export function noteMerge(contactId: string, notice: MergeNotice): void {
  waiting = { contactId, notice };
}

/**
 * The notice left for this contact's page, if any. Reading it does not clear it, so a page
 * drawn twice says it both times; the page clears it once shown.
 */
export function mergeNoticeFor(contactId: string): MergeNotice | undefined {
  return waiting?.contactId === contactId ? waiting.notice : undefined;
}

export function clearMergeNotice(): void {
  waiting = undefined;
}

/** The contact a 404 says this one was merged into, if it says so. */
export function mergedIntoOf(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 404) return undefined;
  const kept = error.problem.mergedInto;
  return typeof kept === 'string' && kept !== '' ? kept : undefined;
}
