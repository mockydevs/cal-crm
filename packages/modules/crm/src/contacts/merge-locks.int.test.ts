// A merge against the commands that change one of its contacts at the same time, on two
// connections, as crm_app: a contact edit, a do not disturb change and a note added. Each
// pair runs both ways round (the merge first, holding its contacts; the other first, holding
// its own rows), and both always finish: one waits for the other, and neither is chosen as
// a deadlock's victim (40P01). The other command may be refused once the merge has trashed
// its contact; that is an answer, not a deadlock.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { contactDetails, contactMergePreview } from '@repo/contracts';
import { connectDatabase, withTenant } from '@repo/db';
import { parsePublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions, waitingForLock } from '../../test/contact-details.js';
import { createNoteCommand } from '../notes/notes.js';
import { createContactCommand, updateContactCommand } from './contacts.js';
import { readContactDetails } from './details.js';
import { setContactDndCommand } from './dnd.js';
import type { ContactMergeParticipant } from './merge.js';
import { contactMergeRoutes } from './merge-routes.js';

let database: TestDatabase;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  services = {
    db: connectDatabase({
      connectionString: database.url('crm_app'),
      onConnectionError: () => undefined,
    }),
    authorize: allowEveryone,
  };
});
afterAll(async () => {
  await services.db.destroy();
  await database.close();
});

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

interface Pair {
  readonly owner: Invocation;
  readonly kept: string;
  readonly other: string;
}

async function pair(): Promise<Pair> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const owner: Invocation = {
    context: { ...business.context, actorKind: 'user', correlationId: randomUUID() },
    permissions: 'all',
  };
  const made = async (firstName: string) =>
    (await runCommand(services, createContactCommand, { firstName }, owner)).id;
  return { owner, kept: await made('Kept'), other: await made('Other') };
}

/** Runs the merge; the participant given holds it, its contacts locked, until it is let go. */
async function startMerge(where: Pair, participants: readonly ContactMergeParticipant[]) {
  const [preview, merge] = contactMergeRoutes({ participants });
  if (preview === undefined || merge === undefined) throw new Error('Missing merge routes.');
  const { contacts } = contactMergePreview.parse(
    await preview.run(
      {
        invocation: where.owner,
        params: { id: where.kept },
        query: { mergeIds: where.other },
        body: undefined,
      },
      services,
    ),
  );
  return merge.run(
    {
      invocation: where.owner,
      params: { id: where.kept },
      query: {},
      body: {
        mergeIds: [where.other],
        revisions: Object.fromEntries(contacts.map((each) => [each.id, each.revision])),
      },
    },
    services,
  );
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

const dndRevision = async (where: Pair, id: string) =>
  contactDetails.parse(
    await withTenant(services.db, where.owner.context, (trx) =>
      readContactDetails(trx, where.owner, id, detailOptions()),
    ),
  ).dnd.revision;

const NOTE = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Called back.' }] }],
};
const REASON = 'Asked by phone to get no more messages.';

/** The other writers, each on one of the merge's contacts. */
const writers = {
  'a contact edit': (where: Pair, id: string) =>
    runCommand(services, updateContactCommand, { id, firstName: 'Edited' }, where.owner),
  'a do not disturb change': async (where: Pair, id: string) =>
    runCommand(
      services,
      setContactDndCommand(detailOptions()),
      { id, all: true, channels: [], reason: REASON, revision: await dndRevision(where, id) },
      where.owner,
    ),
  'a note added': (where: Pair, id: string) =>
    runCommand(services, createNoteCommand({}), { id, body: NOTE }, where.owner),
} as const;

