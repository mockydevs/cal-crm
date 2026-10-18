// The bell's endpoints, run as the server runs them: the caller's own list, count, read
// state and preferences, and nobody else's by any path.
import { randomUUID } from 'node:crypto';

import type { Invocation } from '@repo/commands';
import {
  notification,
  notificationKinds,
  notificationList,
  notificationPreferences,
  NOTIFICATION_PAGE_SIZE,
  unreadNotificationCount,
  UNREAD_NOTIFICATIONS_SHOWN,
  type Notification,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { ForbiddenError, NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  atAgency,
  place,
  suite,
  things,
  toldIn,
  type Person,
  type Place,
} from '../test/fixtures.js';
import {
  createNotificationRoutes,
  deliver,
  markAllRead,
  PREFERENCES_CHANGED,
  readNotifications,
  type Notice,
} from './index.js';

const s = suite();

const names = new Map<string, string>();
const routes = createNotificationRoutes({
  actorNames: {
    user: (_trx, ids) => Promise.resolve(new Map([...names].filter(([id]) => ids.includes(id)))),
  },
});

// A UUIDv7 that names nothing, later than anything made in this run.
const laterThanAnything = () => `ffffffff-ffff-7${randomUUID().slice(15)}`;

/** Calls an endpoint as the server does: unparsed parameters, query and body. */
async function call(
  operationId: string,
  invocation: Invocation,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`No route for ${operationId}.`);
  // Awaited here, so a refusal while the input is parsed is a rejection like any other.
  return await route.run(
    { invocation, params: request.params ?? {}, query: request.query ?? {}, body: request.body },
    s.services,
  );
}

const list = async (who: Invocation, query: unknown = {}) =>
  notificationList.parse(await call('listNotifications', who, { query }));
const count = async (who: Invocation) =>
  unreadNotificationCount.parse(await call('getUnreadNotificationCount', who));
const read = async (who: Invocation, id: string) =>
  notification.parse(await call('markNotificationRead', who, { params: { id } }));
const readAll = async (who: Invocation, through: string) =>
  unreadNotificationCount.parse(await call('markAllNotificationsRead', who, { body: { through } }));
const preferences = async (who: Invocation) =>
  notificationPreferences.parse(await call('getNotificationPreferences', who));
const choose = async (who: Invocation, items: unknown) =>
  notificationPreferences.parse(
    await call('updateNotificationPreferences', who, { body: { items } }),
  );

const notice = (recipients: readonly string[], more: Partial<Notice> = {}): Notice => ({
  kind: 'ai.limit_reached',
  recipients,
  sourceKey: `test:${randomUUID()}`,
  cause: { kind: 'system', id: null },
  subject: { kind: 'ai_settings' },
  ...more,
});
const tell = (at: Place, told: Notice) =>
  withTenant(s.db, at.system, (trx) => deliver(trx, at.system, told));
/** Tells one person this many things, oldest first. */
async function tellMany(at: Place, person: Person, many: number): Promise<void> {
  for (let made = 0; made < many; made += 1) await tell(at, notice([person.id]));
}

/** A caller that is not a person acting themselves. */
const notAPerson = (at: Place): [string, Invocation][] => [
  [
    'an API key',
    { context: { ...at.system, actorKind: 'api_key', actorId: randomUUID() }, permissions: 'all' },
  ],
  ['the system', { context: at.system, permissions: 'all' }],
  [
    'an assistant carrying a person’s id',
    {
      context: { ...at.owner.context, actorKind: 'ai_agent', actorId: at.owner.id },
      permissions: 'all',
    },
  ],
  [
    'another actor carrying a person’s id',
    { context: { ...at.owner.context, actorId: randomUUID() }, permissions: 'all' },
  ],
];

