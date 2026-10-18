// What the Calls page works out before it draws: which calls are still going, when one may
// be hung up, the tone of its state, how long it lasted, and what a page of the list asks
// for. A requested call is waiting, never connected; a call ends only when the server says
// so.
import type { Call, CallState, ListCallsQuery } from '@repo/contracts';

/** How many calls a page holds (listCalls answers up to 50). */
export const CALLS_PER_PAGE = 25;

const ended: ReadonlySet<CallState> = new Set(['ended', 'refused', 'rejected', 'canceled']);

/** Whether a call has not reached an end state yet. */
export function isLive(state: CallState): boolean {
  return !ended.has(state);
}

/**
 * Whether ending the call can be asked for: one still going that nobody has asked to end.
 * One not yet placed is canceled by the server; the others end when the provider says so.
 */
export function canHangUp(call: Call): boolean {
  return isLive(call.state) && !call.hangUpRequested;
}

/** The badge a state is drawn with. */
export function stateTone(state: CallState): 'assistant' | 'attention' | 'neutral' {
  if (state === 'connected') return 'assistant';
  if (state === 'unknown' || state === 'refused' || state === 'rejected') return 'attention';
  return 'neutral';
}

/** Seconds from the answer to the end, or null for a call that wasn't answered or is going. */
export function durationOf(call: Pick<Call, 'connectedAt' | 'endedAt'>): number | null {
  if (call.connectedAt === null || call.endedAt === null) return null;
  const milliseconds = Date.parse(call.endedAt) - Date.parse(call.connectedAt);
  return Math.max(0, Math.round(milliseconds / 1000));
}

/** 65 as 1:05, 3725 as 1:02:05. */
export function durationText(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return hours === 0
    ? `${String(minutes)}:${rest}`
    : `${String(hours)}:${String(minutes).padStart(2, '0')}:${rest}`;
}

export interface CallFilters {
  readonly direction: '' | 'inbound' | 'outbound';
  readonly contactId: string | undefined;
}

/** The query for one page of the list. */
export function callsQueryOf(filters: CallFilters, after: string | undefined): ListCallsQuery {
  return {
    limit: CALLS_PER_PAGE,
    ...(filters.direction === '' ? {} : { direction: filters.direction }),
    ...(filters.contactId === undefined ? {} : { contactId: filters.contactId }),
    ...(after === undefined ? {} : { after }),
  };
}
