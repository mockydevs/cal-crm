import { connectDatabase, withTenant, type Database } from '@repo/db';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it, vi } from 'vitest';
import { SMS_CREDENTIALS } from '../sms-connect.js';
import { newWebhookToken, webhookDigest } from '../sms-webhook-url.js';
import { expectedSignature } from '../twilio-signature.js';
import { authenticateVoiceCallback } from './voice-context.js';

let database: TestDatabase;
let db: Database;
let vault: Vault;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

it('opens only the resolved tenant secret and authenticates before exposing a call context', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const token = newWebhookToken();
  const accountSid = `AC${'1'.repeat(32)}`;
  const authToken = 'synthetic-voice-token';
  const connection = await withTenant(db, business.context, async (trx) => {
    const secretId = await vault.store(
      trx,
      { agencyId: agency.id, businessId: business.id, purpose: SMS_CREDENTIALS },
      JSON.stringify({ accountSid, authToken, webhookToken: token }),
    );
    return trx
      .insertInto('messaging.provider_connections')
      .values({
        agency_id: agency.id,
        business_id: business.id,
        provider: 'twilio',
        label: 'Synthetic',
        account_ref: accountSid,
        secret_id: secretId,
        webhook_digest: webhookDigest(token),
      })
      .returning(['id', 'secret_id'])
      .executeTakeFirstOrThrow();
  });
  const params = {
    AccountSid: accountSid,
    CallSid: `CA${'2'.repeat(32)}`,
    From: 'anonymous',
    To: '+12025550101',
    CallStatus: 'ringing',
    Direction: 'inbound',
  };
  const publicUrl = 'https://crm.example.test';
  const path = `/webhooks/twilio/voice/${token}/inbound`;
  const request = {
    path,
    body: Buffer.from(new URLSearchParams(params).toString()),
    signature: expectedSignature(authToken, publicUrl + path, params),
  };
  const authenticate = (
    value: Parameters<typeof authenticateVoiceCallback>[3] = request,
    opener = vault,
  ) => authenticateVoiceCallback(db, opener, publicUrl, value);
  expect(await authenticate()).toMatchObject({
    outcome: 'authenticated',
    connectionId: connection.id,
    context: { agencyId: agency.id, businessId: business.id, actorKind: 'system' },
    verified: { valid: true, call: { accountSid: params.AccountSid, callSid: params.CallSid } },
  });
  const result = await authenticate();
  expect(JSON.stringify(result)).not.toContain(authToken);
  expect(await authenticate({ ...request, signature: 'forged' })).toEqual({
    outcome: 'refused',
    statusCode: 403,
  });
  const read = vi.fn(vault.read.bind(vault));
  const instrumented: Vault = { ...vault, read };
  expect(
    await authenticate(
      { ...request, path: `/webhooks/twilio/voice/${newWebhookToken()}/inbound` },
      instrumented,
    ),
  ).toEqual({ outcome: 'refused', statusCode: 404 });
  expect(read).not.toHaveBeenCalled();
  expect(await authenticate({ ...request, signature: undefined }, instrumented)).toEqual({
    outcome: 'refused',
    statusCode: 403,
  });
  expect(await authenticate({ ...request, body: new Uint8Array(65_537) }, instrumented)).toEqual({
    outcome: 'refused',
    statusCode: 400,
  });
  expect(read).not.toHaveBeenCalled();
  await database.as('crm_owner', (sql) =>
    sql.query('update messaging.provider_connections set account_ref=$1 where id=$2', [
      `AC${'9'.repeat(32)}`,
      connection.id,
    ]),
  );
  expect(await authenticate()).toEqual({ outcome: 'refused', statusCode: 503 });
  await database.as('crm_owner', (sql) =>
    sql.query('update messaging.provider_connections set account_ref=$1 where id=$2', [
      accountSid,
      connection.id,
    ]),
  );
  await withTenant(db, business.context, (trx) => vault.replace(trx, connection.secret_id, '{'));
  expect(await authenticate()).toEqual({ outcome: 'refused', statusCode: 503 });
  expect(await authenticate({ ...request, path: '/api/v1/contacts' }, instrumented)).toEqual({
    outcome: 'refused',
    statusCode: 400,
  });
  expect(read).not.toHaveBeenCalled();
  await database.as('crm_owner', (sql) =>
    sql.query("update messaging.provider_connections set status='disconnected' where id=$1", [
      connection.id,
    ]),
  );
  expect(await authenticate()).toEqual({ outcome: 'refused', statusCode: 404 });
});
