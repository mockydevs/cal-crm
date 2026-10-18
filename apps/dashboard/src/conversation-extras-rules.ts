// What the Snippets, Trigger Links and Manual Actions pages of Conversations work out
// before they draw: whether a snippet can be saved, what a range of days asks the click
// list for, and which action comes next in the queue.
import { SNIPPET_LIMITS, type ManualAction, type SnippetType } from '@repo/contracts';

export interface SnippetDraft {
  readonly type: SnippetType;
  readonly name: string;
  readonly subject: string;
  readonly body: string;
}

/** How long a snippet's body may be: a text fits one text message. */
export function snippetBodyLimit(type: SnippetType): number {
  return type === 'text' ? SNIPPET_LIMITS.text : SNIPPET_LIMITS.email;
}

/**
 * Whether the panel's primary button is on: everything the API requires is there. A text
 * has no subject; an email has one, on one line.
 */
export function snippetDraftReady(draft: SnippetDraft): boolean {
  if (draft.name.trim() === '' || draft.body === '') return false;
  if (draft.body.length > snippetBodyLimit(draft.type)) return false;
  if (draft.type === 'text') return true;
  return draft.subject.trim() !== '' && !/[\r\n]/.test(draft.subject.trim());
}

/** The subject a save sends: an email's, trimmed, and none for a text. */
export function snippetSubject(draft: SnippetDraft): string | null {
  return draft.type === 'email' ? draft.subject.trim() : null;
}

/** The start of a day someone chose in a date field (YYYY-MM-DD), where they are. */
function startOfDay(day: string, addDays = 0): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + addDays);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * What a range of days asks the click list for. The list takes clicks at or after `from`
 * and before `to`, so the last day chosen is included by asking for the day after it.
 */
export function clickRange(
  fromDay: string,
  toDay: string,
): { readonly from?: string; readonly to?: string } {
  const from = startOfDay(fromDay);
  const to = startOfDay(toDay, 1);
  return {
    ...(from === undefined ? {} : { from: from.toISOString() }),
    ...(to === undefined ? {} : { to: to.toISOString() }),
  };
}

/** Whether a range of days ends before it starts, which would find nothing. */
export function rangeBackwards(fromDay: string, toDay: string): boolean {
  const from = startOfDay(fromDay);
  const to = startOfDay(toDay);
  return from !== undefined && to !== undefined && to.getTime() < from.getTime();
}

/**
 * The action to do after this one is closed: the next pending one below it in the queue,
 * or else the first pending one above it. None when it was the last.
 */
export function nextPending(
  items: readonly ManualAction[],
  closedId: string,
): ManualAction | undefined {
  const at = items.findIndex((each) => each.id === closedId);
  const pending = (each: ManualAction): boolean =>
    each.status === 'pending' && each.id !== closedId;
  return items.slice(at + 1).find(pending) ?? items.slice(0, Math.max(at, 0)).find(pending);
}

/** What the assignee choice sends for an action: a member, the reader, or nobody. */
export function assigneeInput(choice: string): string | null {
  return choice === 'unassigned' ? null : choice;
}

/** The choice that shows who an action is for now. */
export function assigneeChoice(action: Pick<ManualAction, 'assignee'>): string {
  if (action.assignee === null) return 'unassigned';
  if (action.assignee.you) return 'me';
  return action.assignee.membershipId ?? 'unassigned';
}
