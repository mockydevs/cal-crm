// What's wrong with what a form sent, sorted for the form to show: under each field it
// names, or above the buttons. Issues come from the API's problem details (RFC 9457), or
// from the API's own schema checking the form first, so the messages match the server's.
import type * as z from 'zod';

/** One thing wrong with the input: a JSON pointer to it, and why. */
export interface Issue {
  readonly path: string;
  readonly message: string;
}

export interface Rejection {
  /** What's wrong with each field, by its name. */
  readonly fields: Record<string, string>;
  /** What's wrong with the input as a whole, or with saving it. */
  readonly form: string | undefined;
}

export const noRejection: Rejection = { fields: {}, form: undefined };

/** Sorts issues into the fields they name, the first for each, and the rest. */
export function rejection(issues: readonly Issue[]): Rejection {
  const fields: Record<string, string> = {};
  let form: string | undefined;
  for (const issue of issues) {
    const field = issue.path.replace(/^\//, '').split('/')[0] ?? '';
    if (field === '') form ??= issue.message;
    else fields[field] ??= issue.message;
  }
  return { fields, form };
}

/** A schema's issues, as the API reports them. */
export function issuesOf(error: z.ZodError): Issue[] {
  return error.issues.map((issue) => ({
    path: `/${issue.path.map(String).join('/')}`,
    message: issue.message,
  }));
}
