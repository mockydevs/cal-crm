import type { GoogleConnection, GoogleConnections, GoogleConnectionStatus } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import {
  choiceChanged,
  choiceInput,
  googleStatusOf,
  linkableCalendars,
  meetAvailableFor,
  outcomeOf,
  savedChoice,
  toggledConflict,
} from './calendar-connections-rules';

const connection: GoogleConnection = {
  status: 'connected',
  disconnectedReason: null,
  email: 'dana@example.test',
  linkedCalendarId: 'dana@example.test',
  calendars: [
    {
      id: 'dana@example.test',
      name: 'Dana',
      primary: true,
      accessRole: 'owner',
      checkConflicts: true,
    },
    { id: 'team', name: 'Team', primary: false, accessRole: 'writer', checkConflicts: false },
    {
      id: 'holidays',
      name: 'Holidays',
      primary: false,
      accessRole: 'reader',
      checkConflicts: true,
    },
  ],
  busyCheckedAt: null,
  busyFailing: false,
  connectedAt: '2026-10-15T00:00:00.000Z',
};

describe('Settings → Calendars → Connections', () => {
  it('reads only the outcomes the server sends back', () => {
    expect(outcomeOf('connected')).toBe('connected');
    expect(outcomeOf('scopes_missing')).toBe('scopes_missing');
    expect(outcomeOf('<script>')).toBeUndefined();
    expect(outcomeOf(undefined)).toBeUndefined();
  });

  it('links only calendars the member can add events to', () => {
    expect(linkableCalendars(connection).map((calendar) => calendar.id)).toEqual([
      'dana@example.test',
      'team',
    ]);
  });

  it('keeps Google’s order when ticking, and knows when nothing changed', () => {
    const saved = savedChoice(connection);
    expect(saved).toEqual({
      linkedCalendarId: 'dana@example.test',
      conflictCalendarIds: ['dana@example.test', 'holidays'],
    });
    expect(choiceChanged(connection, saved)).toBe(false);
    const ticked = toggledConflict(connection, saved, 'team', true);
    expect(ticked.conflictCalendarIds).toEqual(['dana@example.test', 'team', 'holidays']);
    expect(choiceChanged(connection, ticked)).toBe(true);
    const unticked = toggledConflict(connection, ticked, 'team', false);
    expect(choiceChanged(connection, unticked)).toBe(false);
    expect(choiceChanged(connection, { ...saved, linkedCalendarId: null })).toBe(true);
    expect(choiceInput({ linkedCalendarId: null, conflictCalendarIds: ['team'] })).toEqual({
      linkedCalendarId: null,
      conflictCalendarIds: ['team'],
    });
  });
});

describe("a member's Google status", () => {
  const row = (membershipId: string, status: GoogleConnectionStatus) => ({
    membershipId,
    status,
    disconnectedReason: status === 'disconnected' ? ('member' as const) : null,
    busyCheckedAt: null,
    busyFailing: false,
  });
  const team: GoogleConnections = {
    available: true,
    mine: null,
    team: [
      row('mem_on', 'connected'),
      row('mem_off', 'disconnected'),
      row('mem_new', 'connecting'),
    ],
  };

  it('is read from the team list, and unknown where the list is not shown', () => {
    expect(googleStatusOf(team, 'mem_off')).toBe('disconnected');
    expect(googleStatusOf(team, 'mem_never')).toBeUndefined();
    expect(googleStatusOf(team, null)).toBeUndefined();
    expect(googleStatusOf({ ...team, team: null }, 'mem_on')).toBeUndefined();
    expect(googleStatusOf(undefined, 'mem_on')).toBeUndefined();
  });

  it('offers Google Meet only to a connected member on an install that connects Google', () => {
    expect(meetAvailableFor(team, 'mem_on')).toBe(true);
    expect(meetAvailableFor(team, 'mem_off')).toBe(false);
    expect(meetAvailableFor(team, 'mem_new')).toBe(false);
    expect(meetAvailableFor(team, 'mem_never')).toBe(false);
    expect(meetAvailableFor({ ...team, available: false }, 'mem_on')).toBe(false);
    expect(meetAvailableFor(undefined, 'mem_on')).toBe(false);
  });
});
