// The audit log of the whole business, against a migrated Postgres as crm_app under
// row-level security, through the route the server registers. The commands are the real
// ones.
import {
  allowEveryone,
  runCommand,
  type ApiRoute,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  auditPage,
  bulkTasksResult,
  task,
  type AuditListEntry,
  type AuditPage,
  type Task,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ForbiddenError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions, team, type Member, type Team } from '../../test/contact-details.js';
import { createContactCommand, updateContactCommand } from '../contacts/contacts.js';
import { taskRoutes } from '../tasks/routes.js';
import { activityRoutes } from './routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const options = detailOptions();
const routes: readonly ApiRoute[] = [
  ...activityRoutes({ actorNames: options.actorNames, members: options.assignees }),
  ...taskRoutes({
    actorNames: options.actorNames,
    assignees: {
      ...options.assignees,
      read: () => Promise.resolve({ items: [], nextCursor: null }),
    },
  }),
];
/** As a caller that passes no membership lookup gets them. */
const bare = activityRoutes({ actorNames: options.actorNames });

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

async function call(
  operationId: string,
  invocation: Invocation,
  request: { id?: string; body?: unknown; query?: unknown } = {},
  from: readonly ApiRoute[] = routes,
): Promise<unknown> {
  const route = from.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return route.run(
    {
      invocation,
      params: request.id === undefined ? {} : { id: request.id },
      body: request.body,
      query: request.query ?? {},
    },
    services,
  );
}
const read = async (invocation: Invocation, query: object = {}): Promise<AuditPage> =>
  auditPage.parse(await call('listAudit', invocation, { query }));
const make = async (invocation: Invocation, title: string, more: object = {}): Promise<Task> =>
  task.parse(await call('createTask', invocation, { body: { title, ...more } }));
const failure = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );
const commands = (page: AuditPage) => page.items.map((entry) => entry.command);
const entryOf = (page: AuditPage, command: string): AuditListEntry => {
  const found = page.items.find((entry) => entry.command === command);
  if (found === undefined) throw new Error(`No ${command} entry.`);
  return found;
};

interface Scene {
  readonly t: Team;
  readonly dana: Member;
  readonly lee: Member;
  readonly contactId: string;
  readonly call: Task;
  readonly chase: Task;
  readonly swept: Task;
  /** Just before Lee's first command, and just after his last. */
  readonly leeFrom: string;
  readonly leeBefore: string;
}

const instant = async (): Promise<string> =>
  (
    await database.as('crm_owner', (sql) =>
      sql.one<{ at: string }>(
        `select to_char(clock_timestamp() at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`,
      ),
    )
  ).at;

/**
 * A business where Dana made and renamed a contact, Lee gave it a task and completed it,
 * the system made a task, Dana completed two tasks at once and deleted one; with a refused
 * attempt, an invalid one and a completion that changed nothing in between.
 */
async function scene(): Promise<Scene> {
  const t = await team(database);
  const dana = await t.member('Dana Brooks');
  const lee = await t.member('Lee Park');
  // As a request arrives: with the address and the browser it came from.
  const who = (): Invocation => ({ ...dana.as(), ip: '203.0.113.9', userAgent: 'Browser/1.0' });
  const { id: contactId } = await runCommand(
    services,
    createContactCommand,
    { firstName: 'Maya', emails: ['maya.private@example.test'] },
    who(),
  );
  await runCommand(services, updateContactCommand, { id: contactId, lastName: 'Thompson' }, who());
  const leeFrom = await instant();
  const first = await make(lee.as(), 'Call Maya', { recordId: contactId });
  const callTask = task.parse(
    await call('completeTask', lee.as(), {
      id: first.id,
      body: { completed: true, revision: first.revision },
    }),
  );
  const leeBefore = await instant();
  // Already complete: an ok command that changed nothing and wrote no event.
  await call('completeTask', lee.as(), {
    id: first.id,
    body: { completed: true, revision: callTask.revision },
  });
  await failure(
    runCommand(
      services,
      updateContactCommand,
      { id: contactId, lastName: 'No' },
      dana.as(new Set()),
    ),
  );
  await failure(
    runCommand(services, updateContactCommand, { id: contactId, timeZone: 'Nowhere/Land' }, who()),
  );
  const chase = await make(t.system(), 'Chase the invoice');
  const swept = await make(dana.as(), 'Sweep up');
  bulkTasksResult.parse(
    await call('bulkUpdateTasks', dana.as(), {
      body: { action: 'complete', ids: [chase.id, swept.id] },
    }),
  );
  const current = task.parse(
    await call('completeTask', dana.as(), {
      id: swept.id,
      body: { completed: false, revision: await revisionOf(dana, swept.id) },
    }),
  );
  await call('deleteTask', dana.as(), { id: swept.id, body: { revision: current.revision } });
  return { t, dana, lee, contactId, call: callTask, chase, swept, leeFrom, leeBefore };
}

