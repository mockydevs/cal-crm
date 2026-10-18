// Webhooks to installed apps, against real Postgres: the agency's secret, the event
// trigger, dispatch into deliveries, each attempt and its retries, and what the agency sees.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type AnyTask, type Invocation, type Services } from '@repo/commands';
import {
  agencyMarketplaceApp,
  agencyMarketplaceAppList,
  appWebhookSecret,
  marketplaceDelivery,
  marketplaceDeliveryList,
  marketplaceInstall,
  type Permission,
} from '@repo/contracts';
import { connectDatabase, type Database, type DatabaseTransaction } from '@repo/db';
import { NotFoundError, toPublicId, ValidationError, type TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  createMarketplaceTasks,
  marketplaceRoutes,
  type AppWebhookOpener,
  type AppWebhookSealer,
  type SendAppWebhook,
} from '../index.js';

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

// Stands in for the vault: real rows in vault.secrets, as crm_app writes them, with the
// plaintext kept here in place of real sealing.
function standInVault(): AppWebhookSealer & AppWebhookOpener & { readonly calls: string[] } {
  const plaintexts = new Map<string, string>();
  const calls: string[] = [];
  const sealed = () => sql<Buffer>`decode(repeat('ab', 32), 'hex')`;
  return {
    calls,
    async store(trx: DatabaseTransaction, owner, plaintext) {
      calls.push(`store:${owner.purpose}`);
      const { id } = await trx
        .insertInto('vault.secrets')
        .values({
          agency_id: owner.agencyId,
          business_id: owner.businessId,
          purpose: owner.purpose,
          key_version: 1,
          enc: sealed(),
          ciphertext: sealed(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      plaintexts.set(id, plaintext);
      return id;
    },
    replace(_trx, secretId, plaintext) {
      calls.push('replace');
      plaintexts.set(secretId, plaintext);
      return Promise.resolve();
    },
    async read(trx: DatabaseTransaction, secretId, purpose) {
      calls.push(`read:${purpose}`);
      await trx
        .selectFrom('vault.secrets')
        .select('id')
        .where('id', '=', secretId)
        .where('purpose', '=', purpose)
        .executeTakeFirstOrThrow();
      const plaintext = plaintexts.get(secretId);
      if (plaintext === undefined) throw new Error('No such secret.');
      return plaintext;
    },
  };
}

const vault = standInVault();
const routes = marketplaceRoutes({ people: () => Promise.resolve(new Map()), webhookVault: vault });

function call(
  operationId: string,
  invocation: Invocation,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
) {
  const found = routes.find((each) => each.endpoint.operationId === operationId);
  if (found === undefined) throw new Error(`No route for ${operationId}.`);
  return found.run(
    {
      invocation,
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body,
    },
    services,
  );
}

async function person(
  where: TenantContext,
  permissions: Iterable<Permission> | 'all',
): Promise<Invocation> {
  const user = await database.fixtures.user();
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

interface Sent {
  readonly url: string;
  readonly body: unknown;
  readonly secret: string;
  readonly deliveryId: string;
}
let sent: Sent[];
let answers: Awaited<ReturnType<SendAppWebhook>>[];
// Each test starts with no job of another test's still queued.
beforeEach(async () => {
  answers = [];
  await drain();
  sent = [];
});
const send: SendAppWebhook = (url, body, options) => {
  sent.push({ url, body, ...options });
  return Promise.resolve(answers.shift() ?? { ok: true, status: 200 });
};
const tasks: readonly AnyTask[] = createMarketplaceTasks({
  vault,
  send,
  // A minute after each attempt, three at most.
  retryDelay: (attempt) => (attempt >= 3 ? undefined : 60_000),
});

/** Runs the queued jobs of these tasks that are due, until none are left. */
async function drain(
  names: readonly string[] = ['marketplace.dispatch_event', 'marketplace.deliver'],
): Promise<void> {
  for (;;) {
    const jobs = await database.runJobs(names);
    if (jobs.length === 0) return;
    for (const job of jobs) {
      const payload = job.payload as {
        agencyId: string;
        businessId: string;
        correlationId: string;
        data: unknown;
      };
      const task = tasks.find((each) => each.name === job.task);
      if (task === undefined) throw new Error(`No task ${job.task}`);
      await task.run(task.data.parse(payload.data), {
        invocation: {
          context: {
            agencyId: payload.agencyId,
            businessId: payload.businessId,
            actorKind: 'system',
            correlationId: payload.correlationId,
          },
          permissions: 'all',
        },
        services,
      });
    }
  }
}

const HOOK = 'https://sync.example/hooks';

/** A listed app with a webhook and its secret, installed in a business. */
async function installedApp(values: Record<string, unknown> = {}) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const publisher = await person(
    { agencyId: agency.id, actorKind: 'system', correlationId: randomUUID() },
    ['apps.manage'],
  );
  const body = {
    name: 'Harbor Sync',
    developer: 'Harbor Labs',
    readGroups: ['Contacts'],
    webhookUrl: HOOK,
    webhookEvents: ['contact.created'],
    ...values,
  };
  const app = agencyMarketplaceApp.parse(await call('createMarketplaceApp', publisher, { body }));
  await call('updateMarketplaceApp', publisher, {
    params: { appId: app.id },
    body: { ...body, status: 'listed' },
  });
  const secret = appWebhookSecret.parse(
    await call('generateAppWebhookSecret', publisher, { params: { appId: app.id } }),
  );
  const installer = await person(business.context, ['apps.manage']);
  const install = marketplaceInstall.parse(
    await call('installMarketplaceApp', installer, { params: { appId: app.id } }),
  );
  return { agency, business, publisher, installer, app, secret, install };
}

const deliveriesOf = async (publisher: Invocation, appId: string, status?: string) =>
  marketplaceDeliveryList.parse(
    await call('listMarketplaceDeliveries', publisher, {
      params: { appId },
      query: status === undefined ? {} : { status },
    }),
  ).items;

/** An event in the business, as a command would write it. */
const event = (business: { id: string; agencyId: string }, type: string, kind: string) =>
  database.as('crm_owner', (owner) =>
    owner.one<{ id: string; subject_id: string }>(
      `insert into events.events (agency_id, business_id, type, actor_kind, correlation_id,
         subject_kind, subject_id)
       values ($1, $2, $3, 'system', uuidv7(), $4, uuidv7()) returning id, subject_id`,
      [business.agencyId, business.id, type, kind],
    ),
  );

describe('setting an app’s webhook', () => {
  it('needs an address for events, and only events the app may read', async () => {
    const agency = await database.fixtures.agency();
    const publisher = await person(
      { agencyId: agency.id, actorKind: 'system', correlationId: randomUUID() },
      ['apps.manage'],
    );
    const base = { name: 'Harbor Sync', developer: 'Harbor', readGroups: ['Contacts'] };
    await expect(
      call('createMarketplaceApp', publisher, {
        body: { ...base, webhookEvents: ['contact.created'] },
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      call('createMarketplaceApp', publisher, {
        body: { ...base, webhookUrl: HOOK, webhookEvents: ['deal.won'] },
      }),
    ).rejects.toThrow('To send deal.won, let the app read Deals.');
  });

  it('keeps the secret in the vault, shows it once, and replaces it in place', async () => {
    const { publisher, app, secret } = await installedApp();
    expect(secret.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const [listed] = agencyMarketplaceAppList.parse(
      await call('listAgencyMarketplaceApps', publisher),
    ).items;
    expect(listed).toMatchObject({
      webhookUrl: HOOK,
      webhookEvents: ['contact.created'],
      webhookSecretSetAt: secret.setAt,
    });
    const next = appWebhookSecret.parse(
      await call('generateAppWebhookSecret', publisher, { params: { appId: app.id } }),
    );
    expect(next.secret).not.toBe(secret.secret);
    const secrets = await database.as('crm_owner', (owner) =>
      owner.query<{ count: number }>(
        `select count(*)::int as count from vault.secrets
          where purpose = 'marketplace.webhook_signing' and agency_id = (
            select agency_id from tenancy.marketplace_apps where name = 'Harbor Sync' limit 1)`,
      ),
    );
    expect(secrets.length).toBe(1);
  });
});

describe('delivering', () => {
  it('tells the app it was installed, and of each event it subscribed to, signed', async () => {
    const { business, publisher, app, secret, install } = await installedApp();
    await drain();
    const contact = await event(business, 'contact.created', 'contact');
    await event(business, 'note.created', 'note');
    await drain();
    expect(sent.map((each) => each.body)).toEqual([
      {
        type: 'app.installed',
        occurredAt: expect.any(String) as string,
        appId: app.id,
        installId: install.id,
        businessId: toPublicId('business', business.id),
        subject: null,
      },
      {
        type: 'contact.created',
        occurredAt: expect.any(String) as string,
        appId: app.id,
        installId: install.id,
        businessId: toPublicId('business', business.id),
        subject: { kind: 'contact', id: toPublicId('contact', contact.subject_id) },
      },
    ]);
    for (const each of sent) {
      expect(each.url).toBe(HOOK);
      expect(each.secret).toBe(secret.secret);
      expect(each.deliveryId).toMatch(/^mdlv_/);
    }
    const deliveries = await deliveriesOf(publisher, app.id);
    expect(deliveries.map((each) => [each.eventType, each.status, each.attempts])).toEqual([
      ['contact.created', 'delivered', 1],
      ['app.installed', 'delivered', 1],
    ]);
    expect(deliveries[0]).toMatchObject({
      business: { id: toPublicId('business', business.id), name: expect.any(String) as string },
      lastStatus: 200,
      lastError: null,
    });
    expect(sent.map((each) => each.deliveryId)).toEqual(
      [...deliveries].reverse().map((each) => each.id),
    );
  });

  it('a business with no subscribed install queues nothing', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    await event(business, 'contact.created', 'contact');
    await drain();
    expect(sent).toEqual([]);
  });

  it('retries what may work later, and gives up on what won’t', async () => {
    const { business, publisher, app } = await installedApp();
    await drain();
    answers = [{ ok: false, retryable: true, status: 503, message: 'Service Unavailable' }];
    await event(business, 'contact.created', 'contact');
    await drain();
    let [latest] = await deliveriesOf(publisher, app.id);
    expect(latest).toMatchObject({
      eventType: 'contact.created',
      status: 'pending',
      attempts: 1,
      lastStatus: 503,
      lastError: 'Service Unavailable',
    });
    expect(latest?.nextAttemptAt).not.toBeNull();
    // The retry waits its minute: nothing more is sent now.
    expect(sent).toHaveLength(2);

    answers = [{ ok: false, retryable: false, message: 'The address is not public.' }];
    await event(business, 'contact.created', 'contact');
    await drain();
    [latest] = await deliveriesOf(publisher, app.id, 'failed');
    expect(latest).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'The address is not public.',
      nextAttemptAt: null,
    });
  });

  it('sends a delivery again from its first attempt, from the agency', async () => {
    const { business, publisher, app } = await installedApp();
    await drain();
    answers = [{ ok: false, retryable: false, status: 410, message: 'Gone' }];
    await event(business, 'contact.created', 'contact');
    await drain();
    const [failed] = await deliveriesOf(publisher, app.id, 'failed');
    if (failed === undefined) throw new Error('expected a failed delivery');
    const again = marketplaceDelivery.parse(
      await call('redeliverMarketplaceWebhook', publisher, { params: { deliveryId: failed.id } }),
    );
    expect(again).toMatchObject({ id: failed.id, status: 'pending', attempts: 0 });
    await drain();
    expect(sent.at(-1)?.deliveryId).toBe(failed.id);
    const [now] = await deliveriesOf(publisher, app.id);
    expect(now).toMatchObject({ id: failed.id, status: 'delivered', attempts: 1 });

    const other = await database.fixtures.agency();
    const stranger = await person(
      { agencyId: other.id, actorKind: 'system', correlationId: randomUUID() },
      ['apps.manage'],
    );
    await expect(
      call('redeliverMarketplaceWebhook', stranger, { params: { deliveryId: failed.id } }),
    ).rejects.toThrow(NotFoundError);
    await expect(deliveriesOf(stranger, app.id)).rejects.toThrow(NotFoundError);
  });

  it('fails a delivery the app can’t take: no secret, or uninstalled', async () => {
    const { business, installer, publisher, app, install } = await installedApp();
    await drain();
    await database.as('crm_owner', (owner) =>
      owner.query(
        `update tenancy.marketplace_apps set webhook_secret_id = null, webhook_secret_set_at = null
          where id = (select app_id from tenancy.marketplace_installs where business_id = $1)`,
        [business.id],
      ),
    );
    await event(business, 'contact.created', 'contact');
    await drain();
    const [unsigned] = await deliveriesOf(publisher, app.id);
    expect(unsigned).toMatchObject({
      status: 'failed',
      lastError: 'The app has no webhook signing secret.',
    });
    await call('generateAppWebhookSecret', publisher, { params: { appId: app.id } });

    // Written before the uninstall, due after it: refused. The notice itself goes.
    await event(business, 'contact.created', 'contact');
    await drain(['marketplace.dispatch_event']);
    await call('uninstallMarketplaceApp', installer, { params: { installId: install.id } });
    await drain();
    const latest = await deliveriesOf(publisher, app.id);
    expect(latest.slice(0, 2).map((each) => [each.eventType, each.status, each.lastError])).toEqual(
      expect.arrayContaining([
        ['app.uninstalled', 'delivered', null],
        ['contact.created', 'failed', 'The app was uninstalled.'],
      ]),
    );
    // After it, nothing more is even written.
    await event(business, 'contact.created', 'contact');
    await drain();
    expect((await deliveriesOf(publisher, app.id)).length).toBe(latest.length);
  });

  it('keeps deliveries 30 days', async () => {
    const { business, publisher, app } = await installedApp();
    await drain();
    await database.as('crm_owner', (owner) =>
      owner.query(
        `update tenancy.marketplace_webhook_deliveries set created_at = now() - interval '31 days'
          where business_id = $1`,
        [business.id],
      ),
    );
    await event(business, 'contact.created', 'contact');
    await drain();
    expect((await deliveriesOf(publisher, app.id)).map((each) => each.eventType)).toEqual([
      'contact.created',
    ]);
  });
});

describe('what does nothing', () => {
  const runTask = (name: string, data: unknown, context: TenantContext) => {
    const task = tasks.find((each) => each.name === name);
    if (task === undefined) throw new Error(`No task ${name}`);
    return task.run(task.data.parse(data), {
      invocation: { context: { ...context, actorKind: 'system' }, permissions: 'all' },
      services,
    });
  };

  it('a secret for another agency’s app, or an app that is not one', async () => {
    const { app } = await installedApp();
    const other = await database.fixtures.agency();
    const stranger = await person(
      { agencyId: other.id, actorKind: 'system', correlationId: randomUUID() },
      ['apps.manage'],
    );
    await expect(
      call('generateAppWebhookSecret', stranger, { params: { appId: app.id } }),
    ).rejects.toThrow(NotFoundError);
  });

  it('an event that is gone, a lifecycle event without its install, a delivery already done', async () => {
    const { business, publisher, app } = await installedApp();
    await drain();
    sent = [];
    const context = { ...business.context, correlationId: randomUUID() };
    await runTask(
      'marketplace.dispatch_event',
      { eventId: '01890000-0000-7000-8000-000000000000', recordedAt: new Date().toISOString() },
      context,
    );
    const lifecycle = await database.as('crm_owner', (owner) =>
      owner.one<{ id: string; recorded_at: Date }>(
        `insert into events.events (agency_id, business_id, type, actor_kind, correlation_id,
           subject_kind, subject_id)
         select agency_id, business_id, 'marketplace_app.installed', 'system', uuidv7(),
                'marketplace_app', app_id
         from tenancy.marketplace_installs where business_id = $1
         returning id, recorded_at`,
        [business.id],
      ),
    );
    await drain();
    await runTask(
      'marketplace.dispatch_event',
      { eventId: lifecycle.id, recordedAt: lifecycle.recorded_at.toISOString() },
      { ...context, businessId: undefined } as unknown as TenantContext,
    );
    const [done] = await deliveriesOf(publisher, app.id);
    if (done === undefined) throw new Error('expected a delivery');
    const id = await database.as('crm_owner', (owner) =>
      owner.one<{ id: string }>(
        `select id from tenancy.marketplace_webhook_deliveries where business_id = $1 limit 1`,
        [business.id],
      ),
    );
    await runTask('marketplace.deliver', { deliveryId: id.id }, context);
    expect(sent).toEqual([]);
    expect(await deliveriesOf(publisher, app.id)).toHaveLength(1);
  });

  it('fails a delivery whose app no longer has an address', async () => {
    const { business, publisher, app } = await installedApp();
    await drain();
    await event(business, 'contact.created', 'contact');
    await drain(['marketplace.dispatch_event']);
    await database.as('crm_owner', (owner) =>
      owner.query(
        `update tenancy.marketplace_apps set webhook_url = null, webhook_events = '{}'
          where id = (select app_id from tenancy.marketplace_installs where business_id = $1)`,
        [business.id],
      ),
    );
    await drain();
    const [latest] = await deliveriesOf(publisher, app.id);
    expect(latest).toMatchObject({
      status: 'failed',
      lastError: 'The app has no webhook address.',
    });
  });
});

describe('without a vault', () => {
  it('offers no route to make a webhook secret', () => {
    const offered = marketplaceRoutes({ people: () => Promise.resolve(new Map()) }).map(
      (each) => each.endpoint.operationId,
    );
    expect(offered).toContain('listMarketplaceDeliveries');
    expect(offered).not.toContain('generateAppWebhookSecret');
  });
});
