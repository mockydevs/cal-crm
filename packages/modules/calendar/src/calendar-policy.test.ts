import { describe, expect, it } from 'vitest';

import { bookerValues, inviteTitleOf, policyRefusal } from './calendar-policy.js';

describe("an appointment's title", () => {
  const maya = bookerValues({
    firstName: 'Maya',
    lastName: 'Okafor',
    email: 'maya@example.test',
  });

  it('fills in the merge fields it knows', () => {
    expect(inviteTitleOf('{{contact.name}}', maya, 'Consultation')).toBe('Maya Okafor');
    expect(inviteTitleOf('Call with {{ contact.firstName }}', maya, 'Consultation')).toBe(
      'Call with Maya',
    );
    expect(inviteTitleOf('{{contact.email}} / {{contact.phone}}', maya, 'Consultation')).toBe(
      'maya@example.test /',
    );
  });

  it('names someone who gave no name by their address', () => {
    expect(
      inviteTitleOf('{{contact.name}}', bookerValues({ email: 'x@example.test' }), 'Consultation'),
    ).toBe('x@example.test');
  });

  it('is the calendar’s name when nothing is left, and never longer than 200 characters', () => {
    expect(inviteTitleOf('{{contact.phone}}', maya, 'Consultation')).toBe('Consultation');
    expect(inviteTitleOf('{{deal.name}}  ', maya, 'Consultation')).toBe('Consultation');
    expect(inviteTitleOf('a'.repeat(250), maya, 'Consultation')).toHaveLength(200);
  });

  it('leaves braces that are not a merge field as written', () => {
    expect(inviteTitleOf('{{ not a field }} {{contact.firstName}}', maya, 'C')).toBe(
      '{{ not a field }} Maya',
    );
  });
});

describe('moving or cancelling online', () => {
  const startsAt = new Date('2026-10-20T15:00:00Z');
  const at = (value: string) => new Date(value);

  it('is allowed up to the meeting when the calendar sets no cut-off', () => {
    const open = { allowed: true, cutoffMinutes: null };
    expect(policyRefusal(open, 'cancel', startsAt, at('2026-10-20T14:59:00Z'))).toBeUndefined();
    expect(policyRefusal(open, 'reschedule', startsAt, at('2026-10-01T00:00:00Z'))).toBeUndefined();
  });

  it('is refused when the calendar does not allow it', () => {
    const closed = { allowed: false, cutoffMinutes: null };
    expect(policyRefusal(closed, 'cancel', startsAt, at('2026-10-01T00:00:00Z'))).toBe(
      "This appointment can't be cancelled online. Contact the business instead.",
    );
    expect(policyRefusal(closed, 'reschedule', startsAt, at('2026-10-01T00:00:00Z'))).toBe(
      "This appointment can't be rescheduled online. Contact the business instead.",
    );
  });

  it('stops at the cut-off before the meeting, to the minute', () => {
    const twoHours = { allowed: true, cutoffMinutes: 120 };
    expect(
      policyRefusal(twoHours, 'reschedule', startsAt, at('2026-10-20T13:00:00Z')),
    ).toBeUndefined();
    expect(policyRefusal(twoHours, 'reschedule', startsAt, at('2026-10-20T13:00:01Z'))).toBe(
      'This appointment can no longer be rescheduled online: that was possible until 2 hours before it. Contact the business instead.',
    );
    expect(
      policyRefusal(
        { allowed: true, cutoffMinutes: 1440 },
        'cancel',
        startsAt,
        at('2026-10-20T00:00:00Z'),
      ),
    ).toMatch(/until 1 day before it/);
    expect(
      policyRefusal(
        { allowed: true, cutoffMinutes: 45 },
        'cancel',
        startsAt,
        at('2026-10-20T14:30:00Z'),
      ),
    ).toMatch(/until 45 minutes before it/);
  });
});