describe.each(Object.entries(writers))('a merge against %s', (_name, write) => {
  it.each(['kept', 'other'] as const)(
    'on the %s contact, the merge first: the writer waits, and both finish',
    async (which) => {
      const where = await pair();
      const held = gate();
      const paused = gate();
      const merging = finished(
        startMerge(where, [
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
      const writing = finished(write(where, where[which]));
      await waitingForLock(database);
      held.open();
      expect(await merging).toBe('done');
      expect(['done', 'ConflictError', 'NotFoundError']).toContain(await writing);
    },
  );
});

describe('a merge against a writer that holds its contact first', () => {
  it.each(['kept', 'other'] as const)(
    'a note added to the %s contact: the merge waits, and both finish',
    async (which) => {
      const where = await pair();
      const held = gate();
      const paused = gate();
      // The note's command presents the note through this lookup once the note is written,
      // with its record and its contact still held.
      const author = (await database.fixtures.user()).id;
      const writing = finished(
        runCommand(
          services,
          createNoteCommand({
            user: async () => {
              paused.open();
              await held.opened;
              return new Map();
            },
          }),
          { id: where[which], body: NOTE },
          {
            ...where.owner,
            context: { ...where.owner.context, userId: author, actorId: author },
          },
        ),
      );
      await paused.opened;
      const merging = finished(startMerge(where, []));
      await waitingForLock(database);
      held.open();
      expect(await writing).toBe('done');
      expect(['done', 'ConflictError']).toContain(await merging);
    },
  );

  it.each(['kept', 'other'] as const)(
    'a do not disturb change to the %s contact: the merge waits, and both finish',
    async (which) => {
      const where = await pair();
      const held = gate();
      const paused = gate();
      const base = detailOptions();
      // The change reads the contact's people through this lookup once it has written.
      const writing = finished(
        runCommand(
          services,
          setContactDndCommand({
            ...base,
            assignees: {
              ...base.assignees,
              memberships: async (trx, context, userIds) => {
                paused.open();
                await held.opened;
                return base.assignees.memberships(trx, context, userIds);
              },
            },
          }),
          {
            id: where[which],
            all: true,
            channels: [],
            reason: REASON,
            revision: await dndRevision(where, where[which]),
          },
          where.owner,
        ),
      );
      await paused.opened;
      const merging = finished(startMerge(where, []));
      await waitingForLock(database);
      held.open();
      expect(await writing).toBe('done');
      // The change made the revision the merge was opened on stale.
      expect(await merging).toBe('ConflictError');
    },
  );

  it.each(['kept', 'other'] as const)(
    'a contact edit of the %s contact: the merge waits, and both finish',
    async (which) => {
      const where = await pair();
      const held = gate();
      const paused = gate();
      const id = parsePublicId('contact', where[which]) ?? '';
      // What the edit does, in its order: the contact's row first, then its change, its
      // event (whose foreign key holds the business) and the event's timeline entry.
      const writing = finished(
        database.withTenant(where.owner.context, async (sql) => {
          await sql.query('select id from crm.contacts where id = $1 for no key update', [id]);
          paused.open();
          await held.opened;
          await sql.query(`update crm.contacts set first_name = 'Edited' where id = $1`, [id]);
          await sql.query(
            `with event as (
               insert into events.events (agency_id, business_id, type, actor_kind,
                 correlation_id, subject_kind, subject_id)
               values ($2, app.business_id(), 'contact.updated', 'user', uuidv7(), 'contact', $1)
               returning id, recorded_at)
             insert into crm.timeline_entries (business_id, record_id, occurred_at, event_id,
               event_recorded_at, event_type)
             select app.business_id(), $1, recorded_at, id, recorded_at, 'contact.updated'
             from event`,
            [id, where.owner.context.agencyId],
          );
        }),
      );
      await paused.opened;
      const merging = finished(startMerge(where, []));
      await waitingForLock(database);
      held.open();
      expect(await writing).toBe('done');
      expect(await merging).toBe('ConflictError');
    },
  );
});

it("moves a series' task made while the merge waited for the series", async () => {
  const where = await pair();
  const other = parsePublicId('contact', where.other) ?? '';
  const kept = parsePublicId('contact', where.kept) ?? '';
  const [series] = await database.as('crm_owner', (sql) =>
    sql.query<{ id: string }>(
      `insert into crm.task_series (business_id, record_id, title, frequency, every,
         anchor_due_at, time_zone, lead_seconds, next_run_at, created_by_kind)
       select business_id, id, 'Call back', 'daily', 1, now(), 'UTC', 0, now(), 'system'
       from crm.contacts where id = $1 returning id`,
      [other],
    ),
  );
  const seriesId = series?.id ?? '';
  const held = gate();
  const paused = gate();
  // What the worker does to make the series' next task, in its order: the series' row
  // first, which the contact's lock doesn't hold back, then the task on the series' record.
  const making = database.withTenant(where.owner.context, async (sql) => {
    await sql.query('select id from crm.task_series where id = $1 for update', [seriesId]);
    paused.open();
    await held.opened;
    await sql.query(
      `insert into crm.tasks (business_id, record_id, title, due_at, series_id, occurrence,
         created_by_kind)
       values (app.business_id(), $1, 'Call back', now(), $2, 2, 'system')`,
      [other, seriesId],
    );
  });
  await paused.opened;
  const merging = finished(startMerge(where, []));
  await waitingForLock(database);
  held.open();
  await making;
  expect(await merging).toBe('done');
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query('select record_id from crm.tasks where series_id = $1', [seriesId]),
    ),
  ).toEqual([{ record_id: kept }]);
});

/** Whether another session gets the contact's row with this lock now, without waiting. */
const takes = (contactId: string, lock: 'for key share' | 'for no key update') =>
  database.as('crm_owner', async (sql) => {
    await sql.query("set local lock_timeout = '200ms'");
    return sql.query(`select id from crm.contacts where id = $1 ${lock}`, [contactId]).then(
      () => true,
      (error: unknown) => {
        if ((error as { code?: string }).code !== '55P03') throw error;
        return false;
      },
    );
  });

it('holds every contact against changes while it runs, and leaves them free for foreign keys', async () => {
  const where = await pair();
  const held = gate();
  const paused = gate();
  const merging = finished(
    startMerge(where, [
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
  for (const id of [where.kept, where.other]) {
    const uuid = parsePublicId('contact', id) ?? '';
    expect(await takes(uuid, 'for key share')).toBe(true);
    expect(await takes(uuid, 'for no key update')).toBe(false);
  }
  held.open();
  expect(await merging).toBe('done');
});
