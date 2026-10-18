import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  agencyMarketplaceApp,
  agencyMarketplaceAppList,
  installedMarketplaceAppList,
  marketplaceAppDetail,
  marketplaceAppList,
  marketplaceInstall,
  type Permission,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { marketplaceRoutes } from '../index.js';

let database: TestDatabase;
let db: Database;
let services: Services;

// The names the server would look up in the auth module; here, the ones a test gives.
const people = new Map<string, string>();
const routes = marketplaceRoutes({
  people: (_trx, ids) =>
    Promise.resolve(
      new Map(ids.flatMap((id) => (people.has(id) ? [[id, people.get(id) ?? '']] : []))),
    ),
});

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

function route(operationId: string) {
  const found = routes.find((each) => each.endpoint.operationId === operationId);
  if (found === undefined) throw new Error(`No route for ${operationId}.`);
  return found;
}

const call = (
  operationId: string,
  invocation: Invocation,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
) =>
  route(operationId).run(
    {
      invocation,
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body,
    },
    services,
  );

/** A named person acting where the context works, with these permissions. */
async function person(
  where: TenantContext,
  permissions: Iterable<Permission> | 'all',
  name: string | null = 'Dana Brooks',
): Promise<Invocation> {
  const user = await database.fixtures.user();
  if (name !== null) people.set(user.id, name);
  return {
    context: {
      ...where,
      userId: user.id,
      actorKind: 'user',
      actorId: user.id,
      correlationId: randomUUID(),
    },
    permissions: permissions === 'all' ? 'all' : new Set(permissions),
  };
}

/** An agency with two businesses, and its staff who may publish apps. */
async function agencyWithTwoBusinesses() {
  const agency = await database.fixtures.agency();
  const one = await database.fixtures.business(agency.id);
  const two = await database.fixtures.business(agency.id);
  const atAgency: TenantContext = {
    agencyId: agency.id,
    actorKind: 'system',
    correlationId: randomUUID(),
  };
  const publisher = await person(atAgency, ['apps.manage']);
  return { agency, one, two, atAgency, publisher };
}

const appBody = {
  name: 'Booking Sync',
  tagline: 'Keeps bookings in step',
  description: 'Copies every booking to your other calendar.',
  developer: 'Harbor Labs',
  websiteUrl: 'https://harbor.example',
  supportEmail: 'help@harbor.example',
  iconUrl: null,
  categories: ['calendars', 'productivity'],
  scopes: ['tags.manage'],
};

const createApp = async (publisher: Invocation, body: Record<string, unknown> = appBody) =>
  agencyMarketplaceApp.parse(await call('createMarketplaceApp', publisher, { body }));

const updateApp = async (publisher: Invocation, appId: string, body: Record<string, unknown>) =>
  agencyMarketplaceApp.parse(
    await call('updateMarketplaceApp', publisher, { params: { appId }, body }),
  );

/** A new app of the agency, listed, asking for these scopes. */
async function listedApp(
  publisher: Invocation,
  values: Record<string, unknown> = {},
): Promise<string> {
  const made = await createApp(publisher, { ...appBody, ...values });
  await updateApp(publisher, made.id, { ...appBody, ...values, status: 'listed' });
  return made.id;
}

const agencyApps = async (publisher: Invocation) =>
  agencyMarketplaceAppList.parse(await call('listAgencyMarketplaceApps', publisher)).items;

const browse = async (invocation: Invocation, query: Record<string, unknown> = {}) =>
  marketplaceAppList.parse(await call('listMarketplaceApps', invocation, { query }));

const detail = async (invocation: Invocation, appId: string) =>
  marketplaceAppDetail.parse(await call('getMarketplaceApp', invocation, { params: { appId } }));

const install = async (invocation: Invocation, appId: string) =>
  marketplaceInstall.parse(await call('installMarketplaceApp', invocation, { params: { appId } }));

const uninstall = (invocation: Invocation, installId: string) =>
  call('uninstallMarketplaceApp', invocation, { params: { installId } });

const installed = async (invocation: Invocation) =>
  installedMarketplaceAppList.parse(await call('listInstalledMarketplaceApps', invocation));