async function revisionOf(member: Member, id: string): Promise<string> {
  const listed = (await call('listTasks', member.as(), { query: { status: 'all' } })) as {
    items: Task[];
  };
  const found = listed.items.find((each) => each.id === id);
  if (found === undefined) throw new Error(`Task ${id} is not listed.`);
  return found.revision;
}

/** Every command of the scene that changed something, newest first. */
const changes = [
  'task.delete',
  'task.complete',
  'task.bulk',
  'task.create',
  'task.create',
  'task.complete',
  'task.create',
  'contact.update',
  'contact.create',
];

describe("the business's audit log", () => {
  it('lists the commands that changed something, newest first, each with what it was about', async () => {
    const s = await scene();
    const page = await read(s.dana.as());
    expect(commands(page)).toEqual(changes);
    expect(page.next).toBeNull();
    const times = page.items.map((entry) => Date.parse(entry.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    for (const entry of page.items) {
      expect(entry).toMatchObject({ outcome: 'ok', errorCode: null, proposed: false });
      expect(parsePublicId('audit_entry', entry.id)).toBeDefined();
      expect(entry.events.length).toBeGreaterThan(0);
    }

    // Who: a person by name, and whether it is the reader; the system has no name.
    expect(
      page.items.map((entry) => [entry.actor.kind, entry.actor.name, entry.actor.you]),
    ).toEqual([
      ['user', 'Dana Brooks', true],
      ['user', 'Dana Brooks', true],
      ['user', 'Dana Brooks', true],
      ['user', 'Dana Brooks', true],
      ['system', null, false],
      ['user', 'Lee Park', false],
      ['user', 'Lee Park', false],
      ['user', 'Dana Brooks', true],
      ['user', 'Dana Brooks', true],
    ]);
    // What: the module and the action, read from the command's name.
    expect(page.items.map((entry) => [entry.module, entry.action])).toEqual([
      ['tasks', 'deleted'],
      ['tasks', 'updated'],
      ['tasks', 'updated'],
      ['tasks', 'created'],
      ['tasks', 'created'],
      ['tasks', 'updated'],
      ['tasks', 'created'],
      ['contacts', 'updated'],
      ['contacts', 'created'],
    ]);
    // On which thing: its name as it is now, not as it was when the command ran.
    expect(page.items.map((entry) => entry.record)).toEqual([
      { kind: 'task', id: s.swept.id, name: null, exists: false },
      { kind: 'task', id: s.swept.id, name: null, exists: false },
      null,
      { kind: 'task', id: s.swept.id, name: null, exists: false },
      { kind: 'task', id: s.chase.id, name: 'Chase the invoice', exists: true },
      { kind: 'task', id: s.call.id, name: 'Call Maya', exists: true },
      { kind: 'task', id: s.call.id, name: 'Call Maya', exists: true },
      { kind: 'contact', id: s.contactId, name: 'Maya Thompson', exists: true },
      { kind: 'contact', id: s.contactId, name: 'Maya Thompson', exists: true },
    ]);
    // A bulk action is about every task it changed, and names none of them.
    expect(entryOf(page, 'task.bulk')).toMatchObject({ record: null, recordCount: 2 });
    expect(entryOf(page, 'task.bulk').events.map((event) => event.type)).toEqual([
      'task.completed',
      'task.completed',
    ]);
    expect(
      page.items.filter((entry) => entry.command !== 'task.bulk').map((e) => e.recordCount),
    ).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(page.items.at(-1)?.events.map((event) => event.type)).toEqual(['contact.created']);
  });

  it('shows nothing a command was given beyond what a record log shows, and nothing of where it came from', async () => {
    const s = await scene();
    const text = JSON.stringify([
      await read(s.dana.as()),
      await read(s.dana.as(), { outcome: 'denied' }),
      await read(s.dana.as(), { outcome: 'invalid' }),
    ]);
    for (const kept of ['maya.private', '203.0.113.9', 'Browser/1.0', 'Nowhere', 'lastName'])
      expect(text).not.toContain(kept);
    expect((await read(s.dana.as())).items.map((entry) => entry.detail)).toEqual(
      changes.map(() => ({})),
    );
    const stored = await database.as('crm_owner', (sql) =>
      sql.query(
        `select 1 from audit.commands where business_id = $1 and ip = '203.0.113.9'
           and user_agent = 'Browser/1.0' and input ->> 'firstName' = 'Maya'`,
        [s.t.businessId],
      ),
    );
    expect(stored).toHaveLength(1);
  });

  it('lists refused and failed attempts only when asked, and never a command that changed nothing', async () => {
    const s = await scene();
    const denied = await read(s.dana.as(), { outcome: 'denied' });
    expect(denied.items).toMatchObject([
      {
        command: 'contact.update',
        outcome: 'denied',
        errorCode: 'forbidden',
        actor: { name: 'Dana Brooks' },
        events: [],
        record: null,
        recordCount: 0,
        module: 'contacts',
        action: 'updated',
      },
    ]);
    const invalid = await read(s.dana.as(), { outcome: 'invalid' });
    expect(invalid.items.map((entry) => [entry.command, entry.errorCode])).toEqual([
      ['contact.update', 'validation'],
    ]);
    expect((await read(s.dana.as(), { outcome: 'failed' })).items).toEqual([]);
    // The completion of a task already complete is stored as ok, with no event.
    const silent = await database.as('crm_owner', (sql) =>
      sql.query(
        `select 1 from audit.commands where business_id = $1 and command = 'task.complete'
           and outcome = 'ok' and cardinality(event_ids) = 0`,
        [s.t.businessId],
      ),
    );
    expect(silent).toHaveLength(1);
    expect(
      commands(await read(s.dana.as())).filter((each) => each === 'task.complete'),
    ).toHaveLength(2);
  });

  it('filters by who, by kind of actor, by module, by action, by thing and by time, alone or together', async () => {
    const s = await scene();
    const dana = s.dana.as();
    expect(commands(await read(dana, { member: s.lee.membershipId }))).toEqual([
      'task.complete',
      'task.create',
    ]);
    expect(commands(await read(s.lee.as(), { member: 'me' }))).toEqual([
      'task.complete',
      'task.create',
    ]);
    expect(commands(await read(dana, { member: 'me' }))).toHaveLength(6);
    expect(commands(await read(dana, { actorKind: 'system' }))).toEqual(['task.create']);
    expect(commands(await read(dana, { actorKind: 'user' }))).toHaveLength(8);
    expect(commands(await read(dana, { actorKind: 'automation' }))).toEqual([]);

    expect(commands(await read(dana, { module: 'contacts' }))).toEqual([
      'contact.update',
      'contact.create',
    ]);
    expect(commands(await read(dana, { module: 'tasks' }))).toHaveLength(7);
    expect(commands(await read(dana, { module: 'opportunities' }))).toEqual([]);

    expect(commands(await read(dana, { action: 'created' }))).toEqual([
      'task.create',
      'task.create',
      'task.create',
      'contact.create',
    ]);
    expect(commands(await read(dana, { action: 'deleted' }))).toEqual(['task.delete']);
    expect(commands(await read(dana, { action: 'restored' }))).toEqual([]);
    expect(commands(await read(dana, { action: 'updated' }))).toEqual([
      'task.complete',
      'task.bulk',
      'task.complete',
      'contact.update',
    ]);

    // One thing: every command that wrote about it, a bulk action included; and a task's
    // own id finds only the task, not the contact it belongs to.
    expect(commands(await read(dana, { subject: s.swept.id }))).toEqual([
      'task.delete',
      'task.complete',
      'task.bulk',
      'task.create',
    ]);
    expect(commands(await read(dana, { subject: s.contactId }))).toEqual([
      'contact.update',
      'contact.create',
    ]);
    expect(commands(await read(dana, { subject: s.call.id }))).toEqual([
      'task.complete',
      'task.create',
    ]);
    expect(entryOf(await read(dana, { subject: s.chase.id }), 'task.bulk').recordCount).toBe(2);
    for (const nothing of [
      toPublicId('task', '01890a5d-ac96-774b-bcce-000000000001'),
      'not an id',
      '01890a5d-ac96-774b-bcce-000000000001',
    ])
      expect(await read(dana, { subject: nothing })).toEqual({ items: [], next: null });

    expect(commands(await read(dana, { from: s.leeFrom, before: s.leeBefore }))).toEqual([
      'task.complete',
      'task.create',
    ]);
    expect(commands(await read(dana, { before: s.leeFrom }))).toEqual([
      'contact.update',
      'contact.create',
    ]);
    expect(commands(await read(dana, { from: s.leeBefore }))).toHaveLength(5);

    expect(
      commands(await read(dana, { member: 'me', module: 'tasks', action: 'created' })),
    ).toEqual(['task.create']);
    expect(
      commands(await read(dana, { subject: s.swept.id, action: 'updated', from: s.leeBefore })),
    ).toEqual(['task.complete', 'task.bulk']);
    expect(commands(await read(dana, { subject: s.swept.id, member: s.lee.membershipId }))).toEqual(
      [],
    );
    expect(commands(await read(dana, { outcome: 'denied', module: 'tasks' }))).toEqual([]);
    expect(commands(await read(dana, { outcome: 'denied', member: 'me' }))).toEqual([
      'contact.update',
    ]);
  });

  it('refuses a member who is not on the team, and knows only me without the membership lookup', async () => {
    const s = await scene();
    const gone = await s.t.member('Sam Reyes');
    await s.t.remove(gone);
    const refused = await failure(read(s.dana.as(), { member: gone.membershipId }));
    expect(refused).toBeInstanceOf(ValidationError);

    const alone = async (query: object) =>
      auditPage.parse(await call('listAudit', s.lee.as(), { query }, bare));
    expect(commands(await alone({ member: 'me' }))).toEqual(['task.complete', 'task.create']);
    const unknown = await failure(alone({ member: s.dana.membershipId }));
    expect(unknown).toBeInstanceOf(ValidationError);
    expect((unknown as ValidationError).issues).toMatchObject([
      { path: '/member', code: 'unavailable_member' },
    ]);
    // "me" is a person: the system has no entries of its own to ask for by it.
    const machine = await failure(
      call('listAudit', s.t.system(), { query: { member: 'me' } }, bare),
    );
    expect(machine).toBeInstanceOf(ValidationError);
  });

  it('pages by the entry before, each entry once, across entries of one instant and with filters', async () => {
    const s = await scene();
    // A second entry at the very instant of each real one, as two commands of one moment.
    await database.as('crm_owner', (sql) =>
      sql.query(
        `insert into audit.commands (agency_id, business_id, command, actor_kind, outcome,
                                     event_ids, correlation_id, recorded_at)
         select agency_id, business_id, 'note.create', 'system', 'ok', event_ids,
                gen_random_uuid(), recorded_at
         from audit.commands
         where business_id = $1 and outcome = 'ok' and cardinality(event_ids) > 0`,
        [s.t.businessId],
      ),
    );
    const whole = await read(s.dana.as(), { limit: 100 });
    expect(whole.items).toHaveLength(changes.length * 2);
    expect(whole.next).toBeNull();

    const walk = async (query: object): Promise<AuditListEntry[]> => {
      const seen: AuditListEntry[] = [];
      let after: string | undefined;
      for (let pages = 0; pages < 50; pages += 1) {
        const page = await read(s.dana.as(), {
          ...query,
          ...(after === undefined ? {} : { after }),
        });
        seen.push(...page.items);
        if (page.next === null) return seen;
        expect(page.next).toBe(page.items.at(-1)?.id);
        after = page.next;
      }
      throw new Error('The log never ended.');
    };
    for (const limit of [1, 4, 5])
      expect((await walk({ limit })).map((entry) => entry.id)).toEqual(
        whole.items.map((entry) => entry.id),
      );
    expect((await walk({ limit: 2, module: 'tasks' })).map((entry) => entry.command)).toEqual(
      changes.filter((command) => command.startsWith('task.')),
    );
    const ofOne = await read(s.dana.as(), { limit: 100, subject: s.swept.id });
    expect(ofOne.items).toHaveLength(8);
    expect((await walk({ limit: 1, subject: s.swept.id })).map((entry) => entry.id)).toEqual(
      ofOne.items.map((entry) => entry.id),
    );
    // A page asked for by size holds that many, and says there is more.
    const two = await read(s.dana.as(), { limit: 2 });
    expect(two.items).toHaveLength(2);
    expect(two.next).toBe(two.items[1]?.id);
  });

  it('is the business’s own: no other business’s rows, none of the agency’s, and no cursor from elsewhere', async () => {
    const s = await scene();
    const before = await read(s.dana.as());
    const elsewhere = await scene();
    // Rows that name this business's own events at the moment they were recorded, but are
    // the agency's own or a sibling business's: neither is this business's to read.
    const hostile = await database.as('crm_owner', (sql) =>
      sql.query(
        `with sibling as (
           insert into tenancy.businesses (agency_id, name, slug)
           select agency_id, 'Sibling', 'sibling-' || substr(gen_random_uuid()::text, 1, 8)
           from tenancy.businesses where id = $1 returning id)
         insert into audit.commands (agency_id, business_id, command, actor_kind, outcome,
                                     event_ids, correlation_id, recorded_at)
         select a.agency_id, place.business_id, 'contact.trash', 'system', 'ok', a.event_ids,
                gen_random_uuid(), a.recorded_at
         from audit.commands a,
           (select null::uuid as business_id union all select id from sibling) place
         where a.business_id = $1 and a.outcome = 'ok' and cardinality(a.event_ids) > 0
         returning business_id`,
        [s.t.businessId],
      ),
    );
    expect(hostile).toHaveLength(changes.length * 2);
    expect(await read(s.dana.as())).toEqual(before);
    expect(commands(await read(s.dana.as(), { subject: s.contactId }))).toEqual([
      'contact.update',
      'contact.create',
    ]);

    const theirs = await read(elsewhere.dana.as());
    expect(theirs.items).toHaveLength(changes.length);
    expect(theirs.items.map((entry) => entry.id)).not.toEqual(
      expect.arrayContaining([before.items[0]?.id]),
    );
    // Another business's thing finds nothing here, and its entry is no place to page from.
    expect(await read(s.dana.as(), { subject: elsewhere.contactId })).toEqual({
      items: [],
      next: null,
    });
    const foreign = await failure(read(s.dana.as(), { after: theirs.items[0]?.id }));
    expect(foreign).toBeInstanceOf(ValidationError);
    expect((foreign as ValidationError).issues).toMatchObject([
      { path: '/after', code: 'not_in_audit_log' },
    ]);
  });

  it('needs audit.read, checked before anything is read, and a business', async () => {
    const s = await scene();
    for (const permissions of [
      new Set<never>(),
      new Set(['tasks.manage', 'contacts.manage'] as const),
    ]) {
      const refused = await failure(read(s.dana.as(permissions), { subject: 'not an id' }));
      expect(refused).toBeInstanceOf(ForbiddenError);
      expect((refused as ForbiddenError).permission).toBe('audit.read');
    }
    expect((await read(s.dana.as(new Set(['audit.read'])))).items).toHaveLength(changes.length);
    const wrong = await failure(read(s.dana.as(), { module: 'billing' }));
    expect(wrong).toBeInstanceOf(ValidationError);
  });
});
