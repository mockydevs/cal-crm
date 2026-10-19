import { randomBytes, randomUUID } from 'node:crypto';
import { allowEveryone, type Services } from '@repo/commands';
import type { Permission } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { addCallLeg, type ReadCallGrants } from '../call-ledger.js';
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
let numberSequence = 200;

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
    readonly allowAnonymous?: boolean;
    readonly grants?: ReadCallGrants;
    readonly addLeg?: typeof addCallLeg;
  } = {},
) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const token = newWebhookToken();
  const accountSid = sid('AC');
  const authToken = 'synthetic-inbound-auth-token';
  const callSid = sid('CA');
  const from = '+12025550199';
  const to = `+1202555${String(numberSequence++).padStart(4, '0')}`;

  const user = await database.fixtures.user();
  const role = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, permissions) values ($1, 'business', $2, 'Team', array['calls.place']) returning id`,
      [agency.id, `team_${randomUUID().replaceAll('-', '_')}`],
    ),
  );
  const membership = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4) returning id`,
      [agency.id, business.id, user.id, role.id],
    ),
  );
  const memberPublicId = toPublicId('membership', membership.id);

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
        primary_user_id: user.id,
        ring_timeout_seconds: 30,
        voicemail_backup: true,
        use_business_fallback: false,
        ring_also_user_ids: [],
        prefer_contact_owner: false,
        forwarded_caller_id: 'business_number',
      })
      .execute();

    await trx
      .insertInto('messaging.phone_system_settings')
      .values({
        business_id: business.id,
        inbound_allow_anonymous: options.allowAnonymous ?? true,
        inbound_prefer_assigned_user: true,
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

  const request = (patch: Record<string, string> = {}) => {
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

  const query = <T extends object>(text: string, values: readonly unknown[] = []) =>
    database.withTenant(business.context, (sql) => sql.query<T>(text, values));

  return {
    ...made,
    agency,
    business,
    user,
    role,
    membership,
    memberPublicId,
    token,
    accountSid,
    authToken,
    callSid,
    from,
    to,
    worker,
    request,
    query,
  };
}

it("rings the number's team member in the browser, and stores the route at its first step", async () => {
  const b = await world();
  const res = await b.worker.handle(b.request());
  expect(res.statusCode).toBe(200);
  expect(res.contentType).toBe('application/xml');

  const expectedIdentity = voiceIdentity(b.business.id, b.user.id);
  expect(res.body).toContain(`<Client statusCallback=`);
  expect(res.body).toContain(`<Identity>${expectedIdentity}</Identity>`);
  expect(res.body).toContain(
    `action="https://crm.example.test/webhooks/twilio/voice/${b.token}/dial-result?step=`,
  );

  const calls = await b.query<{ id: string; state: string }>(
    'select id, state from messaging.calls where business_id = $1',
    [b.business.id],
  );
  expect(calls).toHaveLength(1);
  const firstCall = calls[0];
  expect(firstCall?.state).toBe('ringing');
  if (firstCall === undefined) throw new Error('Expected call');
  const callId = firstCall.id;
  expect(res.body).toContain(`<Parameter name="callId" value="${toPublicId('call', callId)}"/>`);

  const routes = await b.query<{ step: number; steps: string; caller_id: string }>(
    'select step, steps::text, caller_id from messaging.call_routes where business_id = $1 and call_id = $2',
    [b.business.id, callId],
  );
  expect(routes).toHaveLength(1);
  expect(routes[0]?.step).toBe(0);
  expect(routes[0]?.steps).toContain(expectedIdentity);
  expect(routes[0]?.caller_id).toBe(b.to);

  const legs = await b.query<{
    id: string;
    party: string;
    user_id: string | null;
    to_address: string;
  }>(
    'select id, party, user_id, to_address from messaging.call_legs where call_id = $1 order by created_at asc',
    [callId],
  );
  expect(legs).toHaveLength(2);
  expect(legs[0]).toMatchObject({ party: 'remote', user_id: null, to_address: b.to });
  const firstMemberLeg = legs[1];
  if (firstMemberLeg === undefined) throw new Error('Expected member leg');
  expect(firstMemberLeg).toMatchObject({
    party: 'member',
    user_id: b.user.id,
    to_address: expectedIdentity,
  });
  expect(res.body).toContain(
    `action="https://crm.example.test/webhooks/twilio/voice/${b.token}/dial-result?step=${firstMemberLeg.id}"`,
  );
});

it("rings the contact's owner first when the number says so", async () => {
  const b = await world();
  const ownerUser = await database.fixtures.user();
  await database.as('crm_owner', (sql) =>
    sql.query(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4)`,
      [b.agency.id, b.business.id, ownerUser.id, b.role.id],
    ),
  );

  const contact = await database.fixtures.contact(b.business.context);
  await b.query('update crm.contacts set owner_user_id = $1 where id = $2', [
    ownerUser.id,
    contact.id,
  ]);
  await b.query(
    `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
     values ($1, $2, 'phone', $3, $3)`,
    [b.business.id, contact.id, b.from],
  );

  await b.query(
    'update messaging.phone_number_settings set prefer_contact_owner = true where phone_number_id = $1',
    [b.phoneNumberId],
  );

  const res = await b.worker.handle(b.request());
  expect(res.statusCode).toBe(200);

  const ownerIdentity = voiceIdentity(b.business.id, ownerUser.id);
  const primaryIdentity = voiceIdentity(b.business.id, b.user.id);
  expect(res.body).toContain(ownerIdentity);
  expect(res.body).not.toContain(primaryIdentity);

  interface StoredStepDest {
    readonly kind: string;
    readonly address: string;
  }
  const routes = await b.query<{
    step: number;
    steps: readonly (readonly StoredStepDest[])[];
  }>('select step, steps from messaging.call_routes where business_id = $1', [b.business.id]);
  expect(routes).toHaveLength(1);
  const routeRow = routes[0];
  expect(routeRow?.step).toBe(0);
  expect(routeRow?.steps).toHaveLength(2);
  expect(routeRow?.steps[0]?.[0]?.address).toBe(ownerIdentity);
  expect(routeRow?.steps[1]?.[0]?.address).toBe(primaryIdentity);
});

it('rings the outside number when no team member is set', async () => {
  const b = await world();
  const forwardE164 = '+12025550888';
  await b.query(
    'update messaging.phone_number_settings set primary_user_id = null, forward_to_e164 = $1 where phone_number_id = $2',
    [forwardE164, b.phoneNumberId],
  );

  const res = await b.worker.handle(b.request());
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain(`<Number statusCallback=`);
  expect(res.body).toContain(`>${forwardE164}</Number>`);
  expect(res.body).not.toContain('<Parameter');

  const legs = await b.query<{ party: string; user_id: string | null; to_address: string }>(
    'select party, user_id, to_address from messaging.call_legs where party = $1',
    ['remote'],
  );
  expect(legs.some((leg) => leg.to_address === forwardE164)).toBe(true);
});

it('never rings someone without permission to take calls, or who left the business', async () => {
  const customGrants: ReadCallGrants = () => Promise.resolve(new Set());
  const b = await world({ grants: customGrants });

  const res = await b.worker.handle(b.request());
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe(renderHangup());

  const calls = await b.query<{ state: string; failure_code: string | null }>(
    'select state, failure_code from messaging.calls where business_id = $1',
    [b.business.id],
  );
  expect(calls[0]).toMatchObject({
    state: 'refused',
    failure_code: 'member_unavailable',
  });

  const b2 = await world();
  await database.as('crm_owner', (sql) =>
    sql.query('update auth.users set disabled_at = now() where id = $1', [b2.user.id]),
  );

  const res2 = await b2.worker.handle(b2.request());
  expect(res2.statusCode).toBe(200);
  expect(res2.body).toBe(renderHangup());
  expect(res2.body).not.toContain(voiceIdentity(b2.business.id, b2.user.id));

  const calls2 = await b2.query<{ state: string; failure_code: string | null }>(
    'select state, failure_code from messaging.calls where business_id = $1',
    [b2.business.id],
  );
  expect(calls2[0]).toMatchObject({
    state: 'refused',
    failure_code: 'member_unavailable',
  });
});

it('hangs up on a caller the contact blocked with do not disturb, and records the refusal', async () => {
  const b = await world();
  const contact = await database.fixtures.contact(b.business.context);
  await b.query('update crm.contacts set dnd_inbound = true where id = $1', [contact.id]);
  await b.query(
    `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
     values ($1, $2, 'phone', $3, $3)`,
    [b.business.id, contact.id, b.from],
  );

  const res = await b.worker.handle(b.request());
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe(renderHangup());

  const calls = await b.query<{ state: string; failure_code: string | null }>(
    'select state, failure_code from messaging.calls where business_id = $1',
    [b.business.id],
  );
  expect(calls[0]).toMatchObject({
    state: 'refused',
    failure_code: 'do_not_call',
  });

  const routes = await b.query('select 1 from messaging.call_routes where business_id = $1', [
    b.business.id,
  ]);
  expect(routes).toHaveLength(0);
});

it('hangs up on a hidden number when the business refuses them', async () => {
  const b = await world({ allowAnonymous: false });
  const res = await b.worker.handle(b.request({ From: 'anonymous' }));
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe(renderHangup());

  const calls = await b.query<{ state: string; failure_code: string | null }>(
    'select state, failure_code from messaging.calls where business_id = $1',
    [b.business.id],
  );
  expect(calls[0]).toMatchObject({
    state: 'refused',
    failure_code: 'contact_unavailable',
  });
});

it('hangs up when nobody can be rung, and records why', async () => {
  const b = await world();
  await b.query(
    'update messaging.phone_number_settings set primary_user_id = null, forward_to_e164 = null where phone_number_id = $1',
    [b.phoneNumberId],
  );

  const res = await b.worker.handle(b.request());
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe(renderHangup());

  const calls = await b.query<{ state: string; failure_code: string | null }>(
    'select state, failure_code from messaging.calls where business_id = $1',
    [b.business.id],
  );
  expect(calls[0]).toMatchObject({
    state: 'refused',
    failure_code: 'member_unavailable',
  });
});

it('answers a repeated request with the same Dial, without a second route or new legs', async () => {
  const b = await world();
  const first = await b.worker.handle(b.request());
  expect(first.statusCode).toBe(200);

  const second = await b.worker.handle(b.request());
  expect(second.statusCode).toBe(200);
  expect(second.body).toBe(first.body);

  const routes = await b.query('select 1 from messaging.call_routes where business_id = $1', [
    b.business.id,
  ]);
  expect(routes).toHaveLength(1);

  const legs = await b.query('select 1 from messaging.call_legs where business_id = $1', [
    b.business.id,
  ]);
  expect(legs).toHaveLength(2);
});

it("hangs up on a number that is not this connection's, and records nothing", async () => {
  const b = await world();
  const res = await b.worker.handle(b.request({ To: '+12025559999' }));
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe(renderHangup());

  const calls = await b.query('select 1 from messaging.calls where business_id = $1', [
    b.business.id,
  ]);
  expect(calls).toHaveLength(0);

  const routes = await b.query('select 1 from messaging.call_routes where business_id = $1', [
    b.business.id,
  ]);
  expect(routes).toHaveLength(0);
});

it("keeps the caller's number out of the audit log and events", async () => {
  const b = await world();
  await b.worker.handle(b.request());

  const audits = await b.query<{ input: string }>(
    "select input::text from audit.commands where command = 'call.answer_inbound'",
  );
  expect(audits).toHaveLength(1);
  expect(audits[0]?.input).not.toContain(b.from);
  expect(audits[0]?.input).not.toContain(b.to);

  const events = await b.query<{ payload: string }>(
    "select payload::text from events.events where type = 'call.progressed'",
  );
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(event.payload).not.toContain(b.from);
    expect(event.payload).not.toContain(b.to);
  }
});

it("keeps two businesses' calls apart when Twilio reuses a CallSid", async () => {
  const b1 = await world();
  const b2 = await world();
  const sharedCallSid = sid('CA');

  const res1 = await b1.worker.handle(b1.request({ CallSid: sharedCallSid }));
  const res2 = await b2.worker.handle(b2.request({ CallSid: sharedCallSid }));

  expect(res1.statusCode).toBe(200);
  expect(res2.statusCode).toBe(200);

  const id1 = voiceIdentity(b1.business.id, b1.user.id);
  const id2 = voiceIdentity(b2.business.id, b2.user.id);

  expect(res1.body).toContain(id1);
  expect(res1.body).not.toContain(id2);

  expect(res2.body).toContain(id2);
  expect(res2.body).not.toContain(id1);

  const calls1 = await b1.query('select 1 from messaging.calls where business_id = $1', [
    b1.business.id,
  ]);
  const calls2 = await b2.query('select 1 from messaging.calls where business_id = $1', [
    b2.business.id,
  ]);
  expect(calls1).toHaveLength(1);
  expect(calls2).toHaveLength(1);
});

it('answers a retry of a refused call with a hang-up, and changes nothing', async () => {
  const b = await world();
  const contact = await database.fixtures.contact(b.business.context);
  await b.query('update crm.contacts set dnd_inbound = true where id = $1', [contact.id]);
  await b.query(
    `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
     values ($1, $2, 'phone', $3, $3)`,
    [b.business.id, contact.id, b.from],
  );

  const first = await b.worker.handle(b.request());
  expect(first.statusCode).toBe(200);
  expect(first.body).toBe(renderHangup());

  const firstCalls = await b.query<{ state: string; failure_code: string | null }>(
    'select state, failure_code from messaging.calls where business_id = $1',
    [b.business.id],
  );
  expect(firstCalls).toHaveLength(1);
  expect(firstCalls[0]).toMatchObject({ state: 'refused', failure_code: 'do_not_call' });

  // Turn DND off before the retry
  await b.query('update crm.contacts set dnd_inbound = false where id = $1', [contact.id]);

  const retry = await b.worker.handle(b.request());
  expect(retry.statusCode).toBe(200);
  expect(retry.body).toBe(renderHangup());

  const retryCalls = await b.query<{ state: string; failure_code: string | null }>(
    'select state, failure_code from messaging.calls where business_id = $1',
    [b.business.id],
  );
  expect(retryCalls).toHaveLength(1);
  expect(retryCalls[0]).toMatchObject({ state: 'refused', failure_code: 'do_not_call' });

  const events = await b.query<{ payload: string }>(
    "select payload::text from events.events where type = 'call.progressed'",
  );
  expect(events).toHaveLength(1);

  const routes = await b.query('select 1 from messaging.call_routes where business_id = $1', [
    b.business.id,
  ]);
  expect(routes).toHaveLength(0);
});

it('never dials a destination whose leg was not stored, and hangs up when none succeed', async () => {
  const standInAddLeg: typeof addCallLeg = () => Promise.resolve(null);
  const b = await world({ addLeg: standInAddLeg });

  const res = await b.worker.handle(b.request());
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe(renderHangup());

  const calls = await b.query<{ state: string; failure_code: string | null }>(
    'select state, failure_code from messaging.calls where business_id = $1',
    [b.business.id],
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    state: 'refused',
    failure_code: 'member_unavailable',
  });

  const routes = await b.query('select 1 from messaging.call_routes where business_id = $1', [
    b.business.id,
  ]);
  expect(routes).toHaveLength(0);
});

it('answers with a hang-up when stored route steps fail schema validation', async () => {
  const b = await world();
  const first = await b.worker.handle(b.request());
  expect(first.statusCode).toBe(200);

  // Corrupt the stored steps
  await b.query(
    `update messaging.call_routes set steps = '[{"kind": "unknown_kind", "address": "invalid"}]' where business_id = $1`,
    [b.business.id],
  );

  const retry = await b.worker.handle(b.request());
  expect(retry.statusCode).toBe(200);
  expect(retry.body).toBe(renderHangup());
});

it("books each ringing person's progress on their own leg, and the call connects when one answers", async () => {
  const b = await world();
  const res = await b.worker.handle(b.request());
  expect(res.statusCode).toBe(200);

  const legs = await b.query<{ id: string; party: string }>(
    'select id, party from messaging.call_legs where business_id = $1 order by created_at asc',
    [b.business.id],
  );
  expect(legs).toHaveLength(2);
  const childLeg = legs[1];
  if (childLeg === undefined) throw new Error('Expected child leg');

  expect(res.body).toContain(
    `statusCallback="https://crm.example.test/webhooks/twilio/voice/${b.token}/progress?step=${childLeg.id}"`,
  );

  const childCallSid = sid('CA');
  const progressPath = `/webhooks/twilio/voice/${b.token}/progress?step=${childLeg.id}`;
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

  const updatedLegs = await b.query<{ status: string; provider_call_sid: string | null }>(
    'select status, provider_call_sid from messaging.call_legs where id = $1',
    [childLeg.id],
  );
  expect(updatedLegs[0]?.status).toBe('in-progress');
  expect(updatedLegs[0]?.provider_call_sid).toBe(childCallSid);

  const calls = await b.query<{ state: string; needs_reconciliation: boolean }>(
    'select state, needs_reconciliation from messaging.calls where business_id = $1',
    [b.business.id],
  );
  expect(calls[0]?.state).toBe('connected');
  expect(calls[0]?.needs_reconciliation).toBe(false);
});

it('rings the assigned number owner first when inbound_prefer_assigned_user is on, and skips them when off', async () => {
  const b = await world();
  const ownerUser = await database.fixtures.user();
  await database.as('crm_owner', (sql) =>
    sql.query(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4)`,
      [b.agency.id, b.business.id, ownerUser.id, b.role.id],
    ),
  );
  await b.query(
    'update messaging.phone_number_settings set owner_user_id = $1, primary_user_id = $2 where phone_number_id = $3',
    [ownerUser.id, b.user.id, b.phoneNumberId],
  );

  const resOn = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resOn.statusCode).toBe(200);
  const ownerIdentity = voiceIdentity(b.business.id, ownerUser.id);
  const primaryIdentity = voiceIdentity(b.business.id, b.user.id);
  expect(resOn.body).toContain(ownerIdentity);
  expect(resOn.body).not.toContain(primaryIdentity);

  await b.query(
    'update messaging.phone_system_settings set inbound_prefer_assigned_user = false where business_id = $1',
    [b.business.id],
  );
  const resOff = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resOff.statusCode).toBe(200);
  expect(resOff.body).toContain(primaryIdentity);
  expect(resOff.body).not.toContain(ownerIdentity);
});

