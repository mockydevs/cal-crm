import { ApiError } from '@repo/sdk';

/** A refusal (no access, gone) won't change by asking again; a failing server might. */
export function retryRead(failures: number, error: Error): boolean {
  return failures < 3 && !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}
