import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  defineCommand,
  runCommand,
  type ApiRoute,
  type Invocation,
  type Services,
} from '@repo/commands';
import { eventChain, recordActivity, type ActivityEntry } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { NotFoundError, toPublicId, ValidationError, type TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { activityRoutes } from '../index.js';

let database: TestDatabase;
let db: Database;
let services: Services;

// The names the server would look up in the auth module; here, the ones a test gives.
const people = new Map<string, string>();
let routes: readonly ApiRoute[];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  routes = activityRoutes({
    actorNames: {
      user: (_trx, ids) =>
        Promise.resolve(
          new Map(ids.flatMap((id) => (people.has(id) ? [[id, people.get(id) ?? '']] : []))),
        ),
    },
  });
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

function route(operationId: string): ApiRoute {
  const found = routes.find((each) => each.endpoint.operationId === operationId);
  if (found === undefined) {
    throw new Error(`No route for ${operationId}.`);
  }
  return found;
}

// A command that notes something about a record, once or more, on its timeline.
const note = defineCommand({
  name: 'test.note',
  permission: 'tags.manage',
  input: z.strictObject({
    recordId: z.uuid(),
    times: z.int().min(1).default(1),
    kind: z.string().default('contact'),
  }),
  async handle(_trx, input, command) {
    const ids: string[] = [];
    for (let time = 0; time < input.times; time += 1) {
      ids.push(
        await command.emit({
          type: 'contact.noted',
          subject: { kind: input.kind, id: input.recordId },
          payload: { time },
          records: [input.recordId],
        }),
      );
    }
    return ids;
  },
});

// A command whose event names a person by their internal id, as a task's assignment does.
const assign = defineCommand({
  name: 'test.assign',
  permission: 'tags.manage',
  input: z.strictObject({ recordId: z.uuid(), userId: z.uuid() }),
  async handle(_trx, input, command) {
    return [
      await command.emit({
        type: 'contact.noted',
        subject: { kind: 'contact', id: input.recordId },
        payload: { recordId: input.recordId, assignedUserId: input.userId },
        records: [input.recordId],
      }),
    ];
  },
});

// A command the agency itself runs, as business.create does: its event is the agency's.
const announce = defineCommand({
  name: 'test.announce',
  permission: 'agency.security',
  input: z.strictObject({}),
  async handle(_trx, _input, command) {
    return [
      await command.emit({
        type: 'agency.announced',
        subject: { kind: 'agency', id: command.context.agencyId },
      }),
    ];
  },
});

interface Business {
  readonly id: string;
  readonly context: TenantContext;
}

async function business(): Promise<Business> {
  const agency = await database.fixtures.agency();
  return database.fixtures.business(agency.id);
}

/** A person working in the business, named as the given name if there is one. */
async function person(where: Business, name?: string): Promise<Invocation> {
  const user = await database.fixtures.user();
  if (name !== undefined) {
    people.set(user.id, name);
  }
  return {
    context: {
      ...where.context,
      userId: user.id,
      actorKind: 'user',
      actorId: user.id,
      correlationId: randomUUID(),
    },
    // Enough to note things; reading activity needs no permission.
    permissions: new Set(['tags.manage']),
  };
}

/** The system, as the worker acts: caused by an event, if one is given. */
function system(where: Business, causationId?: string): Invocation {
  return {
    context: { ...where.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
    ...(causationId === undefined ? {} : { causationId }),
  };
}

/** The system at the business's agency, with no business chosen, as agency staff work. */
function atTheAgency(where: Business): Invocation {
  return {
    context: { agencyId: where.context.agencyId, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
}

async function noted(invocation: Invocation, recordId: string, times = 1): Promise<string[]> {
  return runCommand(services, note, { recordId, times }, invocation);
}

const listActivity = async (invocation: Invocation, id: string, after?: string) =>
  recordActivity.parse(
    await route('listRecordActivity').run(
      {
        invocation,
        params: { id },
        query: after === undefined ? {} : { after },
        body: undefined,
      },
      services,
    ),
  );

const explain = async (invocation: Invocation, id: string) =>
  eventChain.parse(
    await route('explainEvent').run(
      { invocation, params: { id }, query: {}, body: undefined },
      services,
    ),
  );

const eventId = (uuid: string) => toPublicId('event', uuid);
const contactId = (uuid: string) => toPublicId('contact', uuid);
const ids = (entries: readonly ActivityEntry[]) => entries.map((entry) => entry.id);

describe("GET /records/{id}/activity (a record's activity)", () => {
  it('lists each change to the record, newest first, with who or what made it', async () => {
    const ours = await business();
    const ann = await person(ours, 'Ann Achebe');
    const bea = await person(ours, 'Bea Banda');
    const contact = await database.fixtures.contact(ours.context);

    const [byAnn] = await noted(ann, contact.id);
    const [bySystem] = await noted(system(ours), contact.id);
    const [byBea] = await noted(bea, contact.id);

    const page = await listActivity(ann, contactId(contact.id));

    expect(page.next).toBeNull();
    expect(page.items).toEqual([
      {
        id: eventId(byBea ?? ''),
        type: 'contact.noted',
        occurredAt: expect.any(String) as unknown,
        subject: { kind: 'contact', id: contactId(contact.id) },
        actor: { kind: 'user', name: 'Bea Banda', you: false },
        payload: { time: 0 },
        causedBy: null,
      },
      expect.objectContaining({
        id: eventId(bySystem ?? ''),
        actor: { kind: 'system', name: null, you: false },
      }),
      expect.objectContaining({
        id: eventId(byAnn ?? ''),
        actor: { kind: 'user', name: 'Ann Achebe', you: true },
      }),
    ]);
  });

  it("shows no name for an actor it can't name, and no id for a subject the API has none for", async () => {
    const ours = await business();
    const stranger = await person(ours);
    const contact = await database.fixtures.contact(ours.context);
    await runCommand(services, note, { recordId: contact.id, kind: 'agency' }, stranger);

    const [entry] = (await listActivity(await person(ours), contactId(contact.id))).items;

    expect(entry).toMatchObject({
      actor: { kind: 'user', name: null, you: false },
      subject: { kind: 'agency', id: null },
    });
  });

  it("names the event that caused a change, so 'Why?' can follow it", async () => {
    const ours = await business();
    const ann = await person(ours, 'Ann Achebe');
    const contact = await database.fixtures.contact(ours.context);
    const [cause = ''] = await noted(ann, contact.id);
    const [effect] = await noted(system(ours, cause), contact.id);

    const page = await listActivity(ann, contactId(contact.id));

    expect(page.items[0]).toMatchObject({ id: eventId(effect ?? ''), causedBy: eventId(cause) });
  });

  it('never gives out an internal user id an event carries for the workers', async () => {
    const ours = await business();
    const ann = await person(ours, 'Ann Achebe');
    const contact = await database.fixtures.contact(ours.context);
    await runCommand(services, assign, { recordId: contact.id, userId: randomUUID() }, ann);

    const page = await listActivity(ann, contactId(contact.id));

    expect(page.items[0]?.payload).toEqual({ recordId: contact.id });
  });

  it("leaves out other records' changes", async () => {
    const ours = await business();
    const ann = await person(ours, 'Ann Achebe');
    const contact = await database.fixtures.contact(ours.context);
    const other = await database.fixtures.contact(ours.context);
    const mine = await noted(ann, contact.id);
    await noted(ann, other.id);

    const page = await listActivity(ann, contactId(contact.id));

    expect(ids(page.items)).toEqual(mine.map(eventId));
  });

  it('pages through with no gaps or repeats, among changes made at the same moment', async () => {
    const ours = await business();
    const ann = await person(ours, 'Ann Achebe');
    const contact = await database.fixtures.contact(ours.context);
    // One command's events share a moment, so only their ids tell them apart.
    const first = await noted(ann, contact.id, 60);
    const second = await noted(ann, contact.id, 50);
    const newestFirst = [...first, ...second].reverse().map(eventId);

    const one = await listActivity(ann, contactId(contact.id));
    const two = await listActivity(ann, contactId(contact.id), one.next ?? undefined);
    const three = await listActivity(ann, contactId(contact.id), two.next ?? undefined);

    expect([one.items.length, two.items.length, three.items.length]).toEqual([50, 50, 10]);
    expect([...ids(one.items), ...ids(two.items), ...ids(three.items)]).toEqual(newestFirst);
    expect([one.next, two.next, three.next]).toEqual([newestFirst[49], newestFirst[99], null]);
  });

  it("refuses to start after an entry that isn't in the record's activity", async () => {
    const ours = await business();
    const ann = await person(ours, 'Ann Achebe');
    const contact = await database.fixtures.contact(ours.context);
    const other = await database.fixtures.contact(ours.context);
    const [elsewhere = ''] = await noted(ann, other.id);

    const attempt = listActivity(ann, contactId(contact.id), eventId(elsewhere));

    await expect(attempt).rejects.toThrow(ValidationError);
    await expect(attempt).rejects.toMatchObject({
      issues: [{ path: '/after', code: 'not_in_activity' }],
    });
  });

  it('finds only records in the business, of the kind their id names', async () => {
    const ours = await business();
    const theirs = await business();
    const ann = await person(ours, 'Ann Achebe');
    const contact = await database.fixtures.contact(ours.context);
    const elsewhere = await database.fixtures.contact(theirs.context);

    for (const id of [
      contactId(elsewhere.id),
      toPublicId('deal', contact.id),
      contactId('01890a5d-ac96-774b-bcce-b302099a8057'),
    ]) {
      await expect(listActivity(ann, id)).rejects.toThrow(NotFoundError);
    }
  });

  it('refuses an id that names no record, and a query it takes no part in', async () => {
    const ours = await business();
    const ann = await person(ours, 'Ann Achebe');
    const contact = await database.fixtures.contact(ours.context);

    await expect(listActivity(ann, toPublicId('tag', contact.id))).rejects.toMatchObject({
      issues: [{ path: '/id', message: 'Not a record id.' }],
    });
    await expect(
      route('listRecordActivity').run(
        {
          invocation: ann,
          params: { id: contactId(contact.id) },
          query: { limit: '5' },
          body: undefined,
        },
        services,
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('needs a business to work in', async () => {
    const agency = await database.fixtures.agency();
    const staff: Invocation = {
      context: { agencyId: agency.id, actorKind: 'system', correlationId: randomUUID() },
      permissions: new Set(),
    };

    await expect(
      listActivity(staff, contactId('01890a5d-ac96-774b-bcce-b302099a8057')),
    ).rejects.toThrow('Choose a business first.');
  });
});

describe('GET /events/{id}/why (why an event happened)', () => {
  it('follows each cause back to the event that started the chain, oldest first', async () => {
    const ours = await business();
    const ann = await person(ours, 'Ann Achebe');
    const contact = await database.fixtures.contact(ours.context);
    const [origin = ''] = await noted(ann, contact.id);
    const [middle = ''] = await noted(system(ours, origin), contact.id);
    const [last = ''] = await noted(system(ours, middle), contact.id);

    const chain = await explain(ann, eventId(last));

    expect(chain.reachesOrigin).toBe(true);
    expect(chain.items).toEqual([
      expect.objectContaining({
        id: eventId(origin),
        causedBy: null,
        actor: { kind: 'user', name: 'Ann Achebe', you: true },
      }),
      expect.objectContaining({ id: eventId(middle), causedBy: eventId(origin) }),
      expect.objectContaining({
        id: eventId(last),
        type: 'contact.noted',
        subject: { kind: 'contact', id: contactId(contact.id) },
        causedBy: eventId(middle),
        actor: { kind: 'system', name: null, you: false },
      }),
    ]);
  });

  it('shows an event that nothing caused as its own origin', async () => {
    const ours = await business();
    const ann = await person(ours, 'Ann Achebe');
    const contact = await database.fixtures.contact(ours.context);
    const [only = ''] = await noted(ann, contact.id);

    const chain = await explain(ann, eventId(only));

    expect(chain).toMatchObject({ reachesOrigin: true, items: [{ id: eventId(only) }] });
  });

  it("says the chain doesn't reach its origin when an earlier cause can't be read", async () => {
    const ours = await business();
    const theirs = await business();
    const ann = await person(ours, 'Ann Achebe');
    const contact = await database.fixtures.contact(ours.context);
    const [unseen = ''] = await noted(
      system(theirs),
      (await database.fixtures.contact(theirs.context)).id,
    );
    const [effect = ''] = await noted(system(ours, unseen), contact.id);

    const chain = await explain(ann, eventId(effect));

    expect(chain).toMatchObject({ reachesOrigin: false, items: [{ id: eventId(effect) }] });
  });

  it('follows at most 50 steps', async () => {
    const ours = await business();
    const ann = await person(ours, 'Ann Achebe');
    const contact = await database.fixtures.contact(ours.context);
    const chain: string[] = [];
    for (let step = 0; step < 51; step += 1) {
      const [id = ''] = await noted(system(ours, chain.at(-1)), contact.id);
      chain.push(id);
    }

    const whole = await explain(ann, eventId(chain[49] ?? ''));
    const cut = await explain(ann, eventId(chain[50] ?? ''));

    expect(whole.reachesOrigin).toBe(true);
    expect(ids(whole.items)).toEqual(chain.slice(0, 50).map(eventId));
    expect(cut.reachesOrigin).toBe(false);
    expect(ids(cut.items)).toEqual(chain.slice(1).map(eventId));
  });

  it("inside a business, leaves out the agency's own events, which can name other businesses", async () => {
    const ours = await business();
    const ann = await person(ours, 'Ann Achebe');
    const contact = await database.fixtures.contact(ours.context);
    const [announced = ''] = await runCommand(services, announce, {}, atTheAgency(ours));
    const [effect = ''] = await noted(system(ours, announced), contact.id);

    await expect(explain(ann, eventId(announced))).rejects.toThrow(NotFoundError);
    expect(await explain(ann, eventId(effect))).toMatchObject({
      reachesOrigin: false,
      items: [{ id: eventId(effect) }],
    });
  });

  it('at the agency, follows a chain from the agency into a business', async () => {
    const ours = await business();
    const contact = await database.fixtures.contact(ours.context);
    const [announced = ''] = await runCommand(services, announce, {}, atTheAgency(ours));
    const [effect = ''] = await noted(system(ours, announced), contact.id);

    const chain = await explain(atTheAgency(ours), eventId(effect));

    expect(chain).toMatchObject({
      reachesOrigin: true,
      items: [
        { id: eventId(announced), subject: { kind: 'agency', id: null } },
        { id: eventId(effect) },
      ],
    });
  });

  it("finds only events it can see, and refuses an id that isn't an event's", async () => {
    const ours = await business();
    const theirs = await business();
    const ann = await person(ours, 'Ann Achebe');
    const [elsewhere = ''] = await noted(
      system(theirs),
      (await database.fixtures.contact(theirs.context)).id,
    );

    await expect(explain(ann, eventId(elsewhere))).rejects.toThrow(NotFoundError);
    await expect(explain(ann, contactId(elsewhere))).rejects.toMatchObject({
      issues: [{ path: '/id', message: 'Not an event id.' }],
    });
  });
});
