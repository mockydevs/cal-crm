import { randomUUID } from 'node:crypto';

import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  contactConsent,
  messagingSettings,
  phoneNumber,
  smsConnectionAttempt,
  smsConnectionList,
  smsConnectionStarted,
  type Permission,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ForbiddenError, NotFoundError, toPublicId } from '@repo/kernel';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { createConsentRoutes } from './consent-routes.js';
import { createSmsRoutes } from './sms-routes.js';

const PUBLIC_URL = 'https://crm.example.test';
const ACCOUNT = 'AC00000000000000000000000000000001';
const NUMBER = 'PN00000000000000000000000000000001';
const CONNECT = {
  provider: 'twilio',
  label: 'Front desk',
  accountSid: ACCOUNT,
  authToken: 'synthetic-auth-token',
};

let database: TestDatabase;
let db: Database;
let services: Services;
let vault: Vault;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function business() {
  const agency = await database.fixtures.agency();
  const tenant = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const invocation: Invocation = {
    context: {
      ...tenant.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
  return { agency, tenant, invocation };
}

function routeOf(routes: readonly ApiRoute[], operation: string): ApiRoute {
  const route = routes.find(({ endpoint }) => endpoint.operationId === operation);
  if (route === undefined) throw new Error(`Missing route ${operation}`);
  return route;
}

const request = (invocation: Invocation, params: unknown = {}, body?: unknown) => ({
  invocation,
  params,
  body,
  query: {},
});
const smsRoute = (operation: string) => routeOf(createSmsRoutes(vault, PUBLIC_URL), operation);

async function connected() {
  const b = await business();
  const started = smsConnectionStarted.parse(
    await smsRoute('connectSms').run(request(b.invocation, {}, CONNECT), services),
  );
  const connection = await database.withTenant(b.tenant.context, async (sql) => {
    const attempt = await sql.one<{ id: string; secret_id: string }>(
      'select id, secret_id from messaging.sms_connection_attempts',
    );
    // The worker's connection transition is covered separately by sms.int.test.ts.
    // These route fixtures require no external provider and retain actual tenant/vault FKs.
    const row = await sql.one<{ id: string }>(
      `insert into messaging.provider_connections (agency_id,business_id,provider,label,account_ref,secret_id,account_type,account_status)
       values ($1,$2,'twilio','Front desk',$3,$4,'full','active') returning id`,
      [b.agency.id, b.tenant.id, ACCOUNT, attempt.secret_id],
    );
    await sql.query(
      `update messaging.sms_connection_attempts set status='connected',secret_id=null,connection_id=$1,result='{"accountType":"full","accountStatus":"active","subaccount":false,"numbersFound":1}',finished_at=now() where id=$2`,
      [row.id, attempt.id],
    );
    await sql.query(
      `insert into messaging.provider_numbers (business_id,connection_id,provider_number_ref,e164,capabilities) values ($1,$2,$3,'+15017122661','{sms}')`,
      [b.tenant.id, row.id, NUMBER],
    );
    return row;
  });
  return { ...b, started, connectionId: toPublicId('sms_connection', connection.id) };
}

it('connects through the route and reads the pending attempt without revealing its credentials', async () => {
  const b = await business();
  const started = smsConnectionStarted.parse(
    await smsRoute('connectSms').run(request(b.invocation, {}, CONNECT), services),
  );
  expect(started.inboundWebhookUrl).toMatch(
    /^https:\/\/crm\.example\.test\/webhooks\/twilio\/[A-Za-z0-9_-]{43}\/inbound$/,
  );
  const read = smsConnectionAttempt.parse(
    await smsRoute('getSmsConnectionAttempt').run(
      request(b.invocation, { id: started.attempt.id }),
      services,
    ),
  );
  expect(read).toEqual(started.attempt);
  expect(JSON.stringify(read)).not.toContain(CONNECT.authToken);
});

it('says with the connections why an install without a secure public address cannot send or receive', async () => {
  const b = await connected();
  // Where Twilio can reach the install, there is nothing to say.
  expect(
    smsConnectionList.parse(
      await smsRoute('listSmsConnections').run(request(b.invocation), services),
    ),
  ).toMatchObject({ data: [{ id: b.connectionId }], unavailable: null });
  // The same business on an install whose public address is http: the connection is
  // still listed, and the list says no text message can be sent or received.
  for (const publicUrl of ['http://crm.example.test', 'https://my_crm.example.test']) {
    const list = smsConnectionList.parse(
      await routeOf(createSmsRoutes(vault, publicUrl), 'listSmsConnections').run(
        request(b.invocation),
        services,
      ),
    );
    expect(list.data).toMatchObject([{ id: b.connectionId }]);
    expect(list.unavailable).toEqual({
      code: 'public_address_unsuitable',
      message:
        "Text messages can't be sent or received here: this install's public address must be a secure one (https, with no underscore in its name) for the provider to report to.",
    });
  }
  // Connecting there gives no inbound address to paste into Twilio.
  const other = await business();
  expect(
    smsConnectionStarted.parse(
      await routeOf(createSmsRoutes(vault, 'http://crm.example.test'), 'connectSms').run(
        request(other.invocation, {}, CONNECT),
        services,
      ),
    ).inboundWebhookUrl,
  ).toBeNull();
});

it('lists owned connections and cached numbers, registers a sender, and queues a refresh through the settings routes', async () => {
  const b = await connected();
  expect(await smsRoute('listSmsConnections').run(request(b.invocation), services)).toMatchObject({
    data: [{ id: b.connectionId }],
  });
  const params = { id: b.connectionId };
  expect(
    await smsRoute('listSmsProviderNumbers').run(request(b.invocation, params), services),
  ).toMatchObject({ data: [{ providerNumberRef: NUMBER, registeredAs: null }] });
  const registered = phoneNumber.parse(
    await smsRoute('registerPhoneNumber').run(
      request(
        b.invocation,
        {},
        { connectionId: b.connectionId, providerNumberRef: NUMBER, name: 'Front desk' },
      ),
      services,
    ),
  );
  expect(registered).toMatchObject({
    connectionId: b.connectionId,
    e164: '+15017122661',
    name: 'Front desk',
  });
  expect(await smsRoute('listPhoneNumbers').run(request(b.invocation), services)).toEqual({
    data: [registered],
  });
  expect(
    await smsRoute('listSmsProviderNumbers').run(request(b.invocation, params), services),
  ).toMatchObject({ data: [{ registeredAs: registered.id }] });
  expect(
    await smsRoute('refreshSmsProviderNumbers').run(request(b.invocation, params), services),
  ).toBeUndefined();
  const jobs = await database.as('postgres', (sql) =>
    sql.query<{ task_identifier: string }>(
      "select task_identifier from graphile_worker.jobs where task_identifier='sms.sync_numbers'",
    ),
  );
  expect(jobs).toHaveLength(1);
});

it('requires sms.manage for every SMS settings operation', async () => {
  const b = await connected();
  const denied: Invocation = { ...b.invocation, permissions: new Set<Permission>() };
  for (const [operation, params, body] of [
    ['connectSms', {}, CONNECT],
    ['getSmsConnectionAttempt', { id: b.started.attempt.id }, undefined],
    ['listSmsConnections', {}, undefined],
    ['listSmsProviderNumbers', { id: b.connectionId }, undefined],
    ['refreshSmsProviderNumbers', { id: b.connectionId }, undefined],
    [
      'registerPhoneNumber',
      {},
      { connectionId: b.connectionId, providerNumberRef: NUMBER, name: 'Sender' },
    ],
    ['listPhoneNumbers', {}, undefined],
  ] as const) {
    await expect(
      smsRoute(operation).run(request(denied, params, body), services),
    ).rejects.toBeInstanceOf(ForbiddenError);
  }
});

it('refuses another business’s attempt and connection through its read and refresh routes', async () => {
  const a = await connected();
  const b = await business();
  expect(await smsRoute('listSmsConnections').run(request(b.invocation), services)).toEqual({
    data: [],
    unavailable: null,
  });
  expect(await smsRoute('listPhoneNumbers').run(request(b.invocation), services)).toEqual({
    data: [],
  });
  for (const [operation, id] of [
    ['getSmsConnectionAttempt', a.started.attempt.id],
    ['listSmsProviderNumbers', a.connectionId],
    ['refreshSmsProviderNumbers', a.connectionId],
  ] as const) {
    await expect(
      smsRoute(operation).run(request(b.invocation, { id }), services),
    ).rejects.toBeInstanceOf(NotFoundError);
  }
});

it('records consent and updates quiet hours through their public routes', async () => {
  const b = await business();
  const contact = await database.fixtures.contact(b.tenant.context);
  const routes = createConsentRoutes();
  const params = { id: toPublicId('contact', contact.id) };
  const readConsent = () =>
    routeOf(routes, 'getContactConsent').run(request(b.invocation, params), services);
  expect(contactConsent.parse(await readConsent()).history).toEqual([]);
  await routeOf(routes, 'recordContactConsent').run(
    request(b.invocation, params, {
      channel: 'sms',
      purpose: 'marketing',
      status: 'withdrawn',
      note: 'Requested by the contact by phone.',
    }),
    services,
  );
  expect(contactConsent.parse(await readConsent()).current).toContainEqual(
    expect.objectContaining({ channel: 'sms', purpose: 'marketing', status: 'withdrawn' }),
  );
  const settings = messagingSettings.parse(
    await routeOf(routes, 'getMessagingSettings').run(request(b.invocation), services),
  );
  const updated = await routeOf(routes, 'updateMessagingSettings').run(
    request(
      b.invocation,
      {},
      {
        quietHoursEnabled: false,
        quietHoursStart: settings.quietHoursStart,
        quietHoursEnd: settings.quietHoursEnd,
        contactDailyLimit: settings.contactDailyLimit,
        revision: settings.revision,
      },
    ),
    services,
  );
  expect(messagingSettings.parse(updated).quietHoursEnabled).toBe(false);
  expect(
    messagingSettings.parse(
      await routeOf(routes, 'getMessagingSettings').run(request(b.invocation), services),
    ).quietHoursEnabled,
  ).toBe(false);
});
