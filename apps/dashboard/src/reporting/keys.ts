// What Reporting's pages share that draws nothing: the keys their reads are kept under,
// when a failed read is asked for again, and the looks of a small icon button. Kept apart
// from the shared screen parts so a widget, fetched on its own, brings none of them.
import { ApiError } from '@repo/sdk';
import type { RefObject } from 'react';

export const reportingKeys = {
  all: (businessId: string) => ['b', businessId, 'reporting'] as const,
  catalog: (businessId: string) => ['b', businessId, 'reporting', 'catalog'] as const,
  attribution: (businessId: string, query: unknown) =>
    ['b', businessId, 'reporting', 'attribution', query] as const,
  appointments: (businessId: string, query: unknown) =>
    ['b', businessId, 'reporting', 'appointments', query] as const,
  reports: (businessId: string) => ['b', businessId, 'reporting', 'reports'] as const,
  report: (businessId: string, id: string) => ['b', businessId, 'reporting', 'report', id] as const,
  templates: (businessId: string) => ['b', businessId, 'reporting', 'templates'] as const,
  query: (businessId: string, query: unknown) =>
    ['b', businessId, 'reporting', 'query', query] as const,
  calendars: (businessId: string) => ['b', businessId, 'reporting', 'calendars'] as const,
};

export const isForbidden = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 403;

/**
 * Whether a read is asked for again after it failed: twice for a fault of the server or the
 * connection, never for an answer that would be the same again, such as "you may not".
 */
export function retryFaults(failures: number, error: unknown): boolean {
  return !(error instanceof ApiError && error.status < 500) && failures < 2;
}

/** A square button that holds one icon: 32px beside the page, 44px under a finger. */
export const iconButtonClassName =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-control text-body -outline-offset-2 hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-50 lg:size-8';

/** Where the keyboard goes when a dialog closes: what opened it, if that is still there. */
export function returnTo(ref: RefObject<HTMLElement | null>): () => HTMLElement | boolean {
  return () => {
    const opener = ref.current;
    return opener?.isConnected === true ? opener : true;
  };
}
