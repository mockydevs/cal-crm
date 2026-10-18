// Bulk actions on contacts, against a migrated Postgres as crm_app under row-level
// security, through the routes the server registers and the job the worker runs.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  contactBulkAction,
  contactBulkActionList,
  contactBulkItemList,
  contactDetails,
  contactList,
  type ContactBulkAction,
  type ContactBulkItemList,
  type Permission,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  detailOptions,
  team,
  waitingForLock,
  type Gate,
  type Member,
  type Team,
} from '../../test/contact-details.js';
import { seedContacts } from '../../test/contacts.js';
import { createCrmRoutes } from '../index.js';
import { contactBulkRoutes, createContactBulkTasks } from './bulk-routes.js';
import { contactBulkCommands } from './bulk.js';
import { contactDetailRoutes } from './detail-routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const gate: Gate = { whenResolving: () => Promise.resolve() };
const options = detailOptions(gate);
const routes = [
  ...createCrmRoutes({}, options),
  ...contactDetailRoutes(options),
  ...contactBulkRoutes(options),
];
const [task] = createContactBulkTasks(options);
const commands = contactBulkCommands(options);

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

function call(
  operationId: string,
  invocation: Invocation,
  request: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return Promise.resolve(
    route.run(
      { invocation, params: request.params ?? {}, query: request.query ?? {}, body: request.body },
      services,
    ),
  );
}

const bulk = async (invocation: Invocation, body: unknown): Promise<ContactBulkAction> =>
  contactBulkAction.parse(await call('bulkUpdateContacts', invocation, { body }));
const read = async (invocation: Invocation, id: string): Promise<ContactBulkAction> =>
  contactBulkAction.parse(await call('getContactBulkAction', invocation, { params: { id } }));
const cancel = async (invocation: Invocation, id: string): Promise<ContactBulkAction> =>
  contactBulkAction.parse(await call('cancelContactBulkAction', invocation, { params: { id } }));
const history = async (invocation: Invocation, query: Record<string, string> = {}) =>
  contactBulkActionList.parse(await call('listContactBulkActions', invocation, { query }));
const itemsOf = async (
  invocation: Invocation,
  id: string,
  query: Record<string, string> = {},
): Promise<ContactBulkItemList> =>
  contactBulkItemList.parse(
    await call('listContactBulkActionItems', invocation, { params: { id }, query }),
  );

const person = async (t: Team, firstName: string, lastName = 'Example'): Promise<string> =>
  ((await call('createContact', t.system(), { body: { firstName, lastName } })) as { id: string })
    .id;

const owner = (run: string, values: readonly unknown[] = []) =>
  database.as('crm_owner', (sql) => sql.query<Record<string, string>>(run, [...values]));

async function tag(t: Team, name: string): Promise<string> {
  const [row] = await owner(
    `insert into crm.tags (business_id, name, created_by_kind) values ($1, $2, 'system') returning id`,
    [t.businessId, name],
  );
  return toPublicId('tag', row?.['id'] ?? '');
}

/** The names of the tags each contact has, by contact id. */
async function tagsOf(t: Team, ids: readonly string[]): Promise<Record<string, string[]>> {
  const rows = await owner(
    `select rt.record_id, t.name from crm.record_tags rt
     join crm.tags t on t.business_id = rt.business_id and t.id = rt.tag_id
     where rt.business_id = $1 order by t.name`,
    [t.businessId],
  );
  return Object.fromEntries(
    ids.map((id) => [
      id,
      rows
        .filter((row) => row['record_id'] === parsePublicId('contact', id))
        .map((row) => row['name'] ?? ''),
    ]),
  );
}

/** The business's events of a kind, oldest first: who acted and on which contact. */
const eventsOf = (t: Team, type: string) =>
  owner(
    `select e.actor_kind, e.actor_id, e.payload ->> 'recordId' as record, e.subject_id
     from events.events e where e.business_id = $1 and e.type = $2 order by e.recorded_at, e.id`,
    [t.businessId, type],
  );