it('allows anonymous callers when inbound_allow_anonymous is on, and hangs up when off', async () => {
  const b = await world({ allowAnonymous: true });

  const resOn = await b.worker.handle(b.request({ CallSid: sid('CA'), From: 'anonymous' }));
  expect(resOn.statusCode).toBe(200);
  expect(resOn.body).toContain('<Dial');

  await b.query(
    'update messaging.phone_system_settings set inbound_allow_anonymous = false where business_id = $1',
    [b.business.id],
  );
  const resOff = await b.worker.handle(b.request({ CallSid: sid('CA'), From: 'anonymous' }));
  expect(resOff.statusCode).toBe(200);
  expect(resOff.body).toBe(renderHangup());
});

it('adds the business fallback number to the route when set, and not when cleared', async () => {
  const b = await world();
  const fallbackE164 = '+12025550777';
  await b.query(
    'update messaging.phone_number_settings set use_business_fallback = true where phone_number_id = $1',
    [b.phoneNumberId],
  );

  await b.query(
    'update messaging.phone_system_settings set inbound_fallback_e164 = $1 where business_id = $2',
    [fallbackE164, b.business.id],
  );
  const resWith = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resWith.statusCode).toBe(200);
  const routesWith = await b.query<{ steps: string }>(
    'select steps::text from messaging.call_routes where business_id = $1 order by created_at desc limit 1',
    [b.business.id],
  );
  expect(routesWith[0]?.steps).toContain(fallbackE164);

  await b.query(
    'update messaging.phone_system_settings set inbound_fallback_e164 = null where business_id = $1',
    [b.business.id],
  );
  const resWithout = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resWithout.statusCode).toBe(200);
  const routesWithout = await b.query<{ steps: string }>(
    'select steps::text from messaging.call_routes where business_id = $1 order by created_at desc limit 1',
    [b.business.id],
  );
  expect(routesWithout[0]?.steps).not.toContain(fallbackE164);
});

