// Settings → Users, on real Postgres: the list, what the agency keeps about a person,
// adding by invitation and changing a person.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { userDetail, userList, type ListUsersQuery } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ForbiddenError, NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { inviteCommand, type TeamPeople } from '../team/team.js';
import { userRoutes } from './routes.js';
import { addUserCommand, readUser, readUsers, updateUserCommand } from './users.js';

let database: TestDatabase;
let db: Database;
let services: Services;
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

// Who people are, as the server would pass the auth module's lookup: here, read directly.
const people: TeamPeople = async (trx, ids) =>
  ids.length === 0
    ? new Map()
    : new Map(
        (
          await trx
            .selectFrom('auth.users')
            .select(['id', 'name', 'email'])
            .where('id', 'in', [...ids])
            .execute()
        ).map((row) => [row.id, { name: row.name, email: row.email }]),
      );
// The files module's check, standing in: these files are not there.
const missing = new Set<string>();
const checkAvatar = (_trx: unknown, _agency: string, fileId: string): Promise<void> =>
  missing.has(fileId) ? Promise.reject(new NotFoundError('File', fileId)) : Promise.resolve();
const addUser = addUserCommand(people, checkAvatar);
const updateUser = updateUserCommand(people, checkAvatar);

type Sql = Parameters<Parameters<TestDatabase['as']>[1]>[0];
const asSuper = <T>(run: (sql: Sql) => Promise<T>) => database.as('postgres', run);

/** An id no row has, of the kind the database makes. */
const unused = async (): Promise<string> =>
  (await asSuper((sql) => sql.one<{ id: string }>('select uuidv7() as id'))).id;

async function account(name: string): Promise<{ id: string; email: string }> {
  const email = `${randomUUID()}@example.test`;
  const { id } = await asSuper((sql) =>
    sql.one<{ id: string }>('insert into auth.users (email, name) values ($1, $2) returning id', [
      email,
      name,
    ]),
  );
  return { id, email };
}