/** Runs the worker's job for an action, as the queue would: as the system, in the business. */
const runJob = (t: Team, action: ContactBulkAction): Promise<void> => {
  if (task === undefined) throw new Error('No bulk task.');
  return task.run(
    { bulkActionId: parsePublicId('bulk_action', action.id) ?? '' },
    { invocation: t.system(), services },
  );
};

const trash = (t: Team, id: string) => call('trashContact', t.system(), { params: { id } });

describe('a bulk action on the contacts named', () => {
  it('adds tags to each, once, and says what became of every contact', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const [vip, news] = [await tag(t, 'VIP'), await tag(t, 'Newsletter')];
    const [ada, grace, alan] = [
      await person(t, 'Ada'),
      await person(t, 'Grace'),
      await person(t, 'Alan'),
    ];
    const gone = await person(t, 'Gone');
    await trash(t, gone);
    const other = await team(database);
    const theirs = await person(other, 'Theirs');
    // Grace has one of the two tags already; Alan has both.
    await bulk(t.system(), {
      action: 'add_tags',
      tagIds: [vip],
      selection: { ids: [grace, alan] },
    });
    await bulk(t.system(), { action: 'add_tags', tagIds: [news], selection: { ids: [alan] } });

    const action = await bulk(dana.as(), {
      action: 'add_tags',
      name: 'Tag the fair',
      tagIds: [vip, news],
      selection: { ids: [ada, grace, alan, gone, theirs] },
    });
    expect(action).toMatchObject({
      name: 'Tag the fair',
      action: 'add_tags',
      status: 'completed',
      requested: 5,
      done: 2,
      unchanged: 1,
      skipped: 2,
      actor: { kind: 'user', name: 'Dana Brooks', you: true },
      canCancel: false,
    });
    expect(action.finishedAt).not.toBeNull();
    expect(await tagsOf(t, [ada, grace, alan, gone])).toEqual({
      [ada]: ['Newsletter', 'VIP'],
      [grace]: ['Newsletter', 'VIP'],
      [alan]: ['Newsletter', 'VIP'],
      [gone]: [],
    });
    expect((await itemsOf(dana.as(), action.id)).items).toEqual([
      { contactId: ada, name: 'Ada Example', outcome: 'done', reason: null },
      { contactId: grace, name: 'Grace Example', outcome: 'done', reason: null },
      { contactId: alan, name: 'Alan Example', outcome: 'unchanged', reason: null },
      {
        contactId: gone,
        name: 'Gone Example',
        outcome: 'skipped',
        reason: { code: 'in_trash', message: expect.any(String) as string },
      },
      // Another business's contact is not found, and nothing of it is told.
      {
        contactId: theirs,
        name: null,
        outcome: 'skipped',
        reason: { code: 'not_found', message: 'This contact was not found.' },
      },
    ]);
    expect((await itemsOf(dana.as(), action.id, { outcome: 'skipped' })).items).toHaveLength(2);
    expect(await tagsOf(other, [theirs])).toEqual({ [theirs]: [] });
    // One event for each tag a contact gained, by the person who started the action: the
    // same event a single edit writes.
    const mine = (await eventsOf(t, 'tag.assigned')).filter(
      (event) => event['actor_id'] === dana.userId,
    );
    expect(mine.map((event) => event['record']).sort()).toEqual([ada, ada, grace].sort());
  });

  it('removes the tags named, or every tag, and leaves the rest', async () => {
    const t = await team(database);
    const [vip, news, old] = [await tag(t, 'VIP'), await tag(t, 'Newsletter'), await tag(t, 'Old')];
    const [ada, grace] = [await person(t, 'Ada'), await person(t, 'Grace')];
    await bulk(t.system(), {
      action: 'add_tags',
      tagIds: [vip, news, old],
      selection: { ids: [ada] },
    });
    await bulk(t.system(), { action: 'add_tags', tagIds: [news], selection: { ids: [grace] } });

    const named = await bulk(t.system(), {
      action: 'remove_tags',
      tagIds: [vip, old],
      selection: { ids: [ada, grace] },
    });
    expect(named).toMatchObject({ done: 1, unchanged: 1, skipped: 0, status: 'completed' });
    expect(await tagsOf(t, [ada, grace])).toEqual({
      [ada]: ['Newsletter'],
      [grace]: ['Newsletter'],
    });
    expect(await eventsOf(t, 'tag.removed')).toHaveLength(2);

    const every = await bulk(t.system(), {
      action: 'remove_tags',
      all: true,
      selection: { ids: [ada, grace] },
    });
    expect(every).toMatchObject({ done: 2, unchanged: 0 });
    expect(await tagsOf(t, [ada, grace])).toEqual({ [ada]: [], [grace]: [] });
    // Again: nothing is left to remove, and nothing is written.
    expect(
      await bulk(t.system(), {
        action: 'remove_tags',
        all: true,
        selection: { ids: [ada, grace] },
      }),
    ).toMatchObject({ done: 0, unchanged: 2 });
    expect(await eventsOf(t, 'tag.removed')).toHaveLength(4);
  });

  it('moves contacts to the trash, where each can be restored', async () => {
    const t = await team(database);
    const [ada, grace] = [await person(t, 'Ada'), await person(t, 'Grace')];
    await trash(t, grace);
    const action = await bulk(t.system(), { action: 'trash', selection: { ids: [ada, grace] } });
    expect(action).toMatchObject({ done: 1, unchanged: 1, skipped: 0 });
    expect(contactList.parse(await call('listContacts', t.system())).items).toEqual([]);
    expect(await eventsOf(t, 'contact.trashed')).toHaveLength(2);
    await call('restoreContact', t.system(), { params: { id: ada } });
    expect(contactList.parse(await call('listContacts', t.system())).items).toHaveLength(1);
  });

  it('gives contacts an owner, or none, as the single change does', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const lee = await t.member('Lee Park');
    const [ada, grace] = [await person(t, 'Ada'), await person(t, 'Grace')];
    const ownerOf = async (id: string) =>
      contactDetails.parse(await call('getContactDetails', dana.as(), { params: { id } })).owner
        ?.name ?? null;

    const mine = await bulk(dana.as(), {
      action: 'assign_owner',
      owner: 'me',
      selection: { ids: [ada] },
    });
    expect(mine).toMatchObject({ done: 1 });
    const theirs = await bulk(dana.as(), {
      action: 'assign_owner',
      owner: lee.membershipId,
      selection: { ids: [ada, grace] },
    });
    expect(theirs).toMatchObject({ done: 2, unchanged: 0 });
    expect([await ownerOf(ada), await ownerOf(grace)]).toEqual(['Lee Park', 'Lee Park']);
    expect(
      await bulk(dana.as(), {
        action: 'assign_owner',
        owner: lee.membershipId,
        selection: { ids: [ada, grace] },
      }),
    ).toMatchObject({ done: 0, unchanged: 2 });
    expect(
      await bulk(dana.as(), { action: 'assign_owner', owner: null, selection: { ids: [ada] } }),
    ).toMatchObject({ done: 1 });
    expect([await ownerOf(ada), await ownerOf(grace)]).toEqual([null, 'Lee Park']);
    expect((await eventsOf(t, 'contact.owner_assigned')).map((event) => event['actor_id'])).toEqual(
      [dana.userId, dana.userId, dana.userId],
    );
    expect(await eventsOf(t, 'contact.owner_unassigned')).toHaveLength(1);
  });

  it('refuses what it cannot start, and starts nothing', async () => {
    const t = await team(database);
    const other = await team(database);
    const ada = await person(t, 'Ada');
    const theirTag = await tag(other, 'Theirs');
    const outsider = await other.member('Out Sider');
    const selection = { ids: [ada] };
    await expect(
      bulk(t.system(), { action: 'add_tags', tagIds: [theirTag], selection }),
    ).rejects.toMatchObject({
      issues: [{ path: '/tagIds/0', code: 'unknown_tag' }],
    });
    await expect(
      bulk(t.system(), { action: 'assign_owner', owner: outsider.membershipId, selection }),
    ).rejects.toMatchObject({ issues: [{ path: '/owner', code: 'unavailable_member' }] });
    for (const body of [
      { action: 'add_tags', tagIds: [], selection },
      { action: 'remove_tags', selection },
      { action: 'remove_tags', all: true, tagIds: [theirTag], selection },
      { action: 'trash', selection: { ids: [] } },
      { action: 'trash', selection: { ids: [ada, ada] } },
      { action: 'export', selection },
      { action: 'trash', selection, name: ' ' },
    ])
      await expect(bulk(t.system(), body)).rejects.toBeInstanceOf(ValidationError);
    expect((await history(t.system())).items).toEqual([]);
    expect(
      await owner('select 1 as n from crm.contact_bulk_action_items where business_id = $1', [
        t.businessId,
      ]),
    ).toEqual([]);
  });

  it('takes the permission of what it changes as well as contacts.manage', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const ada = await person(t, 'Ada');
    const vip = await tag(t, 'VIP');
    const only = (...names: Permission[]) => dana.as(new Set(names));
    await expect(
      bulk(only('contacts.manage'), {
        action: 'add_tags',
        tagIds: [vip],
        selection: { ids: [ada] },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      bulk(only('contacts.manage'), {
        action: 'remove_tags',
        all: true,
        selection: { ids: [ada] },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await tagsOf(t, [ada])).toEqual({ [ada]: [] });
    expect((await history(t.system())).items).toEqual([]);
    expect(
      await bulk(only('contacts.manage', 'tags.manage'), {
        action: 'add_tags',
        tagIds: [vip],
        selection: { ids: [ada] },
      }),
    ).toMatchObject({ done: 1 });
    // Someone who may not change contacts sees an action and cannot stop it.
    const listed = await history(only());
    expect(listed.items[0]).toMatchObject({ canCancel: false });
  });

  it('writes one audit row with the action and the ids, and nothing a person typed', async () => {
    const t = await team(database);
    const ada = await person(t, 'Ada');
    const vip = await tag(t, 'VIP');
    await bulk(t.system(), {
      action: 'add_tags',
      name: 'Private words',
      tagIds: [vip],
      selection: { ids: [ada] },
    });
    await bulk(t.system(), {
      action: 'trash',
      selection: { all: true, q: 'ada', except: [] },
    });
    const audit = await database.as('crm_owner', (sql) =>
      sql.query<{ input: unknown; outcome: string }>(
        `select input, outcome from audit.commands
         where business_id = $1 and command = 'contact.bulk' order by recorded_at, id`,
        [t.businessId],
      ),
    );
    expect(audit).toEqual([
      { input: { action: 'add_tags', tagIds: [vip], selection: { ids: [ada] } }, outcome: 'ok' },
      { input: { action: 'trash', selection: { all: true, except: [] } }, outcome: 'ok' },
    ]);
  });
});

describe('a bulk action on a whole list', () => {
  /** A business with `count` contacts named First n Last n, and a tag. */
  async function listed(count: number) {
    const t = await team(database);
    await seedContacts(database, t.businessId, count);
    return { t, vip: await tag(t, 'VIP') };
  }
  const taggedCount = async (t: Team) =>
    Number(
      (
        await owner('select count(*)::text as n from crm.record_tags where business_id = $1', [
          t.businessId,
        ])
      )[0]?.['n'],
    );

  it('fixes the contacts when it starts, runs in the background in batches, and names every one', async () => {
    const { t, vip } = await listed(250);
    const dana = await t.member('Dana Brooks');
    const page = contactList.parse(
      await call('listContacts', t.system(), { query: { limit: '2' } }),
    );
    const except = page.items.map((item) => item.id);

    const queued = await bulk(dana.as(), {
      action: 'add_tags',
      tagIds: [vip],
      selection: { all: true, except },
    });
    expect(queued).toMatchObject({
      status: 'queued',
      requested: 248,
      done: 0,
      startedAt: null,
      finishedAt: null,
      canCancel: true,
    });
    expect(await taggedCount(t)).toBe(0);
    // A contact added after the action started is not part of it.
    const late = await person(t, 'Late');

    await runJob(t, queued);
    const done = await read(dana.as(), queued.id);
    expect(done).toMatchObject({
      status: 'completed',
      requested: 248,
      done: 248,
      unchanged: 0,
      skipped: 0,
      canCancel: false,
    });
    expect(done.startedAt).not.toBeNull();
    expect(await taggedCount(t)).toBe(248);
    expect(await tagsOf(t, [late, ...except])).toEqual(
      Object.fromEntries([late, ...except].map((id) => [id, []])),
    );
    // Every contact of the selection has its line, in the order applied, by pages.
    const lines: ContactBulkItemList['items'] = [];
    let after: number | null = null;
    do {
      const next: ContactBulkItemList = await itemsOf(dana.as(), queued.id, {
        limit: '100',
        ...(after === null ? {} : { after: String(after) }),
      });
      lines.push(...next.items);
      after = next.next;
    } while (after !== null);
    expect(lines).toHaveLength(248);
    expect(new Set(lines.map((line) => line.contactId)).size).toBe(248);
    expect(lines.every((line) => line.outcome === 'done')).toBe(true);
    // Every change was made in the name of the person who started it.
    const events = await eventsOf(t, 'tag.assigned');
    expect(events).toHaveLength(248);
    expect(new Set(events.map((event) => event['actor_id']))).toEqual(new Set([dana.userId]));
    // Three batches: 100, 100 and 48, each its own audit row.
    const batches = await owner(
      `select count(*)::text as n from audit.commands
       where business_id = $1 and command = 'contact.bulk.apply_batch' and outcome = 'ok'`,
      [t.businessId],
    );
    expect(batches[0]?.['n']).toBe('3');
  });

  it('keeps to the search and the filters of the list', async () => {
    const { t, vip } = await listed(120);
    // First1, First10 to First19 and First100 to First120: 32 contacts, applied at once.
    const filter = {
      match: 'all',
      groups: [
        {
          match: 'all',
          conditions: [{ field: 'firstName', operator: 'contains', value: 'first1' }],
        },
      ],
    };
    const action = await bulk(t.system(), {
      action: 'add_tags',
      tagIds: [vip],
      selection: { all: true, filter },
    });
    expect(action).toMatchObject({ status: 'completed', requested: 32, done: 32 });
    const searched = await bulk(t.system(), {
      action: 'remove_tags',
      tagIds: [vip],
      selection: { all: true, q: 'first11' },
    });
    // First11 and First110 to First119.
    expect(searched).toMatchObject({ requested: 11, done: 11 });
    expect(await taggedCount(t)).toBe(21);
    await expect(
      bulk(t.system(), { action: 'trash', selection: { all: true, q: 'nobody-here' } }),
    ).rejects.toMatchObject({ issues: [{ path: '/selection', code: 'empty_selection' }] });
    // A contact in the trash is not in a list, so not in a whole list's action.
    await bulk(t.system(), { action: 'trash', selection: { all: true, q: 'first11' } });
    expect(
      await bulk(t.system(), {
        action: 'add_tags',
        tagIds: [vip],
        selection: { all: true, filter },
      }),
    ).toMatchObject({ requested: 21, done: 0, unchanged: 21 });
  });

  it('starts one action for a request sent twice, and applies no contact twice when its job runs again', async () => {
    const { t, vip } = await listed(150);
    const requestId = randomUUID();
    const body = { action: 'add_tags', tagIds: [vip], selection: { all: true }, requestId };
    const first = await bulk(t.system(), body);
    const again = await bulk(t.system(), body);
    expect(again.id).toBe(first.id);
    expect((await history(t.system())).items).toHaveLength(1);

    await runJob(t, first);
    await runJob(t, first);
    expect(await read(t.system(), first.id)).toMatchObject({
      status: 'completed',
      done: 150,
      unchanged: 0,
    });
    expect(await eventsOf(t, 'tag.assigned')).toHaveLength(150);
    // Sent once more after it ended: still the same action, and nothing new.
    expect(await bulk(t.system(), body)).toMatchObject({
      id: first.id,
      status: 'completed',
      done: 150,
    });
    expect(await eventsOf(t, 'tag.assigned')).toHaveLength(150);
  });

  it('changes each contact once when two runs of its job overlap', async () => {
    const { t } = await listed(150);
    const lee = await t.member('Lee Park');
    const queued = await bulk(t.system(), {
      action: 'assign_owner',
      owner: lee.membershipId,
      selection: { all: true },
    });
    // The first run is held inside its first batch, where it resolves the new owner, with
    // the action's row locked. The second run must wait for that row: it is seen waiting.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    gate.whenResolving = async () => {
      gate.whenResolving = () => Promise.resolve();
      entered();
      await held;
    };
    const first = runJob(t, queued);
    await inside;
    const second = runJob(t, queued);
    await waitingForLock(database);
    release();
    await Promise.all([first, second]);

    expect(await read(t.system(), queued.id)).toMatchObject({
      status: 'completed',
      done: 150,
      unchanged: 0,
      skipped: 0,
    });
    const events = await eventsOf(t, 'contact.owner_assigned');
    expect(events).toHaveLength(150);
    expect(new Set(events.map((event) => event['subject_id'])).size).toBe(150);
  });

  it('refuses a single change made from what a bulk action has since replaced', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const lee = await t.member('Lee Park');
    const ada = await person(t, 'Ada');
    const before = contactDetails.parse(
      await call('getContactDetails', dana.as(), { params: { id: ada } }),
    );

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // The bulk action resolves its owner twice: when it starts, and for the contact, which
    // it then holds. It is stopped at the second.
    let resolved = 0;
    gate.whenResolving = async () => {
      resolved += 1;
      if (resolved !== 2) return;
      gate.whenResolving = () => Promise.resolve();
      entered();
      await held;
    };
    const running = bulk(dana.as(), {
      action: 'assign_owner',
      owner: lee.membershipId,
      selection: { ids: [ada] },
    });
    await inside;
    // Someone gives the contact to Dana from the page they opened before: it waits for the
    // contact, which the bulk action holds, and is then stale.
    const single = call('assignContactOwner', dana.as(), {
      params: { id: ada },
      body: { owner: dana.membershipId, revision: before.ownerRevision },
    });
    const refused = single.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    await waitingForLock(database);
    release();
    expect(await running).toMatchObject({ done: 1 });
    expect(await refused).toBeInstanceOf(ConflictError);
    const after = contactDetails.parse(
      await call('getContactDetails', dana.as(), { params: { id: ada } }),
    );
    expect(after.owner?.name).toBe('Lee Park');
  });

  it('can be stopped: what was done stays, the rest is left alone', async () => {
    const { t, vip } = await listed(250);
    const queued = await bulk(t.system(), {
      action: 'add_tags',
      tagIds: [vip],
      selection: { all: true },
    });
    // One batch, as the job would run it, then a stop.
    await commandsRun(t, queued);
    expect(await read(t.system(), queued.id)).toMatchObject({
      status: 'running',
      done: 100,
      canCancel: true,
    });
    // No batch is in hand once the stop holds the action, so it stops at once.
    const stopping = await cancel(t.system(), queued.id);
    expect(stopping).toMatchObject({ status: 'cancelled', canCancel: false });
    await runJob(t, queued);
    const stopped = await read(t.system(), queued.id);
    expect(stopped).toMatchObject({
      status: 'cancelled',
      done: 100,
      unchanged: 0,
      skipped: 0,
      canCancel: false,
    });
    expect(stopped.finishedAt).not.toBeNull();
    expect(await taggedCount(t)).toBe(100);
    expect(
      (await itemsOf(t.system(), queued.id, { outcome: 'pending', limit: '100' })).items,
    ).toHaveLength(100);
    // Stopping again, or running the job again, changes nothing.
    expect(await cancel(t.system(), queued.id)).toEqual(stopped);
    await runJob(t, queued);
    expect(await taggedCount(t)).toBe(100);

    // Stopped before it began: nothing is changed at all.
    const never = await bulk(t.system(), { action: 'trash', selection: { all: true } });
    await cancel(t.system(), never.id);
    await runJob(t, never);
    expect(await read(t.system(), never.id)).toMatchObject({ status: 'cancelled', done: 0 });
    expect(
      contactList.parse(await call('listContacts', t.system(), { query: { limit: '1' } })).items,
    ).toHaveLength(1);
  });

  /** One batch of an action, through the command the job runs. */
  async function commandsRun(t: Team, action: ContactBulkAction): Promise<void> {
    const { runCommand } = await import('@repo/commands');
    await runCommand(
      services,
      commands.applyBatch,
      { bulkActionId: parsePublicId('bulk_action', action.id) ?? '' },
      t.system(),
    );
  }
});