const asOwner = <Row extends object>(text: string, values: unknown[]) =>
  database.as('crm_owner', (sql) => sql.query<Row>(text, values));

const eventsOf = (correlationId: string) =>
  asOwner<{ type: string; subject_kind: string; business_id: string | null; payload: unknown }>(
    `select type, subject_kind, business_id, payload from events.events
     where correlation_id = $1 order by recorded_at, id`,
    [correlationId],
  );

describe('the agency publishes apps', () => {
  it('adds an app as a draft, made by the person who added it', async () => {
    const { publisher, agency } = await agencyWithTwoBusinesses();

    const made = await createApp(publisher, { ...appBody, name: ' Booking Sync ' });

    expect(made).toMatchObject({
      name: 'Booking Sync',
      tagline: 'Keeps bookings in step',
      developer: 'Harbor Labs',
      websiteUrl: 'https://harbor.example',
      supportEmail: 'help@harbor.example',
      iconUrl: null,
      categories: ['calendars', 'productivity'],
      scopes: ['tags.manage'],
      status: 'draft',
      installCount: 0,
    });
    const [row] = await asOwner<{ agency_id: string; created_by: string }>(
      'select agency_id, created_by from tenancy.marketplace_apps where id = $1',
      [parsePublicId('marketplace_app', made.id)],
    );
    expect(row).toEqual({ agency_id: agency.id, created_by: publisher.context.userId });
    expect(await eventsOf(publisher.context.correlationId)).toEqual([
      {
        type: 'marketplace_app.created',
        subject_kind: 'marketplace_app',
        business_id: null,
        payload: { name: 'Booking Sync', status: 'draft' },
      },
    ]);
    expect(await agencyApps(publisher)).toEqual([made]);
  });

  it('changes the whole app, and says when it is listed and delisted', async () => {
    const { publisher } = await agencyWithTwoBusinesses();
    const made = await createApp(publisher);

    const renamed = await updateApp(publisher, made.id, {
      ...appBody,
      name: 'Booking Mirror',
      categories: ['calendars'],
      scopes: [],
      status: 'draft',
    });
    const listed = await updateApp(publisher, made.id, { ...appBody, status: 'listed' });
    const delisted = await updateApp(publisher, made.id, { ...appBody, status: 'delisted' });

    expect(renamed).toMatchObject({ name: 'Booking Mirror', categories: ['calendars'] });
    expect(renamed.scopes).toEqual([]);
    expect(listed.status).toBe('listed');
    expect(delisted.status).toBe('delisted');
    expect((await eventsOf(publisher.context.correlationId)).map((each) => each.type)).toEqual([
      'marketplace_app.created',
      'marketplace_app.updated',
      'marketplace_app.updated',
      'marketplace_app.listed',
      'marketplace_app.updated',
      'marketplace_app.delisted',
    ]);
  });

  it('lists every app of the agency by name, drafts included, and no other agency’s', async () => {
    const { publisher } = await agencyWithTwoBusinesses();
    const other = await agencyWithTwoBusinesses();
    await createApp(other.publisher, { ...appBody, name: 'Elsewhere' });
    await createApp(publisher, { ...appBody, name: 'Zed Forms' });
    await listedApp(publisher, { name: 'Alpha Reports' });

    expect((await agencyApps(publisher)).map((app) => [app.name, app.status])).toEqual([
      ['Alpha Reports', 'listed'],
      ['Zed Forms', 'draft'],
    ]);
  });

  it('counts the businesses that have an app installed now, not those that uninstalled it', async () => {
    const { publisher, one, two } = await agencyWithTwoBusinesses();
    const appId = await listedApp(publisher);
    const inOne = await person(one.context, ['apps.manage', 'tags.manage']);
    const inTwo = await person(two.context, ['apps.manage', 'tags.manage']);
    await install(inOne, appId);
    const second = await install(inTwo, appId);
    await uninstall(inTwo, second.id);
    await install(inTwo, appId);
    const reinstalled = (await installed(inTwo)).items[0]?.install;
    if (reinstalled === undefined || reinstalled === null) throw new Error('Not reinstalled.');
    await uninstall(inTwo, reinstalled.id);

    const [app] = await agencyApps(publisher);

    expect(app?.installCount).toBe(1);
  });

  it("refuses another agency's app as not found", async () => {
    const { publisher } = await agencyWithTwoBusinesses();
    const other = await agencyWithTwoBusinesses();
    const theirs = await createApp(other.publisher);

    await expect(updateApp(publisher, theirs.id, { ...appBody, status: 'listed' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('is the agency’s own work: refused in a business, and to a key', async () => {
    const { publisher, one } = await agencyWithTwoBusinesses();
    const made = await createApp(publisher);
    const inBusiness = await person(one.context, ['apps.manage']);
    const key: Invocation = {
      ...publisher,
      context: { ...publisher.context, actorKind: 'api_key', actorId: randomUUID() },
    };

    await expect(createApp(inBusiness)).rejects.toThrow(ForbiddenError);
    await expect(updateApp(inBusiness, made.id, { ...appBody, status: 'listed' })).rejects.toThrow(
      'Change this for the whole agency, outside any business.',
    );
    await expect(call('listAgencyMarketplaceApps', inBusiness)).rejects.toThrow(ForbiddenError);
    await expect(createApp(key)).rejects.toThrow('Only a person can publish an app.');
    await expect(updateApp(key, made.id, { ...appBody, status: 'listed' })).rejects.toThrow(
      'Only a person can publish an app.',
    );
  });
});

describe('a business browses the listed apps', () => {
  it("shows the agency's listed apps with no install, and hides drafts", async () => {
    const { publisher, one } = await agencyWithTwoBusinesses();
    const appId = await listedApp(publisher);
    const draft = await createApp(publisher, { ...appBody, name: 'Not yet' });
    const viewer = await person(one.context, []);

    const page = await browse(viewer);

    expect(page.canInstall).toBe(false);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: appId, name: 'Booking Sync', install: null });
    await expect(detail(viewer, draft.id)).rejects.toThrow(NotFoundError);
    const admin = await person(one.context, ['apps.manage', 'tags.manage']);
    await expect(install(admin, draft.id)).rejects.toThrow(NotFoundError);
  });

  it("never shows another agency's apps, listed or not", async () => {
    const { one } = await agencyWithTwoBusinesses();
    const other = await agencyWithTwoBusinesses();
    const theirs = await listedApp(other.publisher);
    const admin = await person(one.context, ['apps.manage', 'tags.manage']);

    expect((await browse(admin)).items).toEqual([]);
    await expect(detail(admin, theirs)).rejects.toThrow(NotFoundError);
    await expect(install(admin, theirs)).rejects.toThrow(NotFoundError);
  });

  it('finds apps by any part of their name, line or developer, and by category', async () => {
    const { publisher, one } = await agencyWithTwoBusinesses();
    await listedApp(publisher, { name: 'Ledger', tagline: 'Books', developer: 'Northwind' });
    await listedApp(publisher, {
      name: 'Mailer',
      tagline: 'Sends SMS reminders',
      developer: 'Acme',
      categories: ['communication'],
    });
    await listedApp(publisher, {
      name: 'Pulse',
      tagline: '100% uptime',
      developer: 'Ledgerly',
      categories: ['analytics'],
    });
    const admin = await person(one.context, ['apps.manage']);
    const names = async (query: Record<string, unknown>) =>
      (await browse(admin, query)).items.map((app) => app.name);

    expect(await names({})).toEqual(['Ledger', 'Mailer', 'Pulse']);
    expect(await names({ q: 'LEDGER' })).toEqual(['Ledger', 'Pulse']);
    expect(await names({ q: 'sms' })).toEqual(['Mailer']);
    expect(await names({ q: 'acme' })).toEqual(['Mailer']);
    expect(await names({ q: '%' })).toEqual(['Pulse']);
    expect(await names({ q: '  ' })).toEqual(['Ledger', 'Mailer', 'Pulse']);
    expect(await names({ category: 'analytics' })).toEqual(['Pulse']);
    expect(await names({ q: 'ledger', category: 'communication' })).toEqual([]);
    expect((await browse(admin)).canInstall).toBe(true);
  });

  it('is read in a business', async () => {
    const { publisher } = await agencyWithTwoBusinesses();

    await expect(browse(publisher)).rejects.toThrow(ValidationError);
  });

  it('names what the app asks for that the reader does not hold', async () => {
    const { publisher, one } = await agencyWithTwoBusinesses();
    const appId = await listedApp(publisher, { scopes: ['tags.manage', 'contacts.manage'] });
    const member = await person(one.context, ['apps.manage', 'tags.manage']);
    const system: Invocation = { ...member, permissions: 'all' };

    expect(await detail(member, appId)).toMatchObject({
      id: appId,
      scopes: ['tags.manage', 'contacts.manage'],
      missingScopes: ['contacts.manage'],
      canInstall: true,
      install: null,
    });
    expect(await detail(system, appId)).toMatchObject({ missingScopes: [], canInstall: true });
  });
});

describe('a business installs an app', () => {
  it('grants the scopes the app asks for, records who installed it, and says so', async () => {
    const { publisher, one, two } = await agencyWithTwoBusinesses();
    const appId = await listedApp(publisher, { scopes: ['tags.manage'] });
    const admin = await person(one.context, ['apps.manage', 'tags.manage']);

    const made = await install(admin, appId);

    expect(made).toMatchObject({
      appId,
      grantedScopes: ['tags.manage'],
      installedBy: 'Dana Brooks',
    });
    const [row] = await asOwner<{ business_id: string; installed_by: string }>(
      'select business_id, installed_by from tenancy.marketplace_installs where id = $1',
      [parsePublicId('marketplace_install', made.id)],
    );
    expect(row).toEqual({ business_id: one.id, installed_by: admin.context.userId });
    expect(await eventsOf(admin.context.correlationId)).toEqual([
      {
        type: 'marketplace_app.installed',
        subject_kind: 'marketplace_app',
        business_id: one.id,
        payload: {
          installId: parsePublicId('marketplace_install', made.id),
          name: 'Booking Sync',
          grantedScopes: ['tags.manage'],
          grantedReadGroups: [],
        },
      },
    ]);
    expect((await detail(admin, appId)).install).toEqual(made);
    expect((await browse(admin)).items[0]?.install).toEqual(made);
    expect(await installed(admin)).toEqual({
      items: [expect.objectContaining({ id: appId, install: made })],
      canInstall: true,
    });
    // Another business of the agency sees the app, not this install.
    const elsewhere = await person(two.context, []);
    expect((await detail(elsewhere, appId)).install).toBeNull();
    expect((await installed(elsewhere)).items).toEqual([]);
  });

  it('names nobody when the installer cannot be named', async () => {
    const { publisher, one } = await agencyWithTwoBusinesses();
    const appId = await listedApp(publisher, { scopes: [] });
    const nameless = await person(one.context, ['apps.manage'], null);

    expect((await install(nameless, appId)).installedBy).toBeNull();
  });

  it('refuses a second install while the first is live', async () => {
    const { publisher, one } = await agencyWithTwoBusinesses();
    const appId = await listedApp(publisher);
    const admin = await person(one.context, ['apps.manage', 'tags.manage']);
    await install(admin, appId);

    const again = install(admin, appId);

    await expect(again).rejects.toThrow(ConflictError);
    await expect(again).rejects.toThrow('This app is already installed here.');
  });

  it("refuses someone who doesn't hold every permission the app asks for, naming them", async () => {
    const { publisher, one } = await agencyWithTwoBusinesses();
    const appId = await listedApp(publisher, {
      scopes: ['tags.manage', 'contacts.manage', 'deals.manage'],
    });
    const admin = await person(one.context, ['apps.manage', 'tags.manage']);

    const attempt = install(admin, appId);

    await expect(attempt).rejects.toThrow(ForbiddenError);
    await expect(attempt).rejects.toMatchObject({
      message:
        "You can install an app only with permissions you have, and you don't have contacts.manage, deals.manage.",
      permission: 'contacts.manage',
    });
    expect((await installed(admin)).items).toEqual([]);
  });

  it('lets the system install with every permission', async () => {
    const { publisher, one } = await agencyWithTwoBusinesses();
    const appId = await listedApp(publisher, { scopes: ['tags.manage', 'contacts.manage'] });
    const admin = await person(one.context, 'all');

    expect((await install(admin, appId)).grantedScopes).toEqual(['tags.manage', 'contacts.manage']);
  });

  it('is for a person: a key can neither install nor uninstall', async () => {
    const { publisher, one } = await agencyWithTwoBusinesses();
    const appId = await listedApp(publisher);
    const admin = await person(one.context, ['apps.manage', 'tags.manage']);
    const made = await install(admin, appId);
    const key: Invocation = {
      context: { ...one.context, actorKind: 'api_key', actorId: randomUUID() },
      permissions: new Set(['apps.manage', 'tags.manage']),
    };

    await expect(install(key, appId)).rejects.toThrow(
      'Only a person can install or uninstall an app.',
    );
    await expect(uninstall(key, made.id)).rejects.toThrow(
      'Only a person can install or uninstall an app.',
    );
  });

  it('keeps a delisted app installed where it is, and installs it nowhere new', async () => {
    const { publisher, one, two } = await agencyWithTwoBusinesses();
    const appId = await listedApp(publisher);
    const inOne = await person(one.context, ['apps.manage', 'tags.manage']);
    const inTwo = await person(two.context, ['apps.manage', 'tags.manage']);
    const made = await install(inOne, appId);

    await updateApp(publisher, appId, { ...appBody, status: 'delisted' });

    expect((await browse(inOne)).items).toEqual([]);
    expect((await installed(inOne)).items).toEqual([
      expect.objectContaining({ id: appId, status: 'delisted', install: made }),
    ]);
    expect((await detail(inOne, appId)).install).toEqual(made);
    await expect(detail(inTwo, appId)).rejects.toThrow(NotFoundError);
    await expect(install(inTwo, appId)).rejects.toThrow(NotFoundError);
    // Uninstalled, it can't come back: no new installs.
    await uninstall(inOne, made.id);
    await expect(install(inOne, appId)).rejects.toThrow(NotFoundError);
  });

  it('refuses a new install of a delisted app it can still see, as a conflict', async () => {
    const { publisher, one } = await agencyWithTwoBusinesses();
    const appId = await listedApp(publisher);
    const admin = await person(one.context, ['apps.manage', 'tags.manage']);
    await install(admin, appId);
    await updateApp(publisher, appId, { ...appBody, status: 'delisted' });

    await expect(install(admin, appId)).rejects.toThrow(ConflictError);
  });
});

describe('a business uninstalls an app', () => {
  it('keeps the install as history, says so, and lets the app be installed again', async () => {
    const { publisher, one } = await agencyWithTwoBusinesses();
    const appId = await listedApp(publisher);
    const admin = await person(one.context, ['apps.manage', 'tags.manage']);
    const first = await install(admin, appId);

    expect(await uninstall(admin, first.id)).toBeUndefined();

    const [row] = await asOwner<{ uninstalled_by: string; uninstalled: boolean }>(
      `select uninstalled_by, uninstalled_at is not null as uninstalled
       from tenancy.marketplace_installs where id = $1`,
      [parsePublicId('marketplace_install', first.id)],
    );
    expect(row).toEqual({ uninstalled_by: admin.context.userId, uninstalled: true });
    const events = await eventsOf(admin.context.correlationId);
    expect(events.at(-1)).toEqual({
      type: 'marketplace_app.uninstalled',
      subject_kind: 'marketplace_app',
      business_id: one.id,
      payload: { installId: parsePublicId('marketplace_install', first.id), name: 'Booking Sync' },
    });
    expect((await installed(admin)).items).toEqual([]);
    expect((await detail(admin, appId)).install).toBeNull();
    await expect(uninstall(admin, first.id)).rejects.toThrow(NotFoundError);

    const second = await install(admin, appId);
    expect(second.id).not.toBe(first.id);
  });

  it('finds no install of another business, even in the same agency', async () => {
    const { publisher, one, two } = await agencyWithTwoBusinesses();
    const appId = await listedApp(publisher);
    const inOne = await person(one.context, ['apps.manage', 'tags.manage']);
    const inTwo = await person(two.context, ['apps.manage', 'tags.manage']);
    const made = await install(inOne, appId);

    await expect(uninstall(inTwo, made.id)).rejects.toThrow(NotFoundError);
    expect((await installed(inOne)).items).toHaveLength(1);
  });
});
