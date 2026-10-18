// What Settings → Calendars → Connections works out before it draws: which of a member's
// Google calendars can be linked, what their choice sends, and what the word in the address
// after Google's consent page means.
import {
  googleConnectOutcomes,
  googleRoleWrites,
  type ChooseGoogleCalendarsInput,
  type GoogleConnectOutcome,
  type GoogleConnection,
  type GoogleConnections,
  type GoogleConnectionStatus,
} from '@repo/contracts';

export const googleConnectionsKey = (businessId: string) =>
  ['b', businessId, 'google-connections'] as const;

/**
 * A member's Google Calendar status, from the team's list. Undefined when it isn't known:
 * the list isn't shown to this person, or the member never connected one.
 */
export function googleStatusOf(
  connections: GoogleConnections | undefined,
  membershipId: string | null | undefined,
): GoogleConnectionStatus | undefined {
  if (membershipId === null || membershipId === undefined) return undefined;
  return connections?.team?.find((each) => each.membershipId === membershipId)?.status;
}

/**
 * Whether Google Meet can be a member's meeting place: only on an install that connects
 * Google, for a member whose Google Calendar is connected. Anyone else's Meet would never
 * get a link, so a booking is given their next place instead.
 */
export function meetAvailableFor(
  connections: GoogleConnections | undefined,
  membershipId: string,
): boolean {
  return (
    connections?.available === true && googleStatusOf(connections, membershipId) === 'connected'
  );
}

/** The word Google's redirect brought back, when it is one the server sends. */
export function outcomeOf(search: unknown): GoogleConnectOutcome | undefined {
  return googleConnectOutcomes.find((outcome) => outcome === search);
}

/** The calendars appointments can be written into: those the member may add events to. */
export function linkableCalendars(connection: GoogleConnection): GoogleConnection['calendars'] {
  return connection.calendars.filter((calendar) => googleRoleWrites(calendar.accessRole));
}

/** What the page shows chosen: the saved choice, or the member's unsaved one. */
export interface CalendarChoice {
  readonly linkedCalendarId: string | null;
  readonly conflictCalendarIds: readonly string[];
}

export function savedChoice(connection: GoogleConnection): CalendarChoice {
  return {
    linkedCalendarId: connection.linkedCalendarId,
    conflictCalendarIds: connection.calendars
      .filter((calendar) => calendar.checkConflicts)
      .map((calendar) => calendar.id),
  };
}

/** Whether the choice differs from what is saved: order of the conflict list aside. */
export function choiceChanged(connection: GoogleConnection, choice: CalendarChoice): boolean {
  const saved = savedChoice(connection);
  const sorted = (ids: readonly string[]) => [...ids].sort().join('\n');
  return (
    saved.linkedCalendarId !== choice.linkedCalendarId ||
    sorted(saved.conflictCalendarIds) !== sorted(choice.conflictCalendarIds)
  );
}

/** One calendar ticked or unticked, keeping Google's order. */
export function toggledConflict(
  connection: GoogleConnection,
  choice: CalendarChoice,
  calendarId: string,
  checked: boolean,
): CalendarChoice {
  const chosen = new Set(choice.conflictCalendarIds);
  if (checked) chosen.add(calendarId);
  else chosen.delete(calendarId);
  return {
    ...choice,
    conflictCalendarIds: connection.calendars
      .map((calendar) => calendar.id)
      .filter((id) => chosen.has(id)),
  };
}

export function choiceInput(choice: CalendarChoice): ChooseGoogleCalendarsInput {
  return {
    linkedCalendarId: choice.linkedCalendarId,
    conflictCalendarIds: [...choice.conflictCalendarIds],
  };
}

/** The select's value for "don't add appointments": an id Google never gives. */
export const NO_LINKED_CALENDAR = '\u0000none';
