import { createHash, randomUUID } from 'node:crypto';
import { allowEveryone } from '@repo/commands';
import {
  calendarConfiguration,
  type CalendarConfiguration,
  type PublicBookingBody,
  type PublicCalendarParams,
  type PublicAppointmentPage,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import {
  findTimeZone,
  intakeContact,
  setBookingContactTimezone,
  lockBookingContact,
} from '@repo/module-crm';
import {
  resolveCalendarSender,
  readCalendarSenderChoices,
  readEligibleCalendarSenders,
  recordBookingNotificationConsent,
  queueCalendarConfirmation,
  readCalendarConfirmationRecipient,
} from '@repo/module-messaging';
import {
  lockActiveBusiness,
  resolveCalendarMember,
  readCalendarMemberMemberships,
} from '@repo/module-tenancy';
import {
  createSealingVault,
  newSecretsKey,
  parseSecretsPublicKey,
  type SealingVault,
} from '@repo/module-vault';
import { withTenant } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, inject } from 'vitest';
import { createBlockedSlotRoutes, createCalendarRoutes } from '../src/index.js';
import { readTestNames } from './people.js';
import { createPublicBookingHandlers } from '../src/booking.js';
import type {
  BookingShownProof,
  PublicBookingOptions,
  PublicBookingHandlers,
  PublicBookingRequestContext,
} from '../src/public-routes.js';

/**
 * The proof of when the page was shown, as the tests drive it: every well-formed token is
 * accepted, its digest is its mark, and a digest that starts with STALE or SLOW is refused
 * as the forms module's would refuse it (that mechanism is tested in forms/booking-proof).
 */
export const shownProof: BookingShownProof = {
  issue: (calendarId, ipAddress) =>
    `${String(Date.now())}.${createHash('sha256').update(`${calendarId}:${ipAddress}:${randomUUID()}`).digest('base64url')}`,
  check: (_calendarId, _ipAddress, token) => {
    const mark = token.slice(14);
    if (mark.startsWith('STALE')) return { accepted: false, reason: 'stale' };
    if (mark.startsWith('SLOW'))
      return { accepted: false, reason: 'too_fast', retryAfterSeconds: 2 };
    return { accepted: true, mark };
  },
  mark: (_calendarId, _ipAddress, token) => {
    const mark = token.slice(14);
    return mark.startsWith('STALE') ? undefined : mark;
  },
};
/** A token for one booking: `prefix` makes the fake refuse it (STALE or SLOW). */
export const renderToken = (prefix = ''): string =>
  `${String(Date.now())}.${(prefix + createHash('sha256').update(randomUUID()).digest('base64url')).slice(0, 43)}`;

/** A booking as the tests write it: the page's token is filled in when left out. */
export type TestBooking = Omit<PublicBookingBody, 'renderToken'> & {
  readonly renderToken?: string;
};
export type TestBookingHandlers = Omit<PublicBookingHandlers, 'book'> & {
  readonly book: (
    params: PublicCalendarParams,
    input: TestBooking,
    request: PublicBookingRequestContext,
  ) => ReturnType<PublicBookingHandlers['book']>;
};