it('rings the number owner when owner_user_id is set, and skips them when null', async () => {
  const b = await world();
  const ownerUser = await database.fixtures.user();
  await database.as('crm_owner', (sql) =>
    sql.query(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4)`,
      [b.agency.id, b.business.id, ownerUser.id, b.role.id],
    ),
  );
  const ownerIdentity = voiceIdentity(b.business.id, ownerUser.id);
  const primaryIdentity = voiceIdentity(b.business.id, b.user.id);

  await b.query(
    'update messaging.phone_number_settings set owner_user_id = $1, primary_user_id = $2 where phone_number_id = $3',
    [ownerUser.id, b.user.id, b.phoneNumberId],
  );
  const resSet = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resSet.statusCode).toBe(200);
  expect(resSet.body).toContain(ownerIdentity);

  await b.query(
    'update messaging.phone_number_settings set owner_user_id = null where phone_number_id = $1',
    [b.phoneNumberId],
  );
  const resNull = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resNull.statusCode).toBe(200);
  expect(resNull.body).toContain(primaryIdentity);
  expect(resNull.body).not.toContain(ownerIdentity);
});

it('rings the primary user set on the number, and changes when primary_user_id changes', async () => {
  const b = await world();
  const user2 = await database.fixtures.user();
  await database.as('crm_owner', (sql) =>
    sql.query(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4)`,
      [b.agency.id, b.business.id, user2.id, b.role.id],
    ),
  );
  const id1 = voiceIdentity(b.business.id, b.user.id);
  const id2 = voiceIdentity(b.business.id, user2.id);

  const res1 = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(res1.statusCode).toBe(200);
  expect(res1.body).toContain(id1);
  expect(res1.body).not.toContain(id2);

  await b.query(
    'update messaging.phone_number_settings set primary_user_id = $1 where phone_number_id = $2',
    [user2.id, b.phoneNumberId],
  );
  const res2 = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(res2.statusCode).toBe(200);
  expect(res2.body).toContain(id2);
  expect(res2.body).not.toContain(id1);
});

