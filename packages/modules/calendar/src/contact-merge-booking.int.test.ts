// A merge against a booking by one of its contacts, on two connections as crm_app, both ways
// round, with the real booking (its intake holds the contact, and its confirmation then takes
// the business FOR UPDATE) and the real messaging and calendar parts of a merge. One waits for
// the other and neither is a deadlock's victim (40P01).
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { contactMerge, contactMergePreview } from '@repo/contracts';
import {
  contactMergeRoutes,
  createContactCommand,
  intakeContact,
  type ContactMergeParticipant,
} from '@repo/module-crm';
import { messagingContactMerge } from '@repo/module-messaging';
import { expect, it } from 'vitest';

import {
  bookingFixtureSuite,
  request,
  type TestBookingHandlers,
} from '../test/booking-fixtures.js';
import { calendarContactMerge } from './contact-merge.js';

const suite = bookingFixtureSuite();

/** A promise and the function that settles it. */
function gate(): { readonly opened: Promise<void>; open(): void } {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return {
    opened: promise,
    open: () => {
      resolve(undefined);
    },
  };
}

/** Whether a command finished without a deadlock: done, or refused for a reason of its own. */
const finished = (run: Promise<unknown>) =>
  run.then(
    () => 'done',
    (error: unknown) => {
      if ((error as { code?: string }).code === '40P01') return 'deadlock';
      return (error as { name?: string }).name ?? 'failed';
    },
  );

/** Waits until some session of this database waits on a lock. */
async function someoneWaits(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await suite.database.as('postgres', (each) =>
      each.query<{ waiting: number }>(
        `select count(*)::int as waiting from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
      ),
    );
    if ((row?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Fixture timeout: nobody waited on a lock.');
}

/** A calendar that confirms by email, and two contacts: the booker is the one merged away. */
async function scene() {
  const f = await suite.fixture();
  const services: Services = { db: suite.db, authorize: allowEveryone };
  const owner: Invocation = {
    context: { ...f.business.context, actorKind: 'user', correlationId: randomUUID() },
    permissions: 'all',
  };
  const made = (firstName: string, email: string) =>
    runCommand(services, createContactCommand, { firstName, emails: [email] }, owner);
  const kept = await made('Kept', `kept-${randomUUID()}@example.test`);
  const email = `booker-${randomUUID()}@example.test`;
  const merged = await made('Booker', email);
  return { f, services, owner, kept: kept.id, merged: merged.id, email };
}

type Scene = Awaited<ReturnType<typeof scene>>;

async function merge(where: Scene, participants: readonly ContactMergeParticipant[]) {
  const routes = contactMergeRoutes({ participants });
  const route = (id: string) => routes.find((each) => each.endpoint.operationId === id);
  const preview = contactMergePreview.parse(
    await route('previewContactMerge')?.run(
      {
        invocation: where.owner,
        params: { id: where.kept },
        query: { mergeIds: where.merged },
        body: undefined,
      },
      where.services,
    ),
  );
  const revisions = Object.fromEntries(preview.contacts.map((each) => [each.id, each.revision]));
  return contactMerge.parse(
    await route('mergeContacts')?.run(
      {
        invocation: where.owner,
        params: { id: where.kept },
        query: {},
        body: { mergeIds: [where.merged], revisions },
      },
      where.services,
    ),
  );
}

const book = (where: Scene, api: TestBookingHandlers) =>
  api.book(
    where.f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt: `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T10:00:00Z`,
      contact: { email: where.email },
      notificationConsent: true,
      contactTimezone: 'UTC',
    },
    request(),
  );

const participants = [messagingContactMerge, calendarContactMerge];

it('the booking first, holding the contact it found: the merge waits, then is refused as out of date', async () => {
  const where = await scene();
  const paused = gate();
  const held = gate();
  // The booking stops right after its intake has found and locked the contact.
  const api = suite.handlers(async (...args) => {
    const found = await intakeContact(...args);
    paused.open();
    await held.opened;
    return found;
  });
  const booking = finished(book(where, api));
  await Promise.race([
    paused.opened,
    booking.then((outcome) => Promise.reject(new Error(`The booking ended: ${outcome}.`))),
  ]);
  const merging = finished(merge(where, participants));
  await someoneWaits();
  held.open();
  // The booking gave the contact its time zone, so the merge, opened before it, is refused
  // as out of date once it gets the contact: an answer, not a deadlock.
  expect({ booking: await booking, merge: await merging }).toEqual({
    booking: 'done',
    merge: 'ConflictError',
  });
});

it('the merge first: the booking waits, then books for the contact kept', async () => {
  const where = await scene();
  const paused = gate();
  const held = gate();
  const merging = finished(
    merge(where, [
      ...participants,
      {
        name: 'pause',
        merge: async () => {
          paused.open();
          await held.opened;
          return {};
        },
      },
    ]),
  );
  await paused.opened;
  const booking = finished(book(where, suite.handlers()));
  await someoneWaits();
  held.open();
  expect({ merge: await merging, booking: await booking }).toEqual({
    merge: 'done',
    booking: 'done',
  });
});
