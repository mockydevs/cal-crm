import { expect, it } from 'vitest';

import { evaluateSubmission, type FormSubmissionLimits, type SubmissionFacts } from './policy.js';

const limits: FormSubmissionLimits = {
  busyPerHour: 4,
  ceilingPerHour: 40,
  ceilingPerDay: 100,
  sourcePerHour: 3,
  busySourcePerHour: 1,
  sourcePerDay: 5,
  minFillSeconds: 2,
  busyMinFillSeconds: 8,
};
const now = new Date('2026-10-10T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const none = { stored: 0, oldest: null };
const facts = (
  change: {
    form?: Partial<SubmissionFacts['form']>;
    source?: Partial<SubmissionFacts['source']>;
  } = {},
): SubmissionFacts => ({
  form: { hour: none, day: none, ...change.form },
  source: { hour: none, day: none, ...change.source },
  now,
});
const QUIET = { allowed: true, busy: false, minFillSeconds: 2 };
const BUSY = { allowed: true, busy: true, minFillSeconds: 8 };

it('lets each source send a few submissions an hour and a day, at the usual pace', () => {
  expect(evaluateSubmission(facts(), limits)).toEqual(QUIET);
  expect(
    evaluateSubmission(
      facts({
        source: { hour: { stored: 2, oldest: ago(1000) }, day: { stored: 4, oldest: ago(1000) } },
      }),
      limits,
    ),
  ).toEqual(QUIET);
});

it('stops one source at its own limits, until its oldest submission of the hour or day is old enough', () => {
  expect(
    evaluateSubmission(
      facts({
        source: {
          hour: { stored: 3, oldest: ago(3_590_000) },
          day: { stored: 3, oldest: ago(3_590_000) },
        },
      }),
      limits,
    ),
  ).toEqual({ allowed: false, reason: 'source_hourly', retryAfterSeconds: 10 });
  expect(
    evaluateSubmission(
      facts({
        source: { hour: { stored: 0, oldest: null }, day: { stored: 5, oldest: ago(82_800_000) } },
      }),
      limits,
    ),
  ).toEqual({ allowed: false, reason: 'source_daily', retryAfterSeconds: 3600 });
});

it('keeps taking a busy form’s submissions from new sources, and asks each for more patience', () => {
  // The form has taken more than a quiet hour holds: someone may be flooding it. A visitor
  // who has sent nothing is still let in, after a longer wait on the page.
  const busy = facts({
    form: { hour: { stored: 4, oldest: ago(1000) }, day: { stored: 4, oldest: ago(1000) } },
  });
  expect(evaluateSubmission(busy, limits)).toEqual(BUSY);
  // A source that has sent one this hour waits for the hour: on a busy form, each source
  // gets one.
  expect(
    evaluateSubmission(
      {
        ...busy,
        source: {
          hour: { stored: 1, oldest: ago(600_000) },
          day: { stored: 1, oldest: ago(600_000) },
        },
      },
      limits,
    ),
  ).toEqual({ allowed: false, reason: 'source_hourly', retryAfterSeconds: 3000 });
});

it('refuses outright only past a ceiling far above a busy hour, kept for the database', () => {
  expect(
    evaluateSubmission(
      facts({
        form: {
          hour: { stored: 40, oldest: ago(3_000_000) },
          day: { stored: 40, oldest: ago(3_000_000) },
        },
      }),
      limits,
    ),
  ).toEqual({ allowed: false, reason: 'form_hourly', retryAfterSeconds: 600 });
  // The day first, since it lasts longer, and never more than a day.
  expect(
    evaluateSubmission(
      facts({
        form: {
          hour: { stored: 40, oldest: ago(1000) },
          day: { stored: 100, oldest: new Date(now.getTime() + 5000) },
        },
      }),
      limits,
    ),
  ).toEqual({ allowed: false, reason: 'form_daily', retryAfterSeconds: 86_400 });
});

it('still answers when the counts say full and no oldest submission was read', () => {
  expect(
    evaluateSubmission(facts({ form: { day: { stored: 100, oldest: null } } }), limits),
  ).toEqual({
    allowed: false,
    reason: 'form_daily',
    retryAfterSeconds: 86_400,
  });
  expect(
    evaluateSubmission(facts({ source: { hour: { stored: 3, oldest: null } } }), limits),
  ).toEqual({
    allowed: false,
    reason: 'source_hourly',
    retryAfterSeconds: 3600,
  });
  // A part of a second is a whole second, and the wait is never nothing.
  expect(
    evaluateSubmission(facts({ source: { hour: { stored: 3, oldest: ago(3_600_000) } } }), limits),
  ).toMatchObject({ retryAfterSeconds: 1 });
});
