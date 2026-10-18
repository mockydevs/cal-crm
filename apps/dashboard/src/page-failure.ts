// What the "This page couldn't load" screen works out from the failure it is given
// (page-unavailable.tsx): which of four plain explanations fits, and what to show someone
// who is asked for the details. Nothing here is sent anywhere.

/** Why a page could not be shown, as far as the failure itself says. */
export type FailureKind = 'offline' | 'server' | 'code' | 'other';

const statusOf = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const { status } = error;
  return typeof status === 'number' ? status : undefined;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : '';

/**
 * Which explanation fits. Being offline comes first, since everything else follows from
 * it. A failure that carries a status of 500 or more, or a request that never got an
 * answer, is the server's. A module that could not be fetched is the page's code.
 */
export function failureKind(error: unknown, online: boolean): FailureKind {
  if (!online) return 'offline';
  const message = messageOf(error);
  // Chromium, Firefox and Safari word a failed import differently.
  if (
    /dynamically imported module|error loading dynamically|Importing a module script failed|Unable to preload/i.test(
      message,
    )
  )
    return 'code';
  const status = statusOf(error);
  if (status !== undefined && status >= 500) return 'server';
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'server';
  return 'other';
}

/** The most the details show: enough to recognise the failure, never a page of text. */
const DETAILS_LIMIT = 300;

/**
 * What to show under "Technical details": the failure's name and message, with the status
 * when it has one. None when the failure says nothing.
 */
export function failureDetails(error: unknown): string | undefined {
  const message = messageOf(error).trim();
  const name = error instanceof Error && error.name !== 'Error' ? error.name : '';
  const status = statusOf(error);
  const parts = [
    name,
    status === undefined || message.includes(String(status)) ? '' : `status ${String(status)}`,
    message,
  ].filter((part) => part !== '');
  if (parts.length === 0) return undefined;
  const text = parts.join(': ');
  return text.length > DETAILS_LIMIT ? `${text.slice(0, DETAILS_LIMIT)}…` : text;
}