export const request = (): PublicBookingRequestContext => ({
  requestId: randomUUID(),
  ipAddress: '203.0.113.10',
});
interface CalendarFixture {
  readonly business: Awaited<ReturnType<TestDatabase['fixtures']['business']>>;
  readonly user: Awaited<ReturnType<TestDatabase['fixtures']['user']>>;
  /** The host's business team membership, and the role it holds. */
  readonly membershipId: string;
  readonly roleId: string;
  readonly account: { readonly id: string };
  readonly saved: CalendarConfiguration;
  readonly params: PublicCalendarParams;
}
interface ManagedFixture extends CalendarFixture {
  readonly api: TestBookingHandlers;
  readonly date: string;
  readonly token: string;
  readonly appointment: PublicAppointmentPage;
}
export interface BookingFixtureSuite {
  readonly database: TestDatabase;
  readonly db: Database;
  /**
   * A business with a personal calendar of one host. `user` makes that person the host
   * again in a business of another agency; `mailbox: false` gives the calendar no sender.
   */
  readonly fixture: (
    name?: string,
    given?: {
      readonly user?: CalendarFixture['user'];
      readonly mailbox?: boolean;
      readonly settings?: Readonly<Record<string, unknown>>;
    },
  ) => Promise<CalendarFixture>;
  readonly handlers: (
    intake?: typeof intakeContact,
    options?: PublicBookingOptions['calendars'],
    attribute?: PublicBookingOptions['contacts']['attribute'],
    more?: Partial<Pick<PublicBookingOptions, 'shown' | 'bot' | 'google' | 'texts'>> & {
      readonly assignOwner?: PublicBookingOptions['contacts']['assignOwner'];
    },
  ) => TestBookingHandlers;
  /** Runs a calendar management route in the fixture's business, as someone who may. */
  readonly manage: (
    f: Pick<CalendarFixture, 'business'>,
    operationId: string,
    input: { readonly params?: unknown; readonly query?: unknown; readonly body?: unknown },
    options?: PublicBookingOptions['calendars'],
  ) => Promise<unknown>;
  readonly managedFixture: () => Promise<ManagedFixture>;
}
/** Every calendar port as the server composes it, from the modules that own them. */
export const calendars: PublicBookingOptions['calendars'] = {
  business: { lockActive: lockActiveBusiness },
  timeZones: { find: findTimeZone },
  members: { resolve: resolveCalendarMember, memberships: readCalendarMemberMemberships },
  senders: {
    resolve: resolveCalendarSender,
    choices: readCalendarSenderChoices,
    eligible: readEligibleCalendarSenders,
  },
};
export function bookingFixtureSuite(): BookingFixtureSuite {
  let database: TestDatabase;
  let db: Database;
  let vault: SealingVault;
  beforeAll(async () => {
    database = await testDatabase(inject('databaseServer'));
    db = connectDatabase({
      connectionString: database.url('crm_app'),
      onConnectionError: () => undefined,
    });
    const keys = await newSecretsKey(1);
    vault = await createSealingVault(parseSecretsPublicKey(keys.publicKey));
  });
  afterAll(async () => {
    await db.destroy();
    await database.close();
  });

  function handlers(
    intake = intakeContact,
    options = calendars,
    attribute?: PublicBookingOptions['contacts']['attribute'],
    more: Parameters<BookingFixtureSuite['handlers']>[3] = {},
  ): TestBookingHandlers {
    const real = createPublicBookingHandlers({
      db,
      publicOrigin: 'https://crm.example.test',
      calendars: options,
      shown: more.shown ?? shownProof,
      ...(more.bot === undefined ? {} : { bot: more.bot }),
      // A fresh look at the hosts' Google Calendars, where a test gives one.
      ...(more.google === undefined ? {} : { google: more.google }),
      // "Text me reminders" (migration 0107), where a test gives the port.
      ...(more.texts === undefined ? {} : { texts: more.texts }),
      contacts: {
        intake,
        setTimezone: setBookingContactTimezone,
        lock: lockBookingContact,
        ...(attribute === undefined ? {} : { attribute }),
        ...(more.assignOwner === undefined ? {} : { assignOwner: more.assignOwner }),
      },
      notifications: {
        recordConsent: recordBookingNotificationConsent,
        queue: queueCalendarConfirmation,
        recipient: readCalendarConfirmationRecipient,
      },
    });
    return {
      ...real,
      book: (params, input, context) =>
        real.book(params, { ...input, renderToken: input.renderToken ?? renderToken() }, context),
    };
  }
  async function fixture(
    name = 'Venue tour',
    given: Parameters<BookingFixtureSuite['fixture']>[1] = {},
  ) {
    const agencySlug = `book-${randomUUID().slice(0, 8)}`;
    const agency = await database.fixtures.agency({ slug: agencySlug });
    const business = await database.fixtures.business(agency.id, { slug: 'events' });
    const user = given.user ?? (await database.fixtures.user());
    const membership = await database.withTenant(business.context, (sql) =>
      sql.one<{ id: string; role_id: string }>(
        "with role as (insert into tenancy.roles(agency_id,scope,key,name) values(app.agency_id(),'business','host','Host') returning id) insert into tenancy.memberships(agency_id,business_id,user_id,role_id) select app.agency_id(),app.business_id(),$1,id from role returning id,role_id",
        [user.id],
      ),
    );
    const secretId = await withTenant(db, business.context, (trx) =>
      vault.store(
        trx,
        { agencyId: agency.id, businessId: business.id, purpose: 'mailbox.credentials' },
        'sealed fixture; never dispatched',
      ),
    );
    const account = await database.withTenant(business.context, async (sql) => {
      await sql.query(
        'insert into messaging.settings(business_id,quiet_hours_enabled) values(app.business_id(),false)',
      );
      const account = await sql.one<{ id: string }>(
        "insert into messaging.channel_accounts(business_id,channel,name) values(app.business_id(),'email','Bookings') returning id",
      );
      await sql.query(
        `insert into messaging.mailboxes(business_id,id,email_address,auth_method,smtp_host,smtp_port,smtp_security,smtp_username,secret_id,use_for_conversations)
      values(app.business_id(),$1,'bookings@example.test','password','localhost',1025,'none','fixture',$2,true)`,
        [account.id, secretId],
      );
      return account;
    });
    const invocation = {
      context: { ...business.context, correlationId: randomUUID() },
      permissions: 'all' as const,
    };
    const route = createCalendarRoutes(calendars).find(
      (route) => route.endpoint.operationId === 'createCalendar',
    );
    if (route === undefined) throw new Error('Missing calendar create route.');
    const saved = calendarConfiguration.parse(
      await route.run(
        {
          invocation,
          params: {},
          query: {},
          body: {
            name,
            description: 'Visit the waterfront venue.',
            kind: 'personal',
            timezone: 'UTC',
            bookingSlug: 'venue-tour',
            confirmationSenderId:
              given.mailbox === false ? null : toPublicId('mailbox', account.id),
            isActive: true,
            minNoticeMinutes: 0,
            members: [{ membershipId: toPublicId('membership', membership.id), weight: 1 }],
            weeklyHours: Array.from({ length: 7 }, (_, weekday) => ({
              weekday,
              startTime: '09:00',
              endTime: '17:00',
            })),
            dateOverrides: [],
            ...given.settings,
          },
        },
        { db, authorize: allowEveryone },
      ),
    );
    return {
      business,
      user,
      membershipId: toPublicId('membership', membership.id),
      roleId: membership.role_id,
      account,
      saved,
      params: { agencySlug, businessSlug: 'events', calendarSlug: 'venue-tour' },
    };
  }

  function manage(
    f: Pick<CalendarFixture, 'business'>,
    operationId: string,
    input: { readonly params?: unknown; readonly query?: unknown; readonly body?: unknown },
    options = calendars,
  ) {
    const route = [
      ...createCalendarRoutes(options),
      // Blocked slots are managed beside the calendars.
      ...createBlockedSlotRoutes({ ...options, people: { names: readTestNames } }),
    ].find((candidate) => candidate.endpoint.operationId === operationId);
    if (route === undefined) throw new Error(`Missing ${operationId} route.`);
    return route.run(
      {
        invocation: {
          context: { ...f.business.context, correlationId: randomUUID() },
          permissions: 'all',
        },
        params: input.params ?? {},
        query: input.query ?? {},
        body: input.body,
      },
      { db, authorize: allowEveryone },
    );
  }

  async function managedFixture() {
    const f = await fixture();
    const api = handlers();
    const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const booked = await api.book(
      f.params,
      {
        bookingRequestId: randomUUID(),
        startsAt: `${date}T10:00:00Z`,
        contact: { email: 'management-guards@example.test', phone: '+254712345678' },
        notificationConsent: true,
        contactTimezone: 'UTC',
      },
      request(),
    );
    const token = booked.managementUrl?.split('/').at(-1);
    if (token === undefined) throw new Error('New booking did not return its capability.');
    return { ...f, api, date, token, appointment: await api.appointment(token, request()) };
  }

  return {
    get database() {
      return database;
    },
    get db() {
      return db;
    },
    fixture,
    handlers,
    manage,
    managedFixture,
  };
}
