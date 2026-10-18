// What the adapters share: turning a transport failure or an HTTP status into one of the
// gateway's failure categories. A vendor's message never leaves an adapter.
import type { ProviderErrorCode, ProviderResponse, TokenUsage } from './provider.js';
import { AiTransportError } from './transport.js';

export type ProviderFailure = Extract<ProviderResponse, { readonly status: 'error' }>;

export const DEFAULT_TIMEOUT_MS = 300_000;
/** A list of models, or an error body, is small. */
export const SMALL_BODY_BYTES = 4 * 1024 * 1024;

export function failure(
  code: ProviderErrorCode,
  usage: TokenUsage | null = null,
  retryAfterMs?: number,
): ProviderFailure {
  return {
    status: 'error',
    code,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    usage,
  };
}

/** What went wrong reaching the provider. Anything unexpected is a programming error. */
export function transportFailure(error: unknown, usage: TokenUsage | null = null): ProviderFailure {
  if (!(error instanceof AiTransportError)) throw error;
  switch (error.code) {
    case 'cancelled':
      return failure('timeout', usage);
    case 'timeout':
      return failure('timeout', usage);
    case 'blocked_address':
      return failure('blocked_address', usage);
    case 'too_large':
      return failure('invalid_response', usage);
    case 'network':
      return failure('unavailable', usage);
  }
}

const MAX_RETRY_AFTER_SECONDS = 86_400;

/**
 * Retry-After as milliseconds, when it is a count of seconds: the form both Anthropic's and
 * OpenAI's rate-limit pages document. Anything else is ignored rather than guessed at.
 */
export function retryAfterMs(header: string | undefined): number | undefined {
  if (header === undefined || !/^\d+(\.\d+)?$/.test(header.trim())) return undefined;
  const seconds = Number(header);
  return seconds > MAX_RETRY_AFTER_SECONDS ? undefined : Math.ceil(seconds * 1000);
}

/** The base address without a trailing slash, so paths join the same way every time. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}
