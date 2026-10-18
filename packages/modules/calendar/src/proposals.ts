import { createHash } from 'node:crypto';
import { defineProposable, type Proposable } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId } from '@repo/kernel';
import { sql } from 'kysely';
import {
  createCalendarCommand,
  readCalendar,
  updateCalendarCommand,
  updateCalendarAvailabilityCommand,
  type CalendarOptions,
} from './calendars.js';

async function fingerprint(trx: DatabaseTransaction, id?: string): Promise<string> {
  const uuid = id === undefined ? undefined : parsePublicId('calendar', id);
  if (id !== undefined && uuid === undefined) throw new NotFoundError('calendar', id);
  let calendars = trx
    .selectFrom('calendar.calendars')
    .selectAll()
    .where('business_id', '=', sql<string>`app.business_id()`);
  if (uuid !== undefined) calendars = calendars.where('id', '=', uuid);
  const rows = await calendars.orderBy('id').execute();
  if (id !== undefined && rows.length === 0) throw new NotFoundError('calendar', id);
  if (uuid === undefined) return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const members = await trx
    .selectFrom('calendar.calendar_members')
    .selectAll()
    .where('calendar_id', '=', uuid)
    .orderBy('user_id')
    .execute();
  const hours = await trx
    .selectFrom('calendar.weekly_hours')
    .selectAll()
    .where('calendar_id', '=', uuid)
    .orderBy('weekday')
    .orderBy('start_time')
    .execute();
  const overrides = await trx
    .selectFrom('calendar.date_overrides')
    .selectAll()
    .where('calendar_id', '=', uuid)
    .orderBy('on_date')
    .orderBy('start_time')
    .execute();
  return createHash('sha256')
    .update(JSON.stringify([rows, members, hours, overrides]))
    .digest('hex');
}

export function createCalendarProposables(options: CalendarOptions): readonly Proposable[] {
  return [
    defineProposable({
      kind: 'calendar_create',
      command: createCalendarCommand(options),
      action: 'publish',
      agents: ['copilot'],
      subject: () => Promise.resolve({}),
      revision: (trx) => fingerprint(trx),
      present: (_trx, input) =>
        Promise.resolve({
          kind: 'crm_change',
          operationId: 'createCalendar',
          name: input.name,
          details: input,
        }),
      capture: () => Promise.resolve(undefined),
      result: (output) => ({ calendarId: output.calendar.id }),
      undo: () => ({ impossible: 'live_configuration' }),
    }),
    defineProposable({
      kind: 'calendar_update',
      command: updateCalendarCommand(options),
      action: 'publish',
      agents: ['copilot'],
      subject: () => Promise.resolve({}),
      revision: (trx, input) => fingerprint(trx, input.id),
      async present(trx, input, invocation) {
        const before = await readCalendar(trx, invocation, input.id, options);
        if (before.revision !== input.settings.revision)
          throw new ConflictError('The calendar changed. Read it again before proposing changes.');
        return {
          kind: 'crm_change',
          operationId: 'updateCalendar',
          name: input.settings.name,
          details: { calendarId: input.id, settings: input.settings },
        };
      },
      capture: () => Promise.resolve(undefined),
      result: (output) => ({ calendarId: output.calendar.id }),
      undo: () => ({ impossible: 'live_configuration' }),
    }),
    defineProposable({
      kind: 'calendar_availability',
      command: updateCalendarAvailabilityCommand(options),
      action: 'publish',
      agents: ['copilot'],
      subject: () => Promise.resolve({}),
      revision: (trx, input) => fingerprint(trx, input.id),
      async present(trx, input, invocation) {
        const before = await readCalendar(trx, invocation, input.id, options);
        if (before.revision !== input.revision)
          throw new ConflictError(
            'The calendar changed. Read it again before proposing availability.',
          );
        return {
          kind: 'crm_change',
          operationId: 'updateCalendarAvailability',
          name: before.calendar.name,
          details: {
            calendarId: input.id,
            members: input.members,
            weeklyHours: input.weeklyHours,
            dateOverrides: input.dateOverrides,
          },
        };
      },
      capture: () => Promise.resolve(undefined),
      result: (output) => ({ calendarId: output.calendar.id }),
      undo: () => ({ impossible: 'live_configuration' }),
    }),
  ];
}
