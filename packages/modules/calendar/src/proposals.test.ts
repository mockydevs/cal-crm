import { expect, it } from 'vitest';
import { createCalendarProposables } from './proposals.js';
import type { CalendarOptions } from './calendars.js';
import { ValidationError } from '@repo/kernel';
import type { DatabaseTransaction } from '@repo/db';
import type { Invocation } from '@repo/commands';
import { createCalendarInput } from '@repo/contracts';

it('proposes native calendar commands and validates inputs without executing them', () => {
  const proposals = createCalendarProposables({} as CalendarOptions);
  expect(proposals.map((proposal) => proposal.commandName)).toEqual([
    'calendar.create',
    'calendar.update',
    'calendar.availability.update',
  ]);
  for (const proposal of proposals)
    expect(() => {
      proposal.check({ id: 'foreign' });
    }).toThrow(ValidationError);
});

it('shows every setting that will be created, including booking and consent rules', async () => {
  const input = createCalendarInput.parse({
    name: 'Wedding consult',
    kind: 'personal',
    timezone: 'Africa/Nairobi',
    bookingSlug: 'weddings',
    members: [],
    weeklyHours: [],
    dateOverrides: [],
    slotMinutes: 45,
    consentText: 'May we contact you?',
  });
  const [proposal] = createCalendarProposables({} as CalendarOptions);
  expect(await proposal?.present({} as DatabaseTransaction, input, {} as Invocation)).toMatchObject(
    { details: input },
  );
});
