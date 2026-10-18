/** A problem with one part of the input. */
export interface Issue {
  /** Where: a JSON Pointer (RFC 6901) into the input, or '' for the input as a whole. */
  readonly path: string;
  /** What, as a stable snake_case code for programs, such as unknown_time_zone. */
  readonly code: string;
  /** What, in words for people. */
  readonly message: string;
  /** How to fix it, when that's known. */
  readonly suggestion?: string;
  /**
   * The record that already holds the value, when the input clashes with one, such as
   * the contact that already has this email address. It may be in the trash.
   */
  readonly existing?: ExistingRecord;
}

/** A record an issue points at: its public id, its name if it has one, and if it's in the trash. */
export interface ExistingRecord {
  readonly id: string;
  readonly name: string | null;
  readonly trashed: boolean;
}

/**
 * An error to report to whoever made the request. Each kind has its own HTTP status
 * (httpStatus); anything else that goes wrong is a fault in the server.
 */
export abstract class AppError extends Error {
  abstract override readonly name:
    | 'ValidationError'
    | 'NotFoundError'
    | 'ConflictError'
    | 'ForbiddenError'
    | 'ContentTooLargeError';
}

/** The input breaks one or more rules; each issue says where and why. */
export class ValidationError extends AppError {
  override readonly name = 'ValidationError';

  constructor(readonly issues: readonly [Issue, ...Issue[]]) {
    super(
      issues
        .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
        .join(' '),
    );
  }
}

/** The record doesn't exist, or the caller can't see it, which looks the same from outside. */
export class NotFoundError extends AppError {
  override readonly name = 'NotFoundError';
  /** The public id of the record this one was merged into, when it was: where it went. */
  readonly mergedInto: string | undefined;

  constructor(
    readonly resource: string,
    readonly id: string,
    options: { readonly mergedInto?: string } = {},
  ) {
    super(`${resource} ${id} was not found.`);
    this.mergedInto = options.mergedInto;
  }
}

/** The request clashes with the current state, such as an edit to a stale draft. */
export class ConflictError extends AppError {
  override readonly name = 'ConflictError';
}

/**
 * The caller is known, but isn't allowed to do this. When a role could allow it, the
 * permission it lacks is named, such as tags.manage.
 */
export class ForbiddenError extends AppError {
  override readonly name = 'ForbiddenError';

  constructor(
    message: string,
    readonly permission?: string,
  ) {
    super(message);
  }
}

/** The request carries more than the server takes, such as an upload over the size limit. */
export class ContentTooLargeError extends AppError {
  override readonly name = 'ContentTooLargeError';

  constructor(readonly maxBytes: number) {
    super(`Send at most ${String(maxBytes)} bytes.`);
  }
}

// RFC 9110: 422 Unprocessable Content is for input that parses but breaks a rule; input
// that doesn't parse at all is the framework's 400. 413 Content Too Large is for content
// over a limit.
const statuses = {
  ValidationError: 422,
  NotFoundError: 404,
  ConflictError: 409,
  ForbiddenError: 403,
  ContentTooLargeError: 413,
} as const satisfies Record<AppError['name'], number>;

export type AppErrorStatus = (typeof statuses)[AppError['name']];

/** The HTTP status for an error. Each kind of error has exactly one. */
export function httpStatus(error: AppError): AppErrorStatus {
  return statuses[error.name];
}

/** A JSON Pointer (RFC 6901) from the keys and array indexes that lead to a value. */
export function jsonPointer(segments: readonly (string | number)[]): string {
  return segments
    .map((segment) => `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}