describe('the routes', () => {
  it('are the six endpoints, and none of them runs a command or takes a permission', () => {
    expect(routes.map((route) => route.endpoint.operationId)).toEqual([
      'listNotifications',
      'getUnreadNotificationCount',
      'markNotificationRead',
      'markAllNotificationsRead',
      'getNotificationPreferences',
      'updateNotificationPreferences',
    ]);
    expect(routes.filter((route) => route.command !== undefined)).toEqual([]);
  });
});

describe('the list', () => {
  it('shows what a notification is about, who caused it and the record as it is now', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    names.set(at.owner.id, 'Sam Okoro');
    const { contactId, conversation, task } = await things(s, at);
    const conversationId = await conversation(dana.id);
    const taskId = await task({ assignee: dana.id });
    await tell(
      at,
      notice([dana.id], {
        kind: 'conversation.assigned',
        cause: { kind: 'user', id: at.owner.id },
        subject: { kind: 'conversation', id: conversationId },
        recordId: contactId,
      }),
    );
    await tell(
      at,
      notice([dana.id], {
        kind: 'task.due',
        subject: { kind: 'task', id: taskId },
        recordId: contactId,
        title: 'Call the venue back',
      }),
    );
    await tell(at, notice([dana.id]));

    const { items, nextCursor } = await list(dana.invocation);
    expect(nextCursor).toBeNull();
    const record = { id: toPublicId('contact', contactId), name: 'Jordan Lee', trashed: false };
    expect(items.map(({ id: _id, createdAt: _at, ...rest }) => rest)).toEqual([
      {
        kind: 'ai.limit_reached',
        target: { kind: 'ai_settings' },
        record: null,
        title: null,
        body: null,
        actor: { kind: 'system', name: null, you: false },
        readAt: null,
      },
      {
        kind: 'task.due',
        target: { kind: 'task', id: toPublicId('task', taskId) },
        record,
        title: 'Call the venue back',
        body: null,
        actor: { kind: 'system', name: null, you: false },
        readAt: null,
      },
      {
        kind: 'conversation.assigned',
        target: { kind: 'conversation', id: toPublicId('conversation', conversationId) },
        record,
        title: null,
        body: null,
        actor: { kind: 'user', name: 'Sam Okoro', you: false },
        readAt: null,
      },
    ]);
    const stored = (await toldIn(s, at)).map((row) => toPublicId('notification', row.id));
    expect(items.map((item) => item.id)).toEqual(stored.reverse());
  });

  it('reads the record live: renamed, in the trash, and with no name at all', async () => {
    const at = await place(s);
    const { contactId } = await things(s, at);
    const unnamed = await s.database.fixtures.contact(at.system, { email: 'who@example.com' });
    const custom = await s.database.withTenant(at.system, async (sql) => {
      // A custom object is made with its primary field (0128).
      const type = await sql.one<{ id: string; primary_field_id: string }>(
        `insert into crm.object_types
           (business_id, id, kind, key, singular_label, plural_label, primary_field_id)
         values ($1, uuidv7(), 'custom', 'venue', 'Venue', 'Venues', uuidv7())
         returning id, primary_field_id`,
        [at.businessId],
      );
      await sql.query(
        `insert into crm.field_definitions
           (business_id, id, object_type_id, key, label, value_type, created_by_kind)
         values ($1, $2, $3, 'name', 'Venue name', 'text', 'system')`,
        [at.businessId, type.primary_field_id, type.id],
      );
      const record = await sql.one<{ id: string }>(
        `insert into crm.records (business_id, kind, object_type_id) values ($1, 'custom', $2)
         returning id`,
        [at.businessId, type.id],
      );
      await sql.query(
        `insert into crm.custom_records (business_id, id, title, created_by_kind)
         values ($1, $2, 'The Old Mill', 'system')`,
        [at.businessId, record.id],
      );
      return record;
    });
    await tell(at, notice([at.owner.id], { recordId: contactId }));
    await tell(at, notice([at.owner.id], { recordId: unnamed.id }));
    await tell(at, notice([at.owner.id], { recordId: custom.id }));
    await s.database.as('crm_owner', async (sql) => {
      await sql.query(
        "update crm.contacts set first_name = 'Jo', last_name = 'Leigh', deleted_at = now() where id = $1",
        [contactId],
      );
      await sql.query('update crm.contacts set first_name = null, last_name = null where id = $1', [
        unnamed.id,
      ]);
    });
    const { items } = await list(at.owner.invocation);
    expect(items.map((item) => item.record)).toEqual([
      // A custom object's record, by its name.
      { id: toPublicId('custom', custom.id), name: 'The Old Mill', trashed: false },
      // No name is no name: never the address or the number.
      { id: toPublicId('contact', unnamed.id), name: null, trashed: false },
      { id: toPublicId('contact', contactId), name: 'Jo Leigh', trashed: true },
    ]);
    expect(JSON.stringify(items)).not.toContain('who@example.com');
  });

  it("names a company, a deal and a custom object's record by their own names", async () => {
    const at = await place(s);
    const ids = await s.database.withTenant(at.system, async (sql) => {
      const typeOf = async (kind: string) =>
        (
          await sql.one<{ id: string }>(
            'select id from crm.object_types where business_id = $1 and kind = $2',
            [at.businessId, kind],
          )
        ).id;
      const record = async (kind: string) =>
        (
          await sql.one<{ id: string }>(
            `insert into crm.records (business_id, kind, object_type_id) values ($1, $2, $3)
             returning id`,
            [at.businessId, kind, await typeOf(kind)],
          )
        ).id;
      const company = await record('company');
      await sql.query(
        "insert into crm.companies (business_id, id, name, created_by_kind) values ($1, $2, 'Lee Family', 'system')",
        [at.businessId, company],
      );
      const pipeline = await sql.one<{ id: string }>(
        "insert into crm.pipelines (business_id, name) values ($1, 'Weddings') returning id",
        [at.businessId],
      );
      const stage = await sql.one<{ id: string }>(
        `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
         values ($1, $2, 'New', 0) returning id`,
        [at.businessId, pipeline.id],
      );
      const deal = await record('deal');
      await sql.query(
        `insert into crm.deals (business_id, id, name, pipeline_id, stage_id, currency, created_by_kind)
         values ($1, $2, 'Lee wedding', $3, $4, 'USD', 'system')`,
        [at.businessId, deal, pipeline.id, stage.id],
      );
      // A custom object's record, named by its primary field, and in the trash.
      const pet = await sql.one<{ id: string }>(
        `insert into crm.object_types (business_id, id, kind, key, singular_label, plural_label,
                                       primary_field_id)
         values ($1, uuidv7(), 'custom', 'pet', 'Pet', 'Pets', uuidv7()) returning id`,
        [at.businessId],
      );
      await sql.query(
        `insert into crm.field_definitions (business_id, id, object_type_id, key, label,
                                            description, value_type, folder_id, created_by_kind)
         select $1, o.primary_field_id, o.id, 'pet_name', 'Pet name', 'Its name.', 'text', f.id,
                'system'
         from crm.object_types o join crm.field_folders f on f.object_type_id = o.id
         where o.id = $2 limit 1`,
        [at.businessId, pet.id],
      );
      const custom = (
        await sql.one<{ id: string }>(
          `insert into crm.records (business_id, kind, object_type_id) values ($1, 'custom', $2)
           returning id`,
          [at.businessId, pet.id],
        )
      ).id;
      await sql.query(
        `insert into crm.custom_records (business_id, id, object_type_id, title, deleted_at,
                                         created_by_kind)
         values ($1, $2, $3, 'Buddy', now(), 'system')`,
        [at.businessId, custom, pet.id],
      );
      return { company, deal, custom };
    });
    await tell(at, notice([at.owner.id], { recordId: ids.company }));
    await tell(at, notice([at.owner.id], { recordId: ids.deal }));
    await tell(at, notice([at.owner.id], { recordId: ids.custom }));
    expect((await list(at.owner.invocation)).items.map((item) => item.record)).toEqual([
      { id: toPublicId('custom', ids.custom), name: 'Buddy', trashed: true },
      { id: toPublicId('deal', ids.deal), name: 'Lee wedding', trashed: false },
      { id: toPublicId('company', ids.company), name: 'Lee Family', trashed: false },
    ]);
  });

  it('opens your own calendar connections for a calendar that was disconnected', async () => {
    const at = await place(s);
    await tell(
      at,
      notice([at.owner.id], {
        kind: 'calendar.google_disconnected',
        subject: { kind: 'calendar_connections' },
      }),
    );
    expect((await list(at.owner.invocation)).items).toMatchObject([
      { kind: 'calendar.google_disconnected', target: { kind: 'calendar_connections' } },
    ]);
  });

  it('pages newest first by a cursor, with nothing twice and nothing missed', async () => {
    const at = await place(s);
    await tellMany(at, at.owner, NOTIFICATION_PAGE_SIZE * 2 + 3);
    const everything = (await toldIn(s, at))
      .map((row) => toPublicId('notification', row.id))
      .reverse();

    const seen: string[] = [];
    let after: string | undefined;
    const sizes: number[] = [];
    do {
      const page = await list(at.owner.invocation, after === undefined ? {} : { after });
      sizes.push(page.items.length);
      seen.push(...page.items.map((item) => item.id));
      after = page.nextCursor ?? undefined;
    } while (after !== undefined);
    expect(sizes).toEqual([NOTIFICATION_PAGE_SIZE, NOTIFICATION_PAGE_SIZE, 3]);
    expect(seen).toEqual(everything);

    // A page that ends exactly at the last one says so.
    const exact = await place(s);
    await tellMany(exact, exact.owner, NOTIFICATION_PAGE_SIZE);
    expect((await list(exact.owner.invocation)).nextCursor).toBeNull();
  });

  it('shows only the unread ones when asked', async () => {
    const at = await place(s);
    await tellMany(at, at.owner, 3);
    const [newest, middle, oldest] = (await list(at.owner.invocation)).items;
    await read(at.owner.invocation, middle?.id ?? '');
    expect(
      (await list(at.owner.invocation, { state: 'unread' })).items.map((item) => item.id),
    ).toEqual([newest?.id, oldest?.id]);
    expect((await list(at.owner.invocation, { state: 'all' })).items).toHaveLength(3);
  });

  it('refuses a query it does not know, before reading anything', async () => {
    const at = await place(s);
    for (const query of [{ state: 'read' }, { userId: at.owner.id }, { after: 'not-an-id' }])
      await expect(list(at.owner.invocation, query)).rejects.toBeInstanceOf(ValidationError);
  });

  it('is the caller’s own: another member, the agency’s staff and an admin see none of it', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const admin = await at.join('admin');
    const staff = await at.join({ agency: 'owner' });
    await tellMany(at, dana, 2);
    const danas = (await list(dana.invocation)).items;
    expect(danas).toHaveLength(2);
    for (const other of [at.owner, admin, staff]) {
      expect(await list(other.invocation)).toEqual({ items: [], nextCursor: null });
      expect(await count(other.invocation)).toEqual({ unread: 0, more: false });
      // A cursor past everything, where Dana's would come next, shows nothing of hers.
      expect(
        (await list(other.invocation, { after: toPublicId('notification', laterThanAnything()) }))
          .items,
      ).toEqual([]);
    }
  });

  it('shows a person’s notifications of one business only where they work', async () => {
    const at = await place(s);
    const other = await s.database.fixtures.business(at.agencyId);
    const staff = await at.join({ agency: 'admin' });
    await tell(at, notice([staff.id]));
    const there: Invocation = {
      context: { ...staff.context, businessId: other.id },
      permissions: 'all',
    };
    const atTheAgency: Invocation = {
      context: { ...atAgency(at), userId: staff.id, actorKind: 'user', actorId: staff.id },
      permissions: 'all',
    };
    expect((await list(staff.invocation)).items).toHaveLength(1);
    expect((await list(there)).items).toEqual([]);
    expect((await list(atTheAgency)).items).toEqual([]);
    expect(await count(atTheAgency)).toEqual({ unread: 0, more: false });

    // What is about the agency as a whole is shown at the agency, and counted there.
    const agency = atAgency(at);
    await withTenant(s.db, agency, (trx) => deliver(trx, agency, notice([staff.id])));
    const [agencyWide] = (await list(atTheAgency)).items;
    expect(agencyWide).toMatchObject({ kind: 'ai.limit_reached', readAt: null });
    expect(await count(atTheAgency)).toEqual({ unread: 1, more: false });
    expect((await read(atTheAgency, agencyWide?.id ?? '')).readAt).not.toBeNull();
    expect(await count(staff.invocation)).toEqual({ unread: 1, more: false });
  });
});