describe('the list of bulk actions', () => {
  it('is the business’s own, newest first, by action and status, in pages', async () => {
    const t = await team(database);
    const dana: Member = await t.member('Dana Brooks');
    const ada = await person(t, 'Ada');
    const vip = await tag(t, 'VIP');
    const selection = { ids: [ada] };
    const first = await bulk(dana.as(), {
      action: 'add_tags',
      tagIds: [vip],
      selection,
      name: 'First',
    });
    const second = await bulk(t.system(), { action: 'remove_tags', all: true, selection });
    const third = await bulk(dana.as(), { action: 'trash', selection });

    const all = await history(dana.as());
    expect(all.items.map((item) => item.id)).toEqual([third.id, second.id, first.id]);
    expect(all.next).toBeNull();
    expect(all.items.map((item) => item.actor)).toEqual([
      { kind: 'user', name: 'Dana Brooks', you: true },
      { kind: 'system', name: null, you: false },
      { kind: 'user', name: 'Dana Brooks', you: true },
    ]);
    expect((await history(dana.as(), { action: 'trash' })).items).toEqual([third]);
    expect((await history(dana.as(), { status: 'queued' })).items).toEqual([]);
    expect((await history(dana.as(), { status: 'completed' })).items).toHaveLength(3);
    const page = await history(dana.as(), { limit: '2' });
    expect(page.items.map((item) => item.id)).toEqual([third.id, second.id]);
    expect((await history(dana.as(), { limit: '2', after: page.next ?? '' })).items).toEqual([
      first,
    ]);
    expect(await read(dana.as(), first.id)).toEqual(first);

    // Another business sees none of it, and cannot read, list the contacts of, or stop one.
    const other = await team(database);
    expect((await history(other.system())).items).toEqual([]);
    await expect(read(other.system(), first.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(itemsOf(other.system(), first.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancel(other.system(), first.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('adding contacts to a workflow', () => {
  // The automation module's side stands in here: which workflows exist, and what enrolling
  // a contact came to. The real one is tested with the engine (automation bulk-enrol).
  const enrolled: string[] = [];
  const outcomes = new Map<string, 'already_running' | 'already_went_through' | 'unavailable'>();
  const PUBLISHED = '0198de17-876e-7000-aac7-9bc8ac229001';
  const withWorkflows = {
    ...options,
    workflows: {
      resolve: (_trx: unknown, _invocation: unknown, workflowId: string) =>
        Promise.resolve(
          workflowId === toPublicId('automation', PUBLISHED)
            ? { id: PUBLISHED }
            : workflowId === toPublicId('automation', '0198de17-876e-7000-aac7-9bc8ac229002')
              ? ('not_published' as const)
              : ('not_found' as const),
        ),
      enrol: (_trx: unknown, _invocation: unknown, workflowId: string, contactId: string) => {
        expect(workflowId).toBe(PUBLISHED);
        const outcome = outcomes.get(contactId);
        if (outcome === undefined) enrolled.push(contactId);
        return Promise.resolve(outcome ?? ('started' as const));
      },
    },
  };
  const start = contactBulkRoutes(withWorkflows).find(
    (each) => each.endpoint.operationId === 'bulkUpdateContacts',
  );
  const addTo = async (invocation: Invocation, body: unknown) => {
    if (start === undefined) throw new Error('Missing bulkUpdateContacts');
    return contactBulkAction.parse(
      await start.run({ invocation, params: {}, query: {}, body }, services),
    );
  };

  it('enrols each contact and says why one was not: in it now, been through it, unavailable', async () => {
    const t = await team(database);
    const [ada, grace, alan, omar] = [
      await person(t, 'Ada'),
      await person(t, 'Grace'),
      await person(t, 'Alan'),
      await person(t, 'Omar'),
    ];
    outcomes.set(parsePublicId('contact', grace) ?? '', 'already_running');
    outcomes.set(parsePublicId('contact', alan) ?? '', 'already_went_through');
    outcomes.set(parsePublicId('contact', omar) ?? '', 'unavailable');
    const action = await addTo(t.system(), {
      action: 'add_to_workflow',
      workflowId: toPublicId('automation', PUBLISHED),
      selection: { ids: [ada, grace, alan, omar] },
    });
    expect(action).toMatchObject({
      action: 'add_to_workflow',
      status: 'completed',
      requested: 4,
      done: 1,
      skipped: 3,
    });
    expect(enrolled).toEqual([parsePublicId('contact', ada)]);
    expect((await itemsOf(t.system(), action.id)).items).toEqual([
      { contactId: ada, name: 'Ada Example', outcome: 'done', reason: null },
      {
        contactId: grace,
        name: 'Grace Example',
        outcome: 'skipped',
        reason: {
          code: 'already_in_workflow',
          message: 'This contact is in the workflow now, and is in it once at a time.',
        },
      },
      {
        contactId: alan,
        name: 'Alan Example',
        outcome: 'skipped',
        reason: expect.objectContaining({ code: 'reentry_not_allowed' }) as unknown,
      },
      {
        contactId: omar,
        name: 'Omar Example',
        outcome: 'skipped',
        reason: expect.objectContaining({ code: 'workflow_unavailable' }) as unknown,
      },
    ]);
  });

  it('takes only a published workflow of the business, and the automation permission', async () => {
    const t = await team(database);
    const ada = await person(t, 'Ada');
    const ask = (workflowId: string, invocation = t.system()) =>
      addTo(invocation, { action: 'add_to_workflow', workflowId, selection: { ids: [ada] } });
    await expect(
      ask(toPublicId('automation', '0198de17-876e-7000-aac7-9bc8ac229002')),
    ).rejects.toMatchObject({ issues: [{ path: '/workflowId', code: 'workflow_not_published' }] });
    await expect(
      ask(toPublicId('automation', '0198de17-876e-7000-aac7-9bc8ac229003')),
    ).rejects.toMatchObject({ issues: [{ path: '/workflowId', code: 'unknown_workflow' }] });
    const dana = await t.member('Dana Brooks');
    await expect(
      ask(toPublicId('automation', PUBLISHED), dana.as(new Set<Permission>(['contacts.manage']))),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Without the automation module, no workflow can be chosen.
    await expect(
      bulk(t.system(), {
        action: 'add_to_workflow',
        workflowId: toPublicId('automation', PUBLISHED),
        selection: { ids: [ada] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