/** An agency with its roles, one business, and Dana, who manages the business's team. */
async function scene() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const roles = await asSuper((sql) =>
    sql.query<{ id: string; key: string; scope: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, is_builtin) values
         ($1, 'business', 'owner', 'Owner', true), ($1, 'business', 'admin', 'Admin', true),
         ($1, 'business', 'member', 'Member', true), ($1, 'agency', 'admin', 'Admin', true)
       returning id, key, scope`,
      [agency.id],
    ),
  );
  const stored = (scope: string, key: string) => {
    const found = roles.find((each) => each.scope === scope && each.key === key);
    if (found === undefined) throw new Error('No such role.');
    return found.id;
  };
  const role = (key: string, scope = 'business') => toPublicId('role', stored(scope, key));
  const join = async (
    name: string,
    key: string,
    where: 'business' | 'agency' = 'business',
  ): Promise<{ id: string; email: string; membership: string }> => {
    const person = await account(name);
    const { id } = await asSuper((sql) =>
      sql.one<{ id: string }>(
        `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
         values ($1, $2, $3, $4) returning id`,
        [person.id, agency.id, where === 'business' ? business.id : null, stored(where, key)],
      ),
    );
    return { ...person, membership: toPublicId('membership', id) };
  };
  const dana = await join('Dana Brooks', 'admin');
  const as = (userId: string, manage = true): Invocation => ({
    context: {
      agencyId: agency.id,
      businessId: business.id,
      userId,
      actorId: userId,
      actorKind: 'user',
      correlationId: randomUUID(),
    },
    permissions: new Set(manage ? (['team.manage'] as const) : []),
  });
  const list = (query: Partial<ListUsersQuery> = {}, invocation = as(dana.id)) =>
    readUsers(services, invocation, people, { limit: 20, ...query });
  return { agency, business, role, join, dana, as, list };
}

const ada = (roleId: string, email = `${randomUUID()}@example.test`) => ({
  firstName: 'Ada',
  lastName: 'Lovelace',
  email,
  roleId,
});

it("lists the business's people, the agency's own team and the invited, by name, with what the caller may do", async () => {
  const s = await scene();
  const owner = await s.join('Olive Owner', 'owner');
  const member = await s.join('Mia Member', 'member');
  const staff = await s.join('Zed Agency', 'admin', 'agency');
  await runCommand(services, addUser, ada(s.role('member')), s.as(s.dana.id));

  const found = await s.list();
  expect(() => userList.parse(found)).not.toThrow();
  expect(found.total).toBe(5);
  expect(found.next).toBeNull();
  expect(found.canManage).toBe(true);
  expect(found.roles.map((each) => each.key).toSorted()).toEqual(['admin', 'member', 'owner']);
  expect(found.items.map((each) => [each.name, each.userType, each.roleName, each.status])).toEqual(
    [
      ['Ada Lovelace', 'account', 'Member', 'invited'],
      ['Dana Brooks', 'account', 'Admin', 'active'],
      ['Mia Member', 'account', 'Member', 'active'],
      ['Olive Owner', 'account', 'Owner', 'active'],
      ['Zed Agency', 'agency', 'Admin', 'active'],
    ],
  );
  const flags = Object.fromEntries(
    found.items.map((each) => [each.name, [each.isSelf, each.canEdit, each.canRemove]]),
  );
  expect(flags).toEqual({
    // An invitation is revoked, not edited.
    'Ada Lovelace': [false, false, true],
    // Oneself: details, yes; removal, no.
    'Dana Brooks': [true, true, false],
    'Mia Member': [false, true, true],
    // An owner is changed by an owner, and never removed here.
    'Olive Owner': [false, false, false],
    // The agency's own team is managed at the agency.
    'Zed Agency': [false, false, false],
  });
  expect(found.items.find((each) => each.name === 'Mia Member')).toMatchObject({
    id: member.membership,
    membershipId: member.membership,
    invitationId: null,
    firstName: 'Mia',
    lastName: 'Member',
    email: member.email,
    phone: null,
    extension: null,
    avatarFileId: null,
    isOwner: false,
  });
  expect(owner.membership).not.toBe(staff.membership);

  // Someone who may not manage the team sees the list and can change nothing.
  const viewing = await s.list({}, s.as(member.id, false));
  expect(viewing.canManage).toBe(false);
  expect(viewing.items.every((each) => !each.canEdit && !each.canRemove)).toBe(true);
});

it('finds people by name, email, phone or id, filters by role and type, and pages', async () => {
  const s = await scene();
  const mia = await s.join('Mia Member', 'member');
  const noor = await s.join('Noor Haddad', 'member');
  await s.join('Zed Agency', 'admin', 'agency');
  await runCommand(
    services,
    updateUser,
    {
      userId: noor.membership,
      details: {
        firstName: 'Noor',
        lastName: 'Haddad',
        roleId: s.role('member'),
        phone: '+254712345678',
        extension: null,
        avatarFileId: null,
        calendarId: null,
        signature: { enabled: false, document: null },
      },
    },
    s.as(s.dana.id),
  );
  const names = async (query: Partial<ListUsersQuery>) =>
    (await s.list(query)).items.map((each) => each.name);

  expect(await names({ q: 'mia' })).toEqual(['Mia Member']);
  expect(await names({ q: mia.email.slice(0, 13).toUpperCase() })).toEqual(['Mia Member']);
  expect(await names({ q: '0712 345' })).toEqual([]);
  expect(await names({ q: '712 345 678' })).toEqual(['Noor Haddad']);
  expect(await names({ q: noor.membership })).toEqual(['Noor Haddad']);
  expect(await names({ q: 'nobody at all' })).toEqual([]);
  expect(await names({ role: s.role('member') })).toEqual(['Mia Member', 'Noor Haddad']);
  expect(await names({ type: 'agency' })).toEqual(['Zed Agency']);
  expect(await names({ type: 'account', q: 'a' })).toEqual([
    'Dana Brooks',
    'Mia Member',
    'Noor Haddad',
  ]);

  const first = await s.list({ limit: 2 });
  expect(first.items.map((each) => each.name)).toEqual(['Dana Brooks', 'Mia Member']);
  expect(first.total).toBe(4);
  const second = await s.list({ limit: 2, after: first.next ?? '' });
  expect(second.items.map((each) => each.name)).toEqual(['Noor Haddad', 'Zed Agency']);
  expect(second.next).toBeNull();
});

it('adds a person as an invitation that carries their details, which become their profile when accepted', async () => {
  const s = await scene();
  const { id: calendarId } = await asSuper((sql) =>
    sql.one<{ id: string }>(
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug, is_active)
       values ($1, 'Consultations', 'personal', 'UTC', $2, true) returning id`,
      [s.business.id, `c-${randomUUID()}`],
    ),
  );
  const signature = {
    type: 'doc' as const,
    content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Ada' }] }],
  };
  const added = await runCommand(
    services,
    addUser,
    {
      ...ada(s.role('admin'), 'ada@example.test'),
      email: `ada-${randomUUID()}@example.test`,
      phone: '+13055550123',
      extension: '204',
      calendarId: toPublicId('calendar', calendarId),
      signature: { enabled: true, document: signature },
    },
    s.as(s.dana.id),
  );
  expect(added.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(() => userDetail.parse(added.user)).not.toThrow();
  expect(added.user).toMatchObject({
    status: 'invited',
    membershipId: null,
    name: 'Ada Lovelace',
    phone: '+13055550123',
    extension: '204',
    roleKey: 'admin',
    calendarId: toPublicId('calendar', calendarId),
    signature: { enabled: true, document: signature },
    canEdit: false,
    canRemove: true,
  });

  // Accepting, as the sign-in service does it: the account, the membership, then the profile.
  const accepted = await database.as('crm_auth', async (sql) => {
    const user = await sql.one<{ id: string }>(
      `insert into auth.users (email, name, email_verified) values ($1, 'A. L.', true) returning id`,
      [added.user.email],
    );
    const invitation = await sql.one<{ id: string; role_id: string }>(
      'select id, role_id from tenancy.invitations where email = $1',
      [added.user.email],
    );
    await sql.query(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       values ($1, $2, $3, $4)`,
      [user.id, s.agency.id, s.business.id, invitation.role_id],
    );
    await sql.query('select private.apply_invitation_profile($1, $2)', [invitation.id, user.id]);
    await sql.query('update tenancy.invitations set accepted_at = now() where id = $1', [
      invitation.id,
    ]);
    return user;
  });
  const joined = (await s.list({ q: 'lovelace' })).items;
  expect(joined).toHaveLength(1);
  const [person] = joined;
  expect(person).toMatchObject({
    status: 'active',
    invitationId: null,
    // The name the agency wrote, not the one the person typed when accepting.
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '+13055550123',
    extension: '204',
    roleKey: 'admin',
  });
  expect(await readUser(services, s.as(s.dana.id), people, person?.id ?? '')).toMatchObject({
    calendarId: toPublicId('calendar', calendarId),
    signature: { enabled: true, document: signature },
  });
  expect(accepted.id).toMatch(/^[0-9a-f-]{36}$/);
});

it('refuses to add someone already on the team, with a calendar of another business, or with a file that is no picture', async () => {
  const s = await scene();
  const elsewhere = await database.fixtures.business(s.agency.id);
  const { id: theirs } = await asSuper((sql) =>
    sql.one<{ id: string }>(
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug, is_active)
       values ($1, 'Theirs', 'personal', 'UTC', $2, true) returning id`,
      [elsewhere.id, `c-${randomUUID()}`],
    ),
  );
  const invoke = s.as(s.dana.id);
  const gone = toPublicId('file', await unused());
  missing.add(gone);
  await expect(
    runCommand(services, addUser, ada(s.role('member'), s.dana.email), invoke),
  ).rejects.toThrow(/already on the team/);
  await expect(
    runCommand(
      services,
      addUser,
      { ...ada(s.role('member')), calendarId: toPublicId('calendar', theirs) },
      invoke,
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    runCommand(services, addUser, { ...ada(s.role('member')), avatarFileId: gone }, invoke),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(runCommand(services, addUser, ada(s.role('owner')), invoke)).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  await expect(
    runCommand(services, addUser, ada(s.role('admin', 'agency')), invoke),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    runCommand(services, addUser, ada(s.role('member')), s.as(s.dana.id, false)),
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect((await s.list()).total).toBe(1);
});

it("changes a person's details, role and signature, and tells of it", async () => {
  const s = await scene();
  const mia = await s.join('Mia Member', 'member');
  const signature = {
    type: 'doc' as const,
    content: [
      { type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Mia, Events' }] },
    ],
  };
  const saved = await runCommand(
    services,
    updateUser,
    {
      userId: mia.membership,
      details: {
        firstName: 'Maria',
        lastName: 'Member-Okoye',
        roleId: s.role('admin'),
        phone: '+254712345678',
        extension: '12',
        avatarFileId: null,
        calendarId: null,
        signature: { enabled: true, document: signature },
      },
    },
    s.as(s.dana.id),
  );
  expect(() => userDetail.parse(saved)).not.toThrow();
  expect(saved).toMatchObject({
    id: mia.membership,
    name: 'Maria Member-Okoye',
    firstName: 'Maria',
    lastName: 'Member-Okoye',
    email: mia.email,
    phone: '+254712345678',
    extension: '12',
    roleKey: 'admin',
    signature: { enabled: true, document: signature },
  });
  // The account itself is untouched: the name is the agency's.
  expect(
    await asSuper((sql) => sql.query('select name from auth.users where id = $1', [mia.id])),
  ).toEqual([{ name: 'Mia Member' }]);
  expect(
    await asSuper((sql) =>
      sql.query<{ type: string; payload: unknown }>(
        `select type, payload from events.events where business_id = $1 and type = 'team.user_updated'`,
        [s.business.id],
      ),
    ),
  ).toMatchObject([{ type: 'team.user_updated', payload: { userId: mia.id } }]);

  // Saved again with the signature taken away and no phone.
  const cleared = await runCommand(
    services,
    updateUser,
    {
      userId: mia.membership,
      details: {
        firstName: 'Maria',
        lastName: 'Member-Okoye',
        roleId: s.role('admin'),
        phone: null,
        extension: null,
        avatarFileId: null,
        calendarId: null,
        signature: { enabled: false, document: null },
      },
    },
    s.as(s.dana.id),
  );
  expect(cleared).toMatchObject({
    phone: null,
    extension: null,
    signature: { enabled: false, document: null },
  });
});

it('refuses changes that are not this workspace’s to make', async () => {
  const s = await scene();
  const owner = await s.join('Olive Owner', 'owner');
  const mia = await s.join('Mia Member', 'member');
  const staff = await s.join('Zed Agency', 'admin', 'agency');
  const change = (userId: string, roleKey: string, invocation = s.as(s.dana.id)) =>
    runCommand(
      services,
      updateUser,
      {
        userId,
        details: {
          firstName: 'Any',
          lastName: 'Name',
          roleId: s.role(roleKey),
          phone: null,
          extension: null,
          avatarFileId: null,
          calendarId: null,
          signature: { enabled: false, document: null },
        },
      },
      invocation,
    );
  // The agency's own team, seen from a business.
  await expect(change(staff.membership, 'member')).rejects.toThrow(/agency's team/);
  // An owner, by someone who is not one.
  await expect(change(owner.membership, 'owner')).rejects.toBeInstanceOf(ForbiddenError);
  // Ownership given, and one's own role.
  await expect(change(mia.membership, 'owner')).rejects.toThrow(/Ownership/);
  await expect(change(s.dana.membership, 'member')).rejects.toThrow(/your own role/);
  // Without the permission, and someone who is not there.
  await expect(change(mia.membership, 'admin', s.as(mia.id, false))).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  await expect(change(toPublicId('membership', await unused()), 'member')).rejects.toBeInstanceOf(
    NotFoundError,
  );
  // An owner changes their own details, and another owner's.
  await expect(change(owner.membership, 'owner', s.as(owner.id))).resolves.toMatchObject({
    name: 'Any Name',
    roleKey: 'owner',
  });
  expect((await s.list({ q: 'mia' })).items).toMatchObject([{ roleKey: 'member' }]);
});

it("keeps each agency's own details of a person who belongs to two", async () => {
  const first = await scene();
  const second = await scene();
  const shared = await first.join('Sam Shared', 'member');
  const { id } = await asSuper((sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       select $1, $2, $3, id from tenancy.roles
       where agency_id = $2 and scope = 'business' and key = 'member'
       returning id`,
      [shared.id, second.agency.id, second.business.id],
    ),
  );
  await runCommand(
    services,
    updateUser,
    {
      userId: shared.membership,
      details: {
        firstName: 'Samuel',
        lastName: 'First',
        roleId: first.role('member'),
        phone: '+13055550123',
        extension: null,
        avatarFileId: null,
        calendarId: null,
        signature: { enabled: false, document: null },
      },
    },
    first.as(first.dana.id),
  );
  expect((await first.list({ q: 'sam' })).items).toMatchObject([
    { name: 'Samuel First', phone: '+13055550123' },
  ]);
  expect((await second.list({ q: 'sam' })).items).toMatchObject([
    { id: toPublicId('membership', id), name: 'Sam Shared', phone: null },
  ]);
});

it('serves the routes, and says when the invitation email could not be sent', async () => {
  const s = await scene();
  const run = (
    routes: ReturnType<typeof userRoutes>,
    operationId: string,
    input: { body?: unknown; params?: unknown; query?: unknown } = {},
  ) => {
    const route = routes.find((each) => each.endpoint.operationId === operationId);
    if (route === undefined) throw new Error('Missing users route.');
    return route.run(
      {
        invocation: s.as(s.dana.id),
        body: input.body,
        params: input.params ?? {},
        query: input.query ?? {},
      },
      services,
    );
  };
  const sent: string[] = [];
  const routes = userRoutes({
    people,
    checkAvatar,
    sendInvitation: (email) => {
      sent.push(email);
      return Promise.resolve(false);
    },
  });
  const added = userDetail.parse(
    await run(routes, 'addUser', { body: ada(s.role('member'), 'ada.routes@example.test') }),
  );
  expect(added).toMatchObject({ status: 'invited', deliveryFailed: true });
  expect(JSON.stringify(added)).not.toMatch(/token/i);
  expect(sent).toEqual(['ada.routes@example.test']);
  expect(
    userList.parse(await run(routes, 'listUsers', { query: { q: 'dana', limit: '5' } })).items,
  ).toHaveLength(1);
  const read = userDetail.parse(
    await run(routes, 'getUser', { params: { userId: s.dana.membership } }),
  );
  expect(read.isSelf).toBe(true);
  expect(
    userDetail.parse(
      await run(routes, 'updateUser', {
        params: { userId: s.dana.membership },
        body: { firstName: 'Dana', lastName: 'Brooks-Lee', roleId: read.roleId },
      }),
    ).name,
  ).toBe('Dana Brooks-Lee');
  // No email delivery configured: nobody can be added, and nothing is written.
  const silent = userRoutes({ people, checkAvatar, sendInvitation: undefined });
  await expect(run(silent, 'addUser', { body: ada(s.role('member')) })).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  expect((await s.list()).total).toBe(2);
});

/** The agency's own workspace, where no business is chosen. */
const atAgency = (agencyId: string, userId: string): Invocation => ({
  context: {
    agencyId,
    userId,
    actorId: userId,
    actorKind: 'user',
    correlationId: randomUUID(),
  },
  permissions: new Set(['team.manage'] as const),
});

/** A whole set of details with nothing optional filled in. */
const plain = (firstName: string, lastName: string, roleId: string) => ({
  firstName,
  lastName,
  roleId,
  phone: null,
  extension: null,
  avatarFileId: null,
  calendarId: null,
  signature: { enabled: false, document: null },
});

const calendarIn = async (businessId: string, name: string): Promise<string> => {
  const { id } = await asSuper((sql) =>
    sql.one<{ id: string }>(
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug, is_active)
       values ($1, $2, 'personal', 'UTC', $3, true) returning id`,
      [businessId, name, `c-${randomUUID()}`],
    ),
  );
  return toPublicId('calendar', id);
};

/** An uploaded picture of the agency, as the files module would have stored it. */
async function picture(agencyId: string): Promise<string> {
  const { id } = await asSuper((sql) =>
    sql.one<{ id: string }>(
      `insert into files.files
         (agency_id, storage, storage_key, filename, content_type, size_bytes, sha256, uploaded_by_kind)
       values ($1, 'local', $2, 'face.png', 'image/png', 10, sha256('face'::bytea), 'user')
       returning id`,
      [agencyId, `test/${randomUUID()}`],
    ),
  );
  return toPublicId('file', id);
}

it("lists only the agency's own team at the agency, where nobody has a default calendar", async () => {
  const s = await scene();
  const calendarId = await calendarIn(s.business.id, 'Consultations');
  const stranger = atAgency(s.agency.id, s.dana.id);

  // Nobody is on the agency's own team yet: the business's people are not the agency's.
  const empty = await readUsers(services, stranger, people, { limit: 20 });
  expect(empty.items).toEqual([]);
  expect(empty.total).toBe(0);
  expect(empty.next).toBeNull();
  expect(empty.roles.map((each) => each.key)).toEqual(['admin']);

  const zed = await s.join('Zed Agency', 'admin', 'agency');
  const invoke = atAgency(s.agency.id, zed.id);
  const added = await runCommand(services, addUser, ada(s.role('admin', 'agency')), invoke);
  expect(added.user).toMatchObject({ status: 'invited', userType: 'agency', calendarId: null });

  const found = await readUsers(services, invoke, people, { limit: 20 });
  expect(
    found.items.map((each) => [
      each.name,
      each.userType,
      each.status,
      each.canEdit,
      each.canRemove,
    ]),
  ).toEqual([
    ['Ada Lovelace', 'agency', 'invited', false, true],
    ['Zed Agency', 'agency', 'active', true, false],
  ]);

  // A default calendar is a business's: at the agency it is refused, for a new person and
  // for one already there.
  const refusal = {
    issues: [
      {
        path: '/calendarId',
        code: 'unknown_calendar',
        message: 'A default calendar belongs to a business. Set it in the business.',
      },
    ],
  };
  await expect(
    runCommand(services, addUser, { ...ada(s.role('admin', 'agency')), calendarId }, invoke),
  ).rejects.toMatchObject(refusal);
  await expect(
    runCommand(
      services,
      updateUser,
      {
        userId: zed.membership,
        details: { ...plain('Zed', 'Agency', s.role('admin', 'agency')), calendarId },
      },
      invoke,
    ),
  ).rejects.toMatchObject(refusal);
  // Inside a business, a calendar of another business is refused in the business's words.
  const elsewhere = await database.fixtures.business(s.agency.id);
  await expect(
    runCommand(
      services,
      addUser,
      { ...ada(s.role('member')), calendarId: await calendarIn(elsewhere.id, 'Theirs') },
      s.as(s.dana.id),
    ),
  ).rejects.toMatchObject({
    issues: [
      {
        path: '/calendarId',
        code: 'unknown_calendar',
        message: 'Choose one of this business’s calendars.',
      },
    ],
  });

  // The agency changes its own team's details, and does not reach into a business's.
  await expect(
    runCommand(
      services,
      updateUser,
      { userId: zed.membership, details: plain('Zedekiah', 'Agency', s.role('admin', 'agency')) },
      invoke,
    ),
  ).resolves.toMatchObject({ name: 'Zedekiah Agency', userType: 'agency', calendarId: null });
  await expect(
    runCommand(
      services,
      updateUser,
      { userId: s.dana.membership, details: plain('Dana', 'Brooks', s.role('admin', 'agency')) },
      invoke,
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(readUser(services, invoke, people, s.dana.membership)).rejects.toBeInstanceOf(
    NotFoundError,
  );
});

it('names a person from their account until the agency writes a name, and lists one whose account is unknown', async () => {
  const s = await scene();
  const cher = await s.join('Cher', 'member');
  const mary = await s.join('  Mary Jane Watson ', 'member');
  const blank = await s.join('', 'member');
  const byId = Object.fromEntries((await s.list()).items.map((each) => [each.id, each]));

  // One word is a first name; of several, the last word is the last name.
  expect(byId[cher.membership]).toMatchObject({ name: 'Cher', firstName: 'Cher', lastName: '' });
  expect(byId[mary.membership]).toMatchObject({
    name: 'Mary Jane Watson',
    firstName: 'Mary Jane',
    lastName: 'Watson',
  });
  // No name anywhere: the email address stands in for it.
  expect(byId[blank.membership]).toMatchObject({
    name: blank.email,
    firstName: '',
    lastName: '',
    email: blank.email,
  });

  // The sign-in service knows none of them: they are still members, and still listed.
  const nobody: TeamPeople = () => Promise.resolve(new Map());
  const unknown = await readUsers(services, s.as(s.dana.id), nobody, { limit: 20 });
  expect(unknown.total).toBe(4);
  expect(
    unknown.items.map((each) => [each.name, each.email, each.firstName, each.lastName]),
  ).toEqual(Array.from({ length: 4 }, () => ['Unknown person', '', '', '']));
  expect(unknown.items.find((each) => each.id === s.dana.membership)).toMatchObject({
    isSelf: true,
    status: 'active',
    roleKey: 'admin',
  });
});

it('orders people with the same name by id, ignores capitals, and pages through them without loss', async () => {
  const s = await scene();
  const first = await s.join('Sam Twin', 'member');
  const second = await s.join('Sam Twin', 'member');
  const lower = await s.join('adam zed', 'member');
  const expected = [lower.membership, s.dana.membership, first.membership, second.membership];
  expect(first.membership < second.membership).toBe(true);
  expect((await s.list()).items.map((each) => each.id)).toEqual(expected);

  const seen: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 4; page += 1) {
    const found = await s.list(after === undefined ? { limit: 1 } : { limit: 1, after });
    expect(found.total).toBe(4);
    expect(found.items).toHaveLength(1);
    seen.push(...found.items.map((each) => each.id));
    expect(found.next === null).toBe(page === 3);
    after = found.next ?? undefined;
  }
  expect(seen).toEqual(expected);

  // A cursor that names nobody on the list starts from the top.
  const restarted = await s.list({ limit: 2, after: 'bm9ib2R5' });
  expect(restarted.items.map((each) => each.id)).toEqual(expected.slice(0, 2));
  // A page as large as the list has no next.
  expect((await s.list({ limit: 4 })).next).toBeNull();
});

it('lists a bare invitation under its email address, and says when an invitation has expired', async () => {
  const s = await scene();
  const invoke = s.as(s.dana.id);
  const email = `bare-${randomUUID()}@example.test`;
  await runCommand(services, inviteCommand(people), { email, roleId: s.role('member') }, invoke);
  const late = await runCommand(services, addUser, ada(s.role('admin')), invoke);
  await asSuper((sql) =>
    sql.query(
      `update tenancy.invitations set expires_at = now() - interval '1 minute' where email = $1`,
      [late.user.email],
    ),
  );
  // Details that cannot be read, written by something other than this module.
  const odd = `odd-${randomUUID()}@example.test`;
  await runCommand(
    services,
    inviteCommand(people),
    { email: odd, roleId: s.role('member') },
    invoke,
  );
  await asSuper((sql) =>
    sql.query(
      `update tenancy.invitations set profile = '{"firstName": 7, "signatureEnabled": "yes"}'
       where email = $1`,
      [odd],
    ),
  );

  const found = await s.list();
  expect(() => userList.parse(found)).not.toThrow();
  const byEmail = Object.fromEntries(found.items.map((each) => [each.email, each]));
  expect(byEmail[email]).toMatchObject({
    status: 'invited',
    name: email,
    firstName: '',
    lastName: '',
    phone: null,
    extension: null,
    avatarFileId: null,
    membershipId: null,
    userType: 'account',
    roleKey: 'member',
    isSelf: false,
    isOwner: false,
    canEdit: false,
    canRemove: true,
  });
  expect(byEmail[odd]).toMatchObject({ status: 'invited', name: odd, firstName: '' });
  expect(byEmail[late.user.email]).toMatchObject({
    status: 'invitation_expired',
    name: 'Ada Lovelace',
    roleKey: 'admin',
    canEdit: false,
    canRemove: true,
  });
  // Someone who may not manage the team cannot withdraw an invitation.
  const viewing = await s.list({}, s.as(s.dana.id, false));
  expect(viewing.items.find((each) => each.email === email)).toMatchObject({ canRemove: false });

  // An invited person is not yet a user to read or to change: the invitation is revoked
  // and sent again instead. Nor is an id that is no id at all.
  const invitationId = byEmail[email]?.id ?? '';
  expect(invitationId).toBe(byEmail[email]?.invitationId);
  await expect(readUser(services, invoke, people, invitationId)).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(
    runCommand(
      services,
      updateUser,
      { userId: invitationId, details: plain('Bare', 'Invite', s.role('member')) },
      invoke,
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    runCommand(
      services,
      updateUser,
      { userId: 'not an id', details: plain('No', 'One', s.role('member')) },
      invoke,
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it("keeps a person's picture, checks a new one, and does not check again the one they already have", async () => {
  const s = await scene();
  const invoke = s.as(s.dana.id);
  const mia = await s.join('Mia Member', 'member');
  const face = await picture(s.agency.id);
  const other = await picture(s.agency.id);
  const save = (avatarFileId: string | null) =>
    runCommand(
      services,
      updateUser,
      {
        userId: mia.membership,
        details: { ...plain('Mia', 'Member', s.role('member')), avatarFileId },
      },
      invoke,
    );

  expect(await save(face)).toMatchObject({ avatarFileId: face });
  expect((await s.list({ q: 'mia' })).items).toMatchObject([{ avatarFileId: face }]);

  // The files module would now refuse both files. The picture already kept is saved again
  // untouched; a different one is checked and refused, and the first stays.
  missing.add(face);
  missing.add(other);
  expect(await save(face)).toMatchObject({ avatarFileId: face });
  await expect(save(other)).rejects.toBeInstanceOf(NotFoundError);
  expect(await readUser(services, invoke, people, mia.membership)).toMatchObject({
    avatarFileId: face,
  });
  // Taking the picture away needs no file at all.
  expect(await save(null)).toMatchObject({ avatarFileId: null });

  // An invitation carries the picture chosen for the person.
  const portrait = await picture(s.agency.id);
  const added = await runCommand(
    services,
    addUser,
    { ...ada(s.role('member')), avatarFileId: portrait },
    invoke,
  );
  expect(added.user).toMatchObject({ status: 'invited', avatarFileId: portrait });
  expect((await s.list({ q: 'lovelace' })).items).toMatchObject([{ avatarFileId: portrait }]);
});