describe('the unread count', () => {
  it('is how many are unread, up to the number the bell shows, and says when there are more', async () => {
    const at = await place(s);
    expect(await count(at.owner.invocation)).toEqual({ unread: 0, more: false });
    await tellMany(at, at.owner, 3);
    expect(await count(at.owner.invocation)).toEqual({ unread: 3, more: false });

    await s.database.withTenant(at.system, (sql) =>
      sql.query(
        `insert into notifications.notifications
           (agency_id, business_id, user_id, kind, source_key, actor_kind, subject_kind)
         select $1, $2, $3, 'ai.limit_reached', 'bulk:' || n, 'system', 'ai_settings'
         from generate_series(1, $4::int) n`,
        [at.agencyId, at.businessId, at.owner.id, UNREAD_NOTIFICATIONS_SHOWN - 3],
      ),
    );
    expect(await count(at.owner.invocation)).toEqual({
      unread: UNREAD_NOTIFICATIONS_SHOWN,
      more: false,
    });
    await tellMany(at, at.owner, 1);
    expect(await count(at.owner.invocation)).toEqual({
      unread: UNREAD_NOTIFICATIONS_SHOWN,
      more: true,
    });
  });

  it('stays right while notifications are written and read at the same time', async () => {
    const at = await place(s);
    await tellMany(at, at.owner, 4);
    const [newest] = (await list(at.owner.invocation)).items;
    // Marking everything read is held open inside its transaction while a new one is
    // written and committed. The new one was never shown, so it stays unread; and the
    // count read meanwhile sees only what is committed.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const marked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const marking = withTenant(s.db, at.owner.context, async (trx) => {
      const left = await markAllRead(trx, at.owner.invocation, newest?.id ?? '');
      reached();
      await held;
      return left;
    });
    await marked;
    expect(await count(at.owner.invocation)).toEqual({ unread: 4, more: false });
    await tell(at, notice([at.owner.id]));
    expect(await count(at.owner.invocation)).toEqual({ unread: 5, more: false });
    release();
    expect(await marking).toEqual({ unread: 0, more: false });
    expect(await count(at.owner.invocation)).toEqual({ unread: 1, more: false });
    const unread = await s.database.as('crm_owner', (sql) =>
      sql.query(
        'select 1 from notifications.notifications where user_id = $1 and read_at is null',
        [at.owner.id],
      ),
    );
    expect(unread).toHaveLength(1);
  });
});

