// Errors on the wire are RFC 9457 problem details (application/problem+json). Each kind of
// error has its own status (@repo/kernel's httpStatus), so the type stays "about:blank"
// and the title is the status's phrase from RFC 9110.
import {
  ForbiddenError,
  httpStatus,
  NotFoundError,
  ValidationError,
  type AppError,
  type Issue,
} from '@repo/kernel';
import * as z from 'zod';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export const issue = z
  .looseObject({
    path: z.string().meta({
      description: "A JSON Pointer to the input's field; empty for the input as a whole.",
    }),
    code: z
      .string()
      .meta({ description: 'What went wrong, for programs.', examples: ['too_long'] }),
    message: z.string().meta({ description: 'What went wrong, for people.' }),
    suggestion: z.string().optional().meta({ description: "How to fix it, when that's known." }),
    existing: z
      .looseObject({
        id: z.string().meta({ examples: ['con_01h455vb4pex5vsknk084sn02q'] }),
        name: z
          .string()
          .nullable()
          .meta({ examples: ['Maya Thompson'] }),
        trashed: z
          .boolean()
          .meta({ description: "Whether it's in the trash, and can be restored." }),
      })
      .optional()
      .meta({
        description:
          'The record that already holds the value, such as the contact with this email address.',
      }),
  })
  .meta({ id: 'Issue', description: 'A problem with one part of the input.' });

export const problem = z
  .looseObject({
    type: z.string().meta({ examples: ['about:blank'] }),
    title: z.string().meta({ examples: ['Unprocessable Content'] }),
    status: z
      .int()
      .min(100)
      .max(599)
      .meta({ examples: [422] }),
    detail: z.string().optional(),
    errors: z.array(issue).optional().meta({ description: 'Each problem with the input.' }),
    permission: z
      .string()
      .optional()
      .meta({
        description: 'For a 403 a role could fix: the permission the request needs.',
        examples: ['tags.manage'],
      }),
    mergedInto: z
      .string()
      .optional()
      .meta({
        description:
          'For a 404 of a record merged into another: the id of the record it was merged into.',
        examples: ['con_01h455vb4pex5vsknk084sn02q'],
      }),
  })
  .meta({ id: 'Problem', description: 'An error, as RFC 9457 problem details.' });

export type Problem = z.infer<typeof problem>;

const titles = {
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Content Too Large',
  422: 'Unprocessable Content',
} as const;

/** The problem details for an error the caller can act on. */
export function problemFor(error: AppError): Problem {
  const status = httpStatus(error);
  const details: Problem = {
    type: 'about:blank',
    title: titles[status],
    status,
    detail: error.message,
  };
  if (error instanceof ValidationError) {
    details.errors = error.issues.map(({ existing, ...each }: Issue) => ({
      ...each,
      ...(existing === undefined ? {} : { existing: { ...existing } }),
    }));
  }
  if (error instanceof ForbiddenError && error.permission !== undefined) {
    details.permission = error.permission;
  }
  if (error instanceof NotFoundError && error.mergedInto !== undefined) {
    details.mergedInto = error.mergedInto;
  }
  return details;
}

/** The problem details for any other failure: what went wrong stays in the logs. */
export const internalServerProblem: Problem = {
  type: 'about:blank',
  title: 'Internal Server Error',
  status: 500,
  detail: 'Something went wrong on our side. It has been logged.',
};
