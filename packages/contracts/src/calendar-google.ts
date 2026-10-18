// Google Calendar for each team member, as GoHighLevel's Calendar Settings →
// Connections. A member connects their own Google account, chooses the calendars whose busy
// time keeps bookings away (conflict calendars) and the one calendar their appointments are
// written into (the linked calendar). Managers read every member's status, never a token.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** The most calendars one connection checks for conflicts: one freeBusy request's limit. */
export const GOOGLE_CONFLICT_CALENDARS_MAX = 50;

/** Google's own calendar ids are free text up to this long (calendar.google_calendars). */
const googleCalendarId = z.string().min(1).max(1024);

export const googleConnectionStatuses = ['connecting', 'connected', 'disconnected'] as const;
export type GoogleConnectionStatus = (typeof googleConnectionStatuses)[number];

export const googleDisconnectedReasons = [
  'member',
  'expired_or_revoked',
  'membership_ended',
] as const;
export type GoogleDisconnectedReason = (typeof googleDisconnectedReasons)[number];

/** Google's access roles (calendarList, accessRole). A writer or owner may be linked. */
export const googleAccessRoles = [
  'freeBusyReader',
  'reader',
  'writerWithoutPrivateAccess',
  'writer',
  'owner',
] as const;
export type GoogleAccessRole = (typeof googleAccessRoles)[number];

/** Whether appointments can be written into a calendar with this role. */
export function googleRoleWrites(role: GoogleAccessRole): boolean {
  return role === 'writer' || role === 'owner';
}

export const googleCalendar = z
  .strictObject({
    id: googleCalendarId,
    name: z.string(),
    primary: z.boolean(),
    accessRole: z.enum(googleAccessRoles),
    checkConflicts: z.boolean().meta({ description: 'Whether its busy time keeps bookings away.' }),
  })
  .meta({ id: 'GoogleCalendar' });
export type GoogleCalendar = z.output<typeof googleCalendar>;

export const googleConnection = z
  .strictObject({
    status: z.enum(googleConnectionStatuses).meta({
      description:
        'connecting: connected, and its calendars are being read. disconnected: Google is no longer checked or written to; conflict checks for this member use the CRM only.',
    }),
    disconnectedReason: z.enum(googleDisconnectedReasons).nullable(),
    email: z.string().meta({ description: 'The Google account, as a label.' }),
    linkedCalendarId: googleCalendarId.nullable().meta({
      description: 'The calendar appointments are written into. Null: none are written.',
    }),
    calendars: z.array(googleCalendar).meta({ description: "In Google's order." }),
    busyCheckedAt: timestamp.nullable().meta({
      description: 'When the busy time was last read from Google.',
    }),
    busyFailing: z.boolean().meta({
      description:
        'Google has not answered since the last read. After 15 minutes this member is not offered for times Google was not read for.',
    }),
    connectedAt: timestamp,
  })
  .meta({ id: 'GoogleConnection' });
export type GoogleConnection = z.output<typeof googleConnection>;

export const googleTeamConnection = z
  .strictObject({
    membershipId: publicId('membership'),
    status: z.enum(googleConnectionStatuses),
    disconnectedReason: z.enum(googleDisconnectedReasons).nullable(),
    busyCheckedAt: timestamp.nullable(),
    busyFailing: z.boolean(),
  })
  .meta({ id: 'GoogleTeamConnection' });
export type GoogleTeamConnection = z.output<typeof googleTeamConnection>;

export const googleConnections = z
  .strictObject({
    available: z.boolean().meta({
      description: 'Whether this install can connect Google at all (its OAuth client is set).',
    }),
    mine: googleConnection
      .nullable()
      .meta({ description: 'Your own connection in this business, if you ever made one.' }),
    team: z.array(googleTeamConnection).nullable().meta({
      description:
        "Each member's connection, for those who manage calendars or book appointments; null for everyone else.",
    }),
  })
  .meta({ id: 'GoogleConnections' });
export type GoogleConnections = z.output<typeof googleConnections>;

export const googleConnectStarted = z
  .strictObject({
    authorizationUrl: z.url({ protocol: /^https$/ }).meta({
      description: "Google's consent page. Open it in the browser; Google sends you back.",
    }),
  })
  .meta({ id: 'GoogleConnectStarted' });
export type GoogleConnectStarted = z.output<typeof googleConnectStarted>;

export const chooseGoogleCalendarsInput = z
  .strictObject({
    linkedCalendarId: googleCalendarId.nullable(),
    conflictCalendarIds: z
      .array(googleCalendarId)
      .max(GOOGLE_CONFLICT_CALENDARS_MAX, {
        error: `Check at most ${String(GOOGLE_CONFLICT_CALENDARS_MAX)} calendars for conflicts.`,
      })
      .refine((ids) => new Set(ids).size === ids.length, { error: 'Name each calendar once.' }),
  })
  .meta({ id: 'ChooseGoogleCalendarsInput' });
export type ChooseGoogleCalendarsInput = z.input<typeof chooseGoogleCalendarsInput>;

/** What the browser is sent back to Connections with, after Google's page: one word. */
export const googleConnectOutcomes = [
  'connected',
  'denied',
  'scopes_missing',
  'expired',
  'failed',
] as const;
export type GoogleConnectOutcome = (typeof googleConnectOutcomes)[number];

export const getGoogleConnections = defineEndpoint({
  operationId: 'getGoogleConnections',
  method: 'get',
  path: '/integrations/google',
  summary: 'Read your Google Calendar connection, and the team’s for managers',
  group: 'Calendars',
  response: {
    status: 200,
    description: 'Your connection and the team’s.',
    schema: googleConnections,
  },
});

export const connectGoogle = defineEndpoint({
  operationId: 'connectGoogle',
  method: 'post',
  path: '/integrations/google/connect',
  summary: 'Start connecting your Google Calendar',
  group: 'Calendars',
  response: {
    status: 201,
    description: 'Open the address to give consent; it can be used once, for ten minutes.',
    schema: googleConnectStarted,
  },
});

export const chooseGoogleCalendars = defineEndpoint({
  operationId: 'chooseGoogleCalendars',
  method: 'put',
  path: '/integrations/google/calendars',
  summary: 'Choose your linked calendar and the calendars checked for conflicts',
  group: 'Calendars',
  body: chooseGoogleCalendarsInput,
  response: { status: 200, description: 'Your connection.', schema: googleConnection },
});

export const refreshGoogleCalendars = defineEndpoint({
  operationId: 'refreshGoogleCalendars',
  method: 'post',
  path: '/integrations/google/refresh',
  summary: 'Read your Google calendars and busy time again',
  group: 'Calendars',
  response: {
    status: 200,
    description: 'Your connection; the reading is queued.',
    schema: googleConnection,
  },
});

export const disconnectGoogle = defineEndpoint({
  operationId: 'disconnectGoogle',
  method: 'delete',
  path: '/integrations/google',
  summary: 'Disconnect your Google Calendar',
  group: 'Calendars',
  response: {
    status: 204,
    description:
      'Disconnected: Google is no longer read or written to, and access is revoked at Google. Events already written stay in your Google calendar.',
  },
});

export const googleCalendarEndpoints = [
  getGoogleConnections,
  connectGoogle,
  chooseGoogleCalendars,
  refreshGoogleCalendars,
  disconnectGoogle,
] as const;