describe('marking one read', () => {
  it('marks the caller’s own, keeps the first time, and brings the count down', async () => {
    const at = await place(s);
    await tellMany(at, at.owner, 2);
    const [newest] = (await list(at.owner.invocation)).items;
    const first = await read(at.owner.invocation, newest?.id ?? '');
    expect(first).toMatchObject({ id: newest?.id });
    expect(first.readAt).not.toBeNull();
    expect(await count(at.owner.invocation)).toEqual({ unread: 1, more: false });
    // Again: the same notification, read at the same moment as before.
    expect(await read(at.owner.invocation, newest?.id ?? '')).toEqual(first);
    expect(await count(at.owner.invocation)).toEqual({ unread: 1, more: false });
  });

  it('finds nobody else’s: another member’s, another business’s, and one that names nothing', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const admin = await at.join('admin');
    const elsewhere = await place(s);
    await tellMany(at, dana, 1);
    await tellMany(elsewhere, elsewhere.owner, 1);
    const [danas] = (await list(dana.invocation)).items;
    const [theirs] = (await list(elsewhere.owner.invocation)).items;

    const refusals: unknown[] = [];
    for (const [who, id] of [
      [at.owner, danas?.id],
      [admin, danas?.id],
      [dana, theirs?.id],
      [dana, toPublicId('notification', laterThanAnything())],
    ] as const)
      refusals.push(await read(who.invocation, id ?? '').catch((error: unknown) => error));
    for (const refusal of refusals) expect(refusal).toBeInstanceOf(NotFoundError);
    // The same words whether it is someone else's or names nothing.
    expect(
      new Set(
        refusals.map((refusal) =>
          refusal instanceof Error ? refusal.message.replace(/ntf_\w+/, 'ntf') : '',
        ),
      ).size,
    ).toBe(1);
    expect((await toldIn(s, at)).map((row) => row.read_at)).toEqual([null]);
    expect((await toldIn(s, elsewhere)).map((row) => row.read_at)).toEqual([null]);
  });

  it('refuses an id that is not a notification’s', async () => {
    const at = await place(s);
    await expect(
      read(at.owner.invocation, 'task_01h455vb4pex5vsknk084sn02q'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('is no longer possible once the person has left the business', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    await tellMany(at, dana, 1);
    const [hers] = (await list(dana.invocation)).items;
    await s.database.as('crm_owner', (sql) =>
      sql.query('delete from tenancy.memberships where user_id = $1', [dana.id]),
    );
    expect(await list(dana.invocation)).toEqual({ items: [], nextCursor: null });
    expect(await count(dana.invocation)).toEqual({ unread: 0, more: false });
    await expect(read(dana.invocation, hers?.id ?? '')).rejects.toBeInstanceOf(NotFoundError);
    expect((await toldIn(s, at)).map((row) => row.read_at)).toEqual([null]);
  });
});

describe('marking all read', () => {
  it('marks up to the one the person was shown, and leaves what arrived after it', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    await tellMany(at, at.owner, 3);
    await tellMany(at, dana, 1);
    const [shown] = (await list(at.owner.invocation)).items;
    await tellMany(at, at.owner, 2);

    expect(await readAll(at.owner.invocation, shown?.id ?? '')).toEqual({ unread: 2, more: false });
    const mine: Notification[] = (await list(at.owner.invocation)).items;
    expect(mine.map((item) => item.readAt !== null)).toEqual([false, false, true, true, true]);
    // Nobody else's was touched.
    expect(await count(dana.invocation)).toEqual({ unread: 1, more: false });
    // Again, and up to the newest: nothing left, and nothing breaks.
    expect(await readAll(at.owner.invocation, mine[0]?.id ?? '')).toEqual({
      unread: 0,
      more: false,
    });
    expect(await readAll(at.owner.invocation, mine[0]?.id ?? '')).toEqual({
      unread: 0,
      more: false,
    });
  });

  it('with someone else’s notification as the mark touches only the caller’s own', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    await tellMany(at, at.owner, 1);
    await tellMany(at, dana, 1);
    const [danas] = (await list(dana.invocation)).items;
    // Dana's is the newest of the two, so the owner's own one is up to it.
    expect(await readAll(at.owner.invocation, danas?.id ?? '')).toEqual({ unread: 0, more: false });
    expect(await count(dana.invocation)).toEqual({ unread: 1, more: false });
  });

  it('needs the notification the person was shown', async () => {
    const at = await place(s);
    await tellMany(at, at.owner, 1);
    for (const body of [{}, { through: 'con_01h455vb4pex5vsknk084sn02q' }, undefined])
      await expect(
        call('markAllNotificationsRead', at.owner.invocation, { body }),
      ).rejects.toBeInstanceOf(ValidationError);
    // Called directly with something that is no id, it marks nothing.
    expect(
      await withTenant(s.db, at.owner.context, (trx) =>
        markAllRead(trx, at.owner.invocation, 'not-an-id'),
      ),
    ).toEqual({ unread: 1, more: false });
  });
});

