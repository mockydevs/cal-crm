import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  AppError,
  ConflictError,
  ContentTooLargeError,
  ForbiddenError,
  httpStatus,
  jsonPointer,
  NotFoundError,
  ValidationError,
  type Issue,
} from './index.js';

// RFC 9110: 403 Forbidden, 404 Not Found, 409 Conflict, 413 Content Too Large, and 422
// Unprocessable Content for input that parses but breaks a rule.
const expectedStatus = {
  ValidationError: 422,
  NotFoundError: 404,
  ConflictError: 409,
  ForbiddenError: 403,
  ContentTooLargeError: 413,
} as const;

const issue: fc.Arbitrary<Issue> = fc.record(
  {
    path: fc.array(fc.oneof(fc.string(), fc.nat())).map(jsonPointer),
    code: fc.stringMatching(/^[a-z][a-z_]{0,30}$/),
    message: fc.string({ minLength: 1 }),
    suggestion: fc.string({ minLength: 1 }),
  },
  { requiredKeys: ['path', 'code', 'message'] },
);

const anyError: fc.Arbitrary<AppError> = fc.oneof(
  fc.tuple(issue, fc.array(issue)).map(([first, rest]) => new ValidationError([first, ...rest])),
  fc.tuple(fc.string(), fc.string()).map(([resource, id]) => new NotFoundError(resource, id)),
  fc.string().map((message) => new ConflictError(message)),
  fc.string().map((message) => new ForbiddenError(message)),
  fc.nat().map((maxBytes) => new ContentTooLargeError(maxBytes)),
);

describe('errors', () => {
  it('each map to exactly one HTTP status, set by the kind of error alone', () => {
    fc.assert(
      fc.property(anyError, (error) => {
        expect(httpStatus(error)).toBe(expectedStatus[error.name]);
      }),
    );
  });

  it('map different kinds of error to different statuses, so a client can tell them apart', () => {
    const statuses = Object.values(expectedStatus);
    expect(new Set(statuses).size).toBe(statuses.length);
  });

  it('keep the field-level issues of a validation error, and summarize them', () => {
    const error = new ValidationError([
      { path: '/email', code: 'invalid_email', message: "This isn't an email address." },
      {
        path: '/timezone',
        code: 'unknown_time_zone',
        message: "This isn't a time zone.",
        suggestion: 'Did you mean America/New_York?',
      },
    ]);

    expect(error.issues.map((problem) => problem.path)).toEqual(['/email', '/timezone']);
    expect(error.message).toBe(
      "/email: This isn't an email address. /timezone: This isn't a time zone.",
    );
  });

  it('summarize an issue with the input as a whole without a path', () => {
    const error = new ValidationError([
      {
        path: '',
        code: 'email_or_phone_required',
        message: 'Give an email address or a phone number.',
      },
    ]);

    expect(error.message).toBe('Give an email address or a phone number.');
  });

  it('name what was not found', () => {
    expect(new NotFoundError('contact', 'con_01h455vb4pex5vsknk084sn02q').message).toBe(
      'contact con_01h455vb4pex5vsknk084sn02q was not found.',
    );
  });

  it('say where a record merged into another went', () => {
    const error = new NotFoundError('Contact', 'con_01h455vb4pex5vsknk084sn02q', {
      mergedInto: 'con_01h455vb4pex5vsknk084sn02r',
    });

    expect(error.mergedInto).toBe('con_01h455vb4pex5vsknk084sn02r');
    expect(new NotFoundError('Contact', 'con_01h455vb4pex5vsknk084sn02q').mergedInto).toBe(
      undefined,
    );
  });

  it('say how much content is allowed', () => {
    const error = new ContentTooLargeError(26_214_400);

    expect(error.maxBytes).toBe(26_214_400);
    expect(error.message).toBe('Send at most 26214400 bytes.');
  });

  it('are all AppErrors and Errors, so one check catches them', () => {
    fc.assert(
      fc.property(anyError, (error) => {
        expect(error).toBeInstanceOf(AppError);
        expect(error).toBeInstanceOf(Error);
      }),
    );
  });
});

describe('jsonPointer', () => {
  // The escaping examples in RFC 6901, section 5.
  it.each([
    [[], ''],
    [['foo'], '/foo'],
    [['foo', 0], '/foo/0'],
    [[''], '/'],
    [['a/b'], '/a~1b'],
    [['m~n'], '/m~0n'],
    [['c%d'], '/c%d'],
    [[' '], '/ '],
  ])('turns %j into %j', (segments, pointer) => {
    expect(jsonPointer(segments)).toBe(pointer);
  });

  it('escapes ~ before /, so ~1 in a key stays ~1', () => {
    expect(jsonPointer(['~1', '/'])).toBe('/~01/~1');
  });
});