it('rings additional team members in parallel when ring_also_user_ids is set, and not when empty', async () => {
  const b = await world();
  const user2 = await database.fixtures.user();
  await database.as('crm_owner', (sql) =>
    sql.query(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4)`,
      [b.agency.id, b.business.id, user2.id, b.role.id],
    ),
  );
  const id2 = voiceIdentity(b.business.id, user2.id);

  await b.query(
    'update messaging.phone_number_settings set ring_also_user_ids = array[$1::uuid] where phone_number_id = $2',
    [user2.id, b.phoneNumberId],
  );
  const resWith = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resWith.statusCode).toBe(200);
  expect(resWith.body).toContain(id2);

  await b.query(
    'update messaging.phone_number_settings set ring_also_user_ids = array[]::uuid[] where phone_number_id = $1',
    [b.phoneNumberId],
  );
  const resWithout = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resWithout.statusCode).toBe(200);
  expect(resWithout.body).not.toContain(id2);
});

it('rings the outside number set to forward to, and not when it is cleared', async () => {
  const b = await world();
  const forwardE164 = '+12025550888';
  await b.query(
    'update messaging.phone_number_settings set primary_user_id = null, forward_to_e164 = $1 where phone_number_id = $2',
    [forwardE164, b.phoneNumberId],
  );

  const resSet = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resSet.statusCode).toBe(200);
  expect(resSet.body).toContain(`<Number statusCallback=`);
  expect(resSet.body).toContain(`>${forwardE164}</Number>`);

  await b.query(
    'update messaging.phone_number_settings set forward_to_e164 = null where phone_number_id = $1',
    [b.phoneNumberId],
  );
  const resCleared = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resCleared.statusCode).toBe(200);
  expect(resCleared.body).toBe(renderHangup());
});

it('falls back to the business number when use_business_fallback is on, and not when off', async () => {
  const b = await world();
  const fallbackE164 = '+12025550777';
  await b.query(
    'update messaging.phone_system_settings set inbound_fallback_e164 = $1 where business_id = $2',
    [fallbackE164, b.business.id],
  );

  await b.query(
    'update messaging.phone_number_settings set use_business_fallback = true where phone_number_id = $1',
    [b.phoneNumberId],
  );
  const resOn = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resOn.statusCode).toBe(200);
  const routesOn = await b.query<{ steps: string }>(
    'select steps::text from messaging.call_routes where business_id = $1 order by created_at desc limit 1',
    [b.business.id],
  );
  expect(routesOn[0]?.steps).toContain(fallbackE164);

  await b.query(
    'update messaging.phone_number_settings set use_business_fallback = false where phone_number_id = $1',
    [b.phoneNumberId],
  );
  const resOff = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resOff.statusCode).toBe(200);
  const routesOff = await b.query<{ steps: string }>(
    'select steps::text from messaging.call_routes where business_id = $1 order by created_at desc limit 1',
    [b.business.id],
  );
  expect(routesOff[0]?.steps).not.toContain(fallbackE164);
});

it('changes the dial timeout when ring_timeout_seconds changes', async () => {
  const b = await world();

  await b.query(
    'update messaging.phone_number_settings set ring_timeout_seconds = 30 where phone_number_id = $1',
    [b.phoneNumberId],
  );
  const res30 = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(res30.statusCode).toBe(200);
  expect(res30.body).toContain('timeout="25"');

  await b.query(
    'update messaging.phone_number_settings set ring_timeout_seconds = 15 where phone_number_id = $1',
    [b.phoneNumberId],
  );
  const res15 = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(res15.statusCode).toBe(200);
  expect(res15.body).toContain('timeout="10"');
});

it('uses caller or business number as callerId when forwarded_caller_id changes', async () => {
  const b = await world();

  await b.query(
    "update messaging.phone_number_settings set forwarded_caller_id = 'caller' where phone_number_id = $1",
    [b.phoneNumberId],
  );
  const resCaller = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resCaller.statusCode).toBe(200);
  expect(resCaller.body).toContain(`callerId="${b.from}"`);

  await b.query(
    "update messaging.phone_number_settings set forwarded_caller_id = 'business_number' where phone_number_id = $1",
    [b.phoneNumberId],
  );
  const resBusiness = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resBusiness.statusCode).toBe(200);
  expect(resBusiness.body).toContain(`callerId="${b.to}"`);
});

it('rings the contact owner first when prefer_contact_owner is on, and not when off', async () => {
  const b = await world();
  const ownerUser = await database.fixtures.user();
  await database.as('crm_owner', (sql) =>
    sql.query(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4)`,
      [b.agency.id, b.business.id, ownerUser.id, b.role.id],
    ),
  );

  const contact = await database.fixtures.contact(b.business.context);
  await b.query('update crm.contacts set owner_user_id = $1 where id = $2', [
    ownerUser.id,
    contact.id,
  ]);
  await b.query(
    `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
     values ($1, $2, 'phone', $3, $3)`,
    [b.business.id, contact.id, b.from],
  );

  const ownerIdentity = voiceIdentity(b.business.id, ownerUser.id);
  const primaryIdentity = voiceIdentity(b.business.id, b.user.id);

  await b.query(
    'update messaging.phone_number_settings set prefer_contact_owner = true where phone_number_id = $1',
    [b.phoneNumberId],
  );
  const resOn = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resOn.statusCode).toBe(200);
  expect(resOn.body).toContain(ownerIdentity);
  expect(resOn.body).not.toContain(primaryIdentity);

  await b.query(
    'update messaging.phone_number_settings set prefer_contact_owner = false where phone_number_id = $1',
    [b.phoneNumberId],
  );
  const resOff = await b.worker.handle(b.request({ CallSid: sid('CA') }));
  expect(resOff.statusCode).toBe(200);
  expect(resOff.body).toContain(primaryIdentity);
  expect(resOff.body).not.toContain(ownerIdentity);
});