describe('preferences', () => {
  it('are every kind turned on until the person chooses', async () => {
    const at = await place(s);
    expect(await preferences(at.owner.invocation)).toEqual({
      items: notificationKinds.map((kind) =>
        kind === 'task.reminder'
          ? { kind, inApp: true, remindMinutes: null }
          : { kind, inApp: true },
      ),
    });
  });

  it('change only the kinds named, for the caller alone, and can be changed back', async () => {
    const at = await place(s);
    const dana = await at.join('member');
    const off = (saved: { items: { kind: string; inApp: boolean }[] }) =>
      saved.items.filter((item) => !item.inApp).map((item) => item.kind);

    expect(
      off(
        await choose(dana.invocation, [
          { kind: 'message.received_other', inApp: false },
          { kind: 'task.due', inApp: false },
        ]),
      ),
    ).toEqual(['message.received_other', 'task.due']);
    expect(off(await choose(dana.invocation, [{ kind: 'task.due', inApp: true }]))).toEqual([
      'message.received_other',
    ]);
    expect(off(await preferences(dana.invocation))).toEqual(['message.received_other']);
    expect(off(await preferences(at.owner.invocation))).toEqual([]);
  });

  it('are kept per business: the same person chooses apart in each', async () => {
    const at = await place(s);
    const other = await s.database.fixtures.business(at.agencyId);
    const staff = await at.join({ agency: 'admin' });
    const there: Invocation = {
      context: { ...staff.context, businessId: other.id },
      permissions: 'all',
    };
    await choose(staff.invocation, [{ kind: 'form.submitted', inApp: false }]);
    expect((await preferences(there)).items.every((item) => item.inApp)).toBe(true);
  });

  it('stop the kind from then on, and leave what the person already has', async () => {
    const at = await place(s);
    await tell(at, notice([at.owner.id]));
    await choose(at.owner.invocation, [{ kind: 'ai.limit_reached', inApp: false }]);
    expect(await tell(at, notice([at.owner.id]))).toEqual([]);
    expect((await list(at.owner.invocation)).items).toHaveLength(1);
    await choose(at.owner.invocation, [{ kind: 'ai.limit_reached', inApp: true }]);
    expect(await tell(at, notice([at.owner.id]))).toEqual([at.owner.id]);
  });

  it('are recorded in the audit log with who changed them, and what', async () => {
    const at = await place(s);
    const dana = await at.join('viewer');
    const items = [{ kind: 'task.assigned', inApp: false }];
    await call(
      'updateNotificationPreferences',
      { ...dana.invocation, ip: '203.0.113.7', userAgent: 'Dashboard' },
      { body: { items } },
    );
    await choose(dana.invocation, [{ kind: 'task.assigned', inApp: true }]);
    const audited = await s.database.as('crm_owner', (sql) =>
      sql.query(
        `select command, actor_kind, actor_id, outcome, input, host(ip) as ip, user_agent,
                correlation_id
         from audit.commands where business_id = $1 order by id`,
        [at.businessId],
      ),
    );
    expect(audited).toEqual([
      {
        command: PREFERENCES_CHANGED,
        actor_kind: 'user',
        actor_id: dana.id,
        outcome: 'ok',
        input: { items },
        ip: '203.0.113.7',
        user_agent: 'Dashboard',
        correlation_id: at.system.correlationId,
      },
      expect.objectContaining({
        command: 'notification_preferences.update',
        actor_id: dana.id,
        input: { items: [{ kind: 'task.assigned', inApp: true }] },
        ip: null,
        user_agent: null,
      }),
    ]);
  });

  it('refuse a change that names no kind, an unknown kind, a kind twice, or another person', async () => {
    const at = await place(s);
    for (const body of [
      { items: [] },
      { items: [{ kind: 'contact.created', inApp: false }] },
      {
        items: [
          { kind: 'task.due', inApp: false },
          { kind: 'task.due', inApp: true },
        ],
      },
      { userId: at.owner.id, items: [{ kind: 'task.due', inApp: false }] },
      undefined,
    ])
      await expect(
        call('updateNotificationPreferences', at.owner.invocation, { body }),
      ).rejects.toBeInstanceOf(ValidationError);
    const stored = await s.database.as('crm_owner', (sql) =>
      sql.query('select 1 from notifications.preferences where business_id = $1', [at.businessId]),
    );
    expect(stored).toEqual([]);
  });

  it('need a business: at the agency there is nothing to choose', async () => {
    const at = await place(s);
    const staff = await at.join({ agency: 'owner' });
    const atTheAgency: Invocation = {
      context: { ...atAgency(at), userId: staff.id, actorKind: 'user', actorId: staff.id },
      permissions: 'all',
    };
    await expect(preferences(atTheAgency)).rejects.toBeInstanceOf(ValidationError);
    await expect(choose(atTheAgency, [{ kind: 'task.due', inApp: false }])).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('every role', () => {
  it.each(['owner', 'admin', 'member', 'viewer'] as const)(
    'reads, marks and chooses as a %s, holding no permission at all',
    async (role) => {
      const at = await place(s);
      const person = await at.join(role);
      const who: Invocation = { context: person.context, permissions: new Set() };
      await tellMany(at, person, 2);
      const { items } = await list(who);
      expect(items).toHaveLength(2);
      expect(await count(who)).toEqual({ unread: 2, more: false });
      expect((await read(who, items[1]?.id ?? '')).readAt).not.toBeNull();
      expect(await readAll(who, items[0]?.id ?? '')).toEqual({ unread: 0, more: false });
      expect((await preferences(who)).items).toHaveLength(notificationKinds.length);
      const saved = await choose(who, [{ kind: 'task.due', inApp: false }]);
      expect(saved.items.find((item) => item.kind === 'task.due')).toEqual({
        kind: 'task.due',
        inApp: false,
      });
    },
  );
});

describe('a caller that is not a person', () => {
  it('has no notifications: every endpoint refuses it, and nothing is read or changed', async () => {
    const at = await place(s);
    await tellMany(at, at.owner, 1);
    const [mine] = (await list(at.owner.invocation)).items;
    for (const [name, who] of notAPerson(at)) {
      const attempts: (() => Promise<unknown>)[] = [
        () => list(who),
        () => count(who),
        () => read(who, mine?.id ?? ''),
        () => readAll(who, mine?.id ?? ''),
        () => preferences(who),
        () => choose(who, [{ kind: 'task.due', inApp: false }]),
        () =>
          withTenant(s.db, who.context, (trx) =>
            readNotifications(trx, who, { state: 'all' }, { actorNames: {} }),
          ),
      ];
      for (const attempt of attempts)
        await expect(attempt(), name).rejects.toEqual(
          new ForbiddenError('Only a signed-in person has notifications.'),
        );
    }
    expect(await count(at.owner.invocation)).toEqual({ unread: 1, more: false });
    expect((await preferences(at.owner.invocation)).items.every((item) => item.inApp)).toBe(true);
  });
});
