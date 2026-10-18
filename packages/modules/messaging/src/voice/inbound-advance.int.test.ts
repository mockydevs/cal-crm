import { randomBytes, randomUUID } from 'node:crypto';
import { allowEveryone, type Services } from '@repo/commands';
import type { Permission } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { addCallLeg, recordInboundCall, type ReadCallGrants } from '../call-ledger.js';
import { SMS_CREDENTIALS } from '../sms-connect.js';
import { newWebhookToken, webhookDigest } from '../sms-webhook-url.js';
import { expectedSignature } from '../twilio-signature.js';
import { voiceIdentity } from './voice-identity.js';
import { renderHangup } from './voice-twiml.js';
import { createVoiceCallbackWorker } from './voice-worker.js';

let database: TestDatabase;
let db: Database;
let vault: Vault;
let services: Services;
const publicUrl = 'https://crm.example.test';
const sid = (prefix: string) => `${prefix}${randomBytes(16).toString('hex')}`;
let numberSequence = 400;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
  services = { db, authorize: allowEveryone };
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

const defaultGrants: ReadCallGrants = async (trx, context, userId) => {
  const row = await trx
    .selectFrom('tenancy.memberships as m')
    .innerJoin('tenancy.roles as r', 'r.id', 'm.role_id')
    .select('r.permissions')
    .where('m.business_id', '=', context.businessId ?? '')
    .where('m.user_id', '=', userId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : new Set(row.permissions.filter((each): each is Permission => each === 'calls.place'));
};

async function world(
  options: {
    readonly preferContactOwner?: boolean;
    readonly preferAssignedUser?: boolean;
    readonly forwardTo?: string | null;
    readonly ringAlsoUser3?: boolean;
    readonly grants?: ReadCallGrants;
    readonly addLeg?: typeof addCallLeg;
  } = {},
) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const token = newWebhookToken();
  const accountSid = sid('AC');
  const authToken = 'synthetic-advance-auth-token';
  const callSid = sid('CA');
  const from = '+12025550199';
  const to = `+1202555${String(numberSequence++).padStart(4, '0')}`;

  const role = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, permissions) values ($1, 'business', $2, 'Team', array['calls.place']) returning id`,
      [agency.id, `team_${randomUUID().replaceAll('-', '_')}`],
    ),
  );

  const user1 = await database.fixtures.user();
  const user2 = await database.fixtures.user();
  const user3 = await database.fixtures.user();

  const m1 = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4) returning id`,
      [agency.id, business.id, user1.id, role.id],
    ),
  );
  const m2 = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4) returning id`,
      [agency.id, business.id, user2.id, role.id],
    ),
  );
  const m3 = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4) returning id`,
      [agency.id, business.id, user3.id, role.id],
    ),
  );

  const contact = await database.fixtures.contact(business.context);
  await database.withTenant(business.context, (sql) =>
    sql.query('update crm.contacts set owner_user_id = $1 where id = $2', [user1.id, contact.id]),
  );
  await database.withTenant(business.context, (sql) =>
    sql.query(
      `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
       values ($1, $2, 'phone', $3, $3)`,
      [business.id, contact.id, from],
    ),
  );

  const made = await withTenant(db, business.context, async (trx) => {
    const secretId = await vault.store(
      trx,
      {
        agencyId: agency.id,
        businessId: business.id,
        purpose: SMS_CREDENTIALS,
      },
      JSON.stringify({ accountSid, authToken, webhookToken: token }),
    );
    const connection = await trx
      .insertInto('messaging.provider_connections')
      .values({
        agency_id: agency.id,
        business_id: business.id,
        provider: 'twilio',
        label: 'Inbound Twilio',
        account_ref: accountSid,
        secret_id: secretId,
        status: 'connected',
        webhook_digest: webhookDigest(token),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('messaging.voice_setups')
      .values({
        business_id: business.id,
        connection_id: connection.id,
        status: 'ready',
        key_sid: sid('SK'),
        secret_id: secretId,
        finished_at: new Date(),
      })
      .execute();

    const channel = await trx
      .insertInto('messaging.channel_accounts')
      .values({
        business_id: business.id,
        channel: 'sms',
        name: 'Inbound Line',
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('messaging.phone_numbers')
      .values({
        id: channel.id,
        business_id: business.id,
        e164: to,
        provider_connection_id: connection.id,
        provider_number_ref: sid('PN'),
        capabilities: ['voice'],
      })
      .execute();

    await trx
      .insertInto('messaging.phone_number_settings')
      .values({
        business_id: business.id,
        phone_number_id: channel.id,
        prefer_contact_owner: options.preferContactOwner ?? true,
        owner_user_id: user2.id,
        primary_user_id: user3.id,
        ring_also_user_ids: options.ringAlsoUser3 ? [user3.id] : [],
        forward_to_e164: options.forwardTo ?? null,
        ring_timeout_seconds: 30,
        voicemail_backup: true,
        use_business_fallback: false,
        forwarded_caller_id: 'business_number',
      })
      .execute();

    await trx
      .insertInto('messaging.phone_system_settings')
      .values({
        business_id: business.id,
        inbound_allow_anonymous: true,
        inbound_prefer_assigned_user: options.preferAssignedUser ?? true,
      })
      .execute();

    return {
      connectionId: connection.id,
      phoneNumberId: channel.id,
    };
  });

  const worker = createVoiceCallbackWorker(
    services,
    vault,
    publicUrl,
    options.grants ?? defaultGrants,
    options.addLeg,
  );

  const inboundRequest = (patch: Record<string, string> = {}) => {
    const path = `/webhooks/twilio/voice/${token}/inbound`;
    const params = {
      AccountSid: accountSid,
      CallSid: callSid,
      From: from,
      To: to,
      Direction: 'inbound',
      CallStatus: 'ringing',
      ...patch,
    };
    return {
      path,
      body: Buffer.from(new URLSearchParams(params).toString()),
      signature: expectedSignature(authToken, publicUrl + path, params),
    };
  };

  const dialResultRequest = (stepLegId?: string, patch: Record<string, string> = {}) => {
    const stepParam = stepLegId === undefined ? '' : `?step=${stepLegId}`;
    const path = `/webhooks/twilio/voice/${token}/dial-result${stepParam}`;
    const params = {
      AccountSid: accountSid,
      CallSid: callSid,
      From: from,
      To: to,
      Direction: 'inbound',
      CallStatus: 'in-progress',
      DialBridged: 'false',
      DialCallStatus: 'no-answer',
      ...patch,
    };
    return {
      path,
      body: Buffer.from(new URLSearchParams(params).toString()),
      signature: expectedSignature(authToken, publicUrl + path, params),
    };
  };

  const query = <T extends object>(text: string, values: readonly unknown[] = []) =>
    database.withTenant(business.context, (sql) => sql.query<T>(text, values));

  const queryFirst = async <T extends object>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<T> => {
    const rows = await query<T>(text, values);
    const first = rows[0];
    if (first === undefined) throw new Error(`Expected at least one row from query: ${text}`);
    return first;
  };

  return {
    ...made,
    agency,
    business,
    user1,
    user2,
    user3,
    m1,
    m2,
    m3,
    id1: voiceIdentity(business.id, user1.id),
    id2: voiceIdentity(business.id, user2.id),
    id3: voiceIdentity(business.id, user3.id),
    token,
    accountSid,
    authToken,
    callSid,
    from,
    to,
    worker,
    inboundRequest,
    dialResultRequest,
    query,
    queryFirst,
  };
}

it('rings the next step when nobody answered the first', async () => {
  const b = await world({ preferContactOwner: true, preferAssignedUser: false });
  const initial = await b.worker.handle(b.inboundRequest());
  expect(initial.statusCode).toBe(200);
  expect(initial.body).toContain(b.id1);

  const route0 = await b.queryFirst<{ step: number; step_leg_id: string }>(
    'select step, step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );
  expect(route0.step).toBe(0);
  expect(route0.step_leg_id).toBeTruthy();

  const res = await b.worker.handle(
    b.dialResultRequest(route0.step_leg_id, {
      DialBridged: 'false',
      DialCallStatus: 'no-answer',
    }),
  );
  expect(res.statusCode).toBe(200);
  expect(res.contentType).toBe('application/xml');
  expect(res.body).toContain(b.id3);
  expect(res.body).not.toContain(b.id1);

  const calls = await b.query<{ id: string }>(
    'select id from messaging.calls where business_id = $1',
    [b.business.id],
  );
  const call = calls[0];
  if (call === undefined) throw new Error('Expected call');
  expect(res.body).toContain(`<Identity>${b.id3}</Identity>`);
  expect(res.body).toContain(`<Parameter name="callId" value="${toPublicId('call', call.id)}"/>`);

  const route1 = await b.queryFirst<{
    step: number;
    step_leg_id: string;
    finished_at: string | null;
  }>('select step, step_leg_id, finished_at from messaging.call_routes where business_id = $1', [
    b.business.id,
  ]);
  expect(route1.step).toBe(1);
  expect(route1.finished_at).toBeNull();
  expect(route1.step_leg_id).not.toBe(route0.step_leg_id);

  const legs = await b.query<{ id: string; party: string; user_id: string | null }>(
    'select id, party, user_id from messaging.call_legs where business_id = $1 order by created_at asc',
    [b.business.id],
  );
  expect(legs).toHaveLength(3);
  const thirdLeg = legs[2];
  if (thirdLeg === undefined) throw new Error('Expected third leg');
  expect(thirdLeg.id).toBe(route1.step_leg_id);
  expect(thirdLeg.user_id).toBe(b.user3.id);

  expect(res.body).toContain(
    `action="https://crm.example.test/webhooks/twilio/voice/${b.token}/dial-result?step=${route1.step_leg_id}"`,
  );
});

it('ends the route when someone answered', async () => {
  const b = await world({ preferContactOwner: true, preferAssignedUser: false });
  const initial = await b.worker.handle(b.inboundRequest());
  expect(initial.statusCode).toBe(200);

  const route0 = await b.queryFirst<{ step_leg_id: string }>(
    'select step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );

  const res = await b.worker.handle(
    b.dialResultRequest(route0.step_leg_id, {
      DialBridged: 'true',
      DialCallStatus: 'completed',
    }),
  );
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe(renderHangup());

  const route1 = await b.queryFirst<{
    step: number;
    step_leg_id: string;
    finished_at: string | null;
  }>('select step, step_leg_id, finished_at from messaging.call_routes where business_id = $1', [
    b.business.id,
  ]);
  expect(route1.finished_at).not.toBeNull();
  expect(route1.step).toBe(0);

  const legs = await b.query<{ id: string }>(
    'select id from messaging.call_legs where business_id = $1',
    [b.business.id],
  );
  expect(legs).toHaveLength(2);
});

it('treats a hang-up during screening as nobody answering', async () => {
  const b = await world({ preferContactOwner: true, preferAssignedUser: false });
  await b.worker.handle(b.inboundRequest());

  const route0 = await b.queryFirst<{ step_leg_id: string }>(
    'select step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );

  const res = await b.worker.handle(
    b.dialResultRequest(route0.step_leg_id, {
      DialCallStatus: 'completed',
      DialBridged: 'false',
    }),
  );
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain(b.id3);

  const route1 = await b.queryFirst<{ step: number; finished_at: string | null }>(
    'select step, finished_at from messaging.call_routes where business_id = $1',
    [b.business.id],
  );
  expect(route1.step).toBe(1);
  expect(route1.finished_at).toBeNull();
});

it('hangs up after the last step', async () => {
  const b = await world({ preferContactOwner: true, preferAssignedUser: false });
  await b.worker.handle(b.inboundRequest());

  const route0 = await b.queryFirst<{ step_leg_id: string }>(
    'select step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );

  const step1Res = await b.worker.handle(
    b.dialResultRequest(route0.step_leg_id, {
      DialBridged: 'false',
      DialCallStatus: 'no-answer',
    }),
  );
  expect(step1Res.statusCode).toBe(200);

  const route1 = await b.queryFirst<{ step: number; step_leg_id: string }>(
    'select step, step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );
  expect(route1.step).toBe(1);

  const lastRes = await b.worker.handle(
    b.dialResultRequest(route1.step_leg_id, {
      DialBridged: 'false',
      DialCallStatus: 'no-answer',
    }),
  );
  expect(lastRes.statusCode).toBe(200);
  expect(lastRes.body).toBe(renderHangup());

  const routeFinal = await b.queryFirst<{ step: number; finished_at: string | null }>(
    'select step, finished_at from messaging.call_routes where business_id = $1',
    [b.business.id],
  );
  expect(routeFinal.step).toBe(2);
  expect(routeFinal.finished_at).not.toBeNull();
});

it('skips a member who lost permission to take calls since the call came in', async () => {
  const b = await world({
    preferContactOwner: true,
    preferAssignedUser: false,
    ringAlsoUser3: true,
  });
  await b.query(
    'update messaging.phone_number_settings set primary_user_id = $1, ring_also_user_ids = array[$2::uuid] where business_id = $3',
    [b.user2.id, b.user3.id, b.business.id],
  );

  await b.worker.handle(b.inboundRequest());

  const route0 = await b.queryFirst<{ step_leg_id: string }>(
    'select step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );

  const noCallsRole = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, permissions) values ($1, 'business', $2, 'NoCalls', array[]::text[]) returning id`,
      [b.agency.id, `nocalls_${randomUUID().replaceAll('-', '_')}`],
    ),
  );
  await database.as('crm_owner', (sql) =>
    sql.query(
      'update tenancy.memberships set role_id = $1 where user_id = $2 and business_id = $3',
      [noCallsRole.id, b.user2.id, b.business.id],
    ),
  );

  const res = await b.worker.handle(
    b.dialResultRequest(route0.step_leg_id, {
      DialBridged: 'false',
      DialCallStatus: 'no-answer',
    }),
  );
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain(b.id3);
  expect(res.body).not.toContain(b.id2);

  const route1 = await b.queryFirst<{ step: number; step_leg_id: string }>(
    'select step, step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );
  expect(route1.step).toBe(1);
});

it('skips a step left empty and rings the one after it', async () => {
  const forwardE164 = '+12025550888';
  const b = await world({
    preferContactOwner: true,
    preferAssignedUser: true,
    forwardTo: forwardE164,
  });
  await b.query(
    'update messaging.phone_number_settings set owner_user_id = $1, primary_user_id = null, forward_to_e164 = $2 where business_id = $3',
    [b.user2.id, forwardE164, b.business.id],
  );

  await b.worker.handle(b.inboundRequest());

  const route0 = await b.queryFirst<{ step_leg_id: string }>(
    'select step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );

  await database.as('crm_owner', (sql) =>
    sql.query('update auth.users set disabled_at = now() where id = $1', [b.user2.id]),
  );

  const res = await b.worker.handle(
    b.dialResultRequest(route0.step_leg_id, {
      DialBridged: 'false',
      DialCallStatus: 'no-answer',
    }),
  );
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain(`<Number statusCallback=`);
  expect(res.body).toContain(`>${forwardE164}</Number>`);
  expect(res.body).not.toContain('<Parameter');

  const route1 = await b.queryFirst<{ step: number; step_leg_id: string }>(
    'select step, step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );
  expect(route1.step).toBe(2);

  const legs = await b.query<{ to_address: string }>(
    'select to_address from messaging.call_legs where business_id = $1',
    [b.business.id],
  );
  expect(legs.some((l) => l.to_address === forwardE164)).toBe(true);
  expect(legs.some((l) => l.to_address === b.id2)).toBe(false);
});

it('changes nothing on a repeated answer to the same Dial', async () => {
  const b = await world({ preferContactOwner: true, preferAssignedUser: false });
  await b.worker.handle(b.inboundRequest());

  const route0 = await b.queryFirst<{ step_leg_id: string }>(
    'select step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );

  const req = b.dialResultRequest(route0.step_leg_id, {
    DialBridged: 'false',
    DialCallStatus: 'no-answer',
  });

  const first = await b.worker.handle(req);
  expect(first.statusCode).toBe(200);
  expect(first.body).toContain(b.id3);

  const legsAfterFirst = await b.query('select 1 from messaging.call_legs where business_id = $1', [
    b.business.id,
  ]);
  expect(legsAfterFirst).toHaveLength(3);

  const second = await b.worker.handle(req);
  expect(second.statusCode).toBe(200);
  expect(second.body).toBe(first.body);

  const legsAfterSecond = await b.query(
    'select 1 from messaging.call_legs where business_id = $1',
    [b.business.id],
  );
  expect(legsAfterSecond).toHaveLength(3);

  const routeFinal = await b.queryFirst<{ step: number }>(
    'select step from messaging.call_routes where business_id = $1',
    [b.business.id],
  );
  expect(routeFinal.step).toBe(1);
});

it('changes nothing on a late answer to an earlier Dial', async () => {
  const b = await world({ preferContactOwner: true, preferAssignedUser: true });
  await b.worker.handle(b.inboundRequest());

  const route0 = await b.queryFirst<{ step_leg_id: string }>(
    'select step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );

  const step1Res = await b.worker.handle(
    b.dialResultRequest(route0.step_leg_id, {
      DialBridged: 'false',
      DialCallStatus: 'no-answer',
    }),
  );
  expect(step1Res.statusCode).toBe(200);
  expect(step1Res.body).toContain(b.id2);

  const route1 = await b.queryFirst<{ step_leg_id: string }>(
    'select step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );

  const lateRes = await b.worker.handle(
    b.dialResultRequest(route0.step_leg_id, {
      DialBridged: 'false',
      DialCallStatus: 'no-answer',
    }),
  );
  expect(lateRes.statusCode).toBe(200);
  expect(lateRes.body).toBe(step1Res.body);

  const routeAfterLate = await b.queryFirst<{ step: number; step_leg_id: string }>(
    'select step, step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );
  expect(routeAfterLate.step).toBe(1);
  expect(routeAfterLate.step_leg_id).toBe(route1.step_leg_id);

  const legs = await b.query('select 1 from messaging.call_legs where business_id = $1', [
    b.business.id,
  ]);
  expect(legs).toHaveLength(3);
});

it("still hangs up an outbound call's dial result", async () => {
  const b = await world();
  const otherCallSid = sid('CA');
  const made = await withTenant(db, b.business.context, async (trx) => {
    return recordInboundCall(trx, b.business.context, {
      phoneNumberId: b.phoneNumberId,
      connectionId: b.connectionId,
      providerCallId: otherCallSid,
      from: b.from,
      to: b.to,
    });
  });
  if (made === null) throw new Error('Call creation failed');

  const res = await b.worker.handle(
    b.dialResultRequest(made.legId, {
      CallSid: otherCallSid,
      DialCallStatus: 'completed',
    }),
  );
  expect(res).toEqual({
    statusCode: 200,
    contentType: 'application/xml',
    body: renderHangup(),
  });
});

it("never advances another business's route", async () => {
  const b1 = await world({ preferContactOwner: true, preferAssignedUser: false });
  const b2 = await world({ preferContactOwner: true, preferAssignedUser: false });

  await b1.worker.handle(b1.inboundRequest());

  const routeB1 = await b1.queryFirst<{ step: number; step_leg_id: string }>(
    'select step, step_leg_id from messaging.call_routes where business_id = $1',
    [b1.business.id],
  );

  const maliciousReq = b2.dialResultRequest(routeB1.step_leg_id, {
    DialBridged: 'false',
    DialCallStatus: 'no-answer',
  });

  const res = await b2.worker.handle(maliciousReq);
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe(renderHangup());

  const routeB1After = await b1.queryFirst<{
    step: number;
    step_leg_id: string;
    finished_at: string | null;
  }>('select step, step_leg_id, finished_at from messaging.call_routes where business_id = $1', [
    b1.business.id,
  ]);
  expect(routeB1After.step).toBe(0);
  expect(routeB1After.step_leg_id).toBe(routeB1.step_leg_id);
  expect(routeB1After.finished_at).toBeNull();

  const legsB1 = await b1.query('select 1 from messaging.call_legs where business_id = $1', [
    b1.business.id,
  ]);
  expect(legsB1).toHaveLength(2);
});

it("books each ringing person's progress on their own leg, and the call connects when one answers", async () => {
  const b = await world({ preferContactOwner: true, preferAssignedUser: false });
  await b.worker.handle(b.inboundRequest());

  const route0 = await b.queryFirst<{ step_leg_id: string }>(
    'select step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );

  const res = await b.worker.handle(
    b.dialResultRequest(route0.step_leg_id, {
      DialBridged: 'false',
      DialCallStatus: 'no-answer',
    }),
  );
  expect(res.statusCode).toBe(200);

  const route1 = await b.queryFirst<{ step: number; step_leg_id: string }>(
    'select step, step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );
  expect(route1.step).toBe(1);

  expect(res.body).toContain(
    `statusCallback="https://crm.example.test/webhooks/twilio/voice/${b.token}/progress?step=${route1.step_leg_id}"`,
  );

  const childCallSid = sid('CA');
  const progressPath = `/webhooks/twilio/voice/${b.token}/progress?step=${route1.step_leg_id}`;
  const progressParams = {
    AccountSid: b.accountSid,
    CallSid: childCallSid,
    ParentCallSid: b.callSid,
    CallStatus: 'in-progress',
    From: b.from,
    To: b.to,
    Direction: 'outbound-dial',
    CallbackSource: 'call-progress-events',
    SequenceNumber: '1',
  };
  const progressRequest = {
    path: progressPath,
    body: Buffer.from(new URLSearchParams(progressParams).toString()),
    signature: expectedSignature(b.authToken, publicUrl + progressPath, progressParams),
  };
  const progressRes = await b.worker.handle(progressRequest);
  expect(progressRes.statusCode).toBe(204);

  const updatedLeg = await b.queryFirst<{ status: string; provider_call_sid: string | null }>(
    'select status, provider_call_sid from messaging.call_legs where id = $1',
    [route1.step_leg_id],
  );
  expect(updatedLeg.status).toBe('in-progress');
  expect(updatedLeg.provider_call_sid).toBe(childCallSid);

  const updatedCall = await b.queryFirst<{
    state: string;
    needs_reconciliation: boolean;
  }>('select state, needs_reconciliation from messaging.calls where business_id = $1', [
    b.business.id,
  ]);
  expect(updatedCall.state).toBe('connected');
  expect(updatedCall.needs_reconciliation).toBe(false);
});
