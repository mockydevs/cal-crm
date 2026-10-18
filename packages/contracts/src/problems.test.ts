import {
  ConflictError,
  ContentTooLargeError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type AppError,
} from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { internalServerProblem, problem, problemFor } from './index.js';

// RFC 9457: with type "about:blank", the title is the status code's phrase (RFC 9110).
describe('problemFor', () => {
  it.each<[string, AppError, number, string]>([
    ['not found', new NotFoundError('tag', 'tag_01h455vb4pex5vsknk084sn02q'), 404, 'Not Found'],
    ['a conflict', new ConflictError('Someone else changed this draft.'), 409, 'Conflict'],
    ['forbidden', new ForbiddenError("You can't delete contacts."), 403, 'Forbidden'],
    ['content over a limit', new ContentTooLargeError(1024), 413, 'Content Too Large'],
  ])('describes %s with its status, its phrase and the message', (_case, error, status, title) => {
    expect(problemFor(error)).toEqual({
      type: 'about:blank',
      title,
      status,
      detail: error.message,
    });
  });

  it('lists every issue of a validation error', () => {
    const error = new ValidationError([
      { path: '/name', code: 'too_long', message: 'Use at most 60 characters.' },
      {
        path: '/name',
        code: 'similar_tag',
        message: 'A tag like this exists.',
        suggestion: 'Use "Hot lead".',
      },
    ]);

    expect(problemFor(error)).toEqual({
      type: 'about:blank',
      title: 'Unprocessable Content',
      status: 422,
      detail: error.message,
      errors: error.issues,
    });
  });

  it('names the record an issue clashes with, so a form can link to it', () => {
    const existing = { id: 'con_01h455vb4pex5vsknk084sn02q', name: 'Maya Thompson', trashed: true };
    const error = new ValidationError([
      {
        path: '/emails/0',
        code: 'taken',
        message: 'Another contact has this email address.',
        existing,
      },
    ]);

    const described = problemFor(error);

    expect(described.errors).toEqual([expect.objectContaining({ existing })]);
    expect(problem.parse(described)).toEqual(described);
    expect(
      problem.safeParse({ ...described, errors: [{ ...error.issues[0], existing: {} }] }).success,
    ).toBe(false);
  });

  it('names the permission a refusal is for, so a program can tell what to ask for', () => {
    const error = new ForbiddenError("You don't have permission to manage tags.", 'tags.manage');

    expect(problemFor(error)).toEqual({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: error.message,
      permission: 'tags.manage',
    });
  });

  it('names the record a merged one went into, so a program can follow it', () => {
    const error = new NotFoundError('Contact', 'con_01h455vb4pex5vsknk084sn02q', {
      mergedInto: 'con_01h455vb4pex5vsknk084sn02r',
    });

    expect(problemFor(error)).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: error.message,
      mergedInto: 'con_01h455vb4pex5vsknk084sn02r',
    });
    expect(problem.parse(problemFor(error))).toEqual(problemFor(error));
  });

  it('gives problems that the problem schema accepts', () => {
    const errors: AppError[] = [
      new ValidationError([{ path: '', code: 'required', message: 'Give a name.' }]),
      new NotFoundError('tag', 'tag_01h455vb4pex5vsknk084sn02q'),
      new ForbiddenError("You don't have permission to manage tags.", 'tags.manage'),
    ];

    for (const error of errors) {
      expect(problem.parse(problemFor(error))).toEqual(problemFor(error));
    }
  });
});

describe('internalServerProblem', () => {
  it('says only that the server failed, so nothing internal leaks', () => {
    expect(internalServerProblem).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Something went wrong on our side. It has been logged.',
    });
    expect(problem.parse(internalServerProblem)).toEqual(internalServerProblem);
  });
});
