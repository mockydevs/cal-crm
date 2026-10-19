import { randomBytes, randomUUID } from 'node:crypto';
import { allowEveryone, type Services } from '@repo/commands';
import type { Permission } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { addCallLeg, type ReadCallGrants } from '../call-ledger.js';
import { SMS_CREDENTIALS } from '../sms-connect.js';
import { newWebhookToken, webhookDigest } from '../sms-webhook-url.js';
import { expectedSignature } from '../twilio-signature.js';
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

const DEFAULT_MISSED_CALL_TEXT = 'Sorry we missed your call. How can we help?';

async function world(
  options: {
    readonly allowAnonymous?: boolean;
    readonly grants?: ReadCallGrants;
    readonly addLeg?: typeof addCallLeg;
    readonly capabilities?: ('voice' | 'sms')[];
    readonly missedCallTextEnabled?: boolean;
    readonly missedCallText?: string | null;
    readonly matchContact?: boolean;
    readonly dndInbound?: boolean;
  } = {},
) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const token = newWebhookToken();
  const accountSid = sid('AC');
  const authToken = 'synthetic-missed-auth-token';
  const callSid = sid('CA');
  const from = `+1202555${String(numberSequence++).padStart(4, '0')}`;
  const to = `+1202555${String(numberSequence++).padStart(4, '0')}`;

  const user = await database.fixtures.user();
  const role = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, permissions) values ($1, 'business', $2, 'Team', array['calls.place']) returning id`,
      [agency.id, `team_${randomUUID().replaceAll('-', '_')}`],
    ),
  );
  await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4) returning id`,
      [agency.id, business.id, user.id, role.id],
    ),
  );

  const contact = await database.fixtures.contact(business.context);
  let contactIdentityId: string | null = null;
  if (options.matchContact !== false) {
    await database.withTenant(business.context, async (sql) => {
      const inserted = await sql.one<{ id: string }>(
        `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
         values ($1, $2, 'phone', $3, $3) returning id`,
        [business.id, contact.id, from],
      );
      contactIdentityId = inserted.id;
      await sql.query(
        `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
         values ($1, $2, 'sms', 'transactional', 'granted', 'user', 'system')`,
        [business.id, contact.id],
      );
      if (options.dndInbound) {
        await sql.query('update crm.contacts set dnd_inbound = true where id = $1', [contact.id]);
      }
    });
  }

  const missedCallText =
    options.missedCallText !== undefined ? options.missedCallText : DEFAULT_MISSED_CALL_TEXT;

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
        capabilities: options.capabilities ?? ['voice', 'sms'],
      })
      .execute();

    await trx
      .insertInto('messaging.phone_number_settings')
      .values({
        business_id: business.id,
        phone_number_id: channel.id,
        primary_user_id: user.id,
        ring_timeout_seconds: 30,
        voicemail_backup: false,
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
        missed_call_text_enabled: options.missedCallTextEnabled ?? true,
        missed_call_text: missedCallText,
      })
      .execute();

    await trx
      .insertInto('messaging.settings')
      .values({
        business_id: business.id,
        quiet_hours_enabled: false,
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

  const progressRequest = (stepLegId: string, patch: Record<string, string> = {}) => {
    const path = `/webhooks/twilio/voice/${token}/progress?step=${stepLegId}`;
    const params = {
      AccountSid: accountSid,
      CallSid: sid('CA'),
      ParentCallSid: callSid,
      From: from,
      To: to,
      Direction: 'outbound-dial',
      CallStatus: 'in-progress',
      SequenceNumber: '1',
      CallbackSource: 'call-progress-events',
      ...patch,
    };
    return {
      path,
      body: Buffer.from(new URLSearchParams(params).toString()),
      signature: expectedSignature(authToken, publicUrl + path, params),
    };
  };

  const endedRequest = (patch: Record<string, string> = {}) => {
    const path = `/webhooks/twilio/voice/${token}/ended`;
    const params = {
      AccountSid: accountSid,
      CallSid: callSid,
      From: from,
      To: to,
      Direction: 'inbound',
      CallStatus: 'completed',
      CallDuration: '0',
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
    contact,
    contactIdentityId,
    missedCallText,
    token,
    accountSid,
    authToken,
    callSid,
    from,
    to,
    worker,
    inboundRequest,
    dialResultRequest,
    progressRequest,
    endedRequest,
    query,
  };
}

it('texts a contact back once after their call rang out', async () => {
  const b = await world();
  const inboundRes = await b.worker.handle(b.inboundRequest());
  expect(inboundRes.statusCode).toBe(200);

  const route = await b.query<{ step_leg_id: string }>(
    'select step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );
  expect(route).toHaveLength(1);
  const stepLegId = route[0]?.step_leg_id;

  const dialResultRes = await b.worker.handle(
    b.dialResultRequest(stepLegId, { DialBridged: 'false', DialCallStatus: 'no-answer' }),
  );
  expect(dialResultRes.statusCode).toBe(200);

  const endedRes1 = await b.worker.handle(b.endedRequest({ CallStatus: 'completed' }));
  expect(endedRes1.statusCode).toBe(204);

  const calls = await b.query<{ id: string; state: string; connected_at: string | null }>(
    'select id, state, connected_at from messaging.calls where business_id = $1',
    [b.business.id],
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.state).toBe('ended');
  expect(calls[0]?.connected_at).toBeNull();
  const callId = calls[0]?.id;
  if (callId === undefined) throw new Error('Expected callId');

  const messages = await b.query<{
    id: string;
    channel: string;
    direction: string;
    channel_account_id: string;
    body_text: string;
    to_addresses: readonly string[];
    idempotency_key: string;
  }>(
    'select id, channel, direction, channel_account_id, body_text, to_addresses, idempotency_key from messaging.messages where business_id = $1',
    [b.business.id],
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    channel: 'sms',
    direction: 'outbound',
    channel_account_id: b.phoneNumberId,
    body_text: b.missedCallText,
    to_addresses: [b.from],
    idempotency_key: `missed-call:${callId}`,
  });

  const dispatch = await b.query<{ identity_id: string; purpose: string; lane: string }>(
    'select identity_id, purpose, lane from messaging.outbound_dispatch where business_id = $1 and id = $2',
    [b.business.id, messages[0]?.id],
  );
  expect(dispatch).toHaveLength(1);
  expect(dispatch[0]).toMatchObject({
    identity_id: b.contactIdentityId,
    purpose: 'transactional',
    lane: 'reply',
  });

  // A second identical ended notification adds nothing.
  const endedRes2 = await b.worker.handle(b.endedRequest({ CallStatus: 'completed' }));
  expect(endedRes2.statusCode).toBe(204);

  const messagesAfter = await b.query('select id from messaging.messages where business_id = $1', [
    b.business.id,
  ]);
  expect(messagesAfter).toHaveLength(1);
});

it('texts a contact back when they hung up before anyone answered', async () => {
  const b = await world();
  const inboundRes = await b.worker.handle(b.inboundRequest());
  expect(inboundRes.statusCode).toBe(200);

  const endedRes = await b.worker.handle(b.endedRequest({ CallStatus: 'canceled' }));
  expect(endedRes.statusCode).toBe(204);

  const messages = await b.query<{
    channel: string;
    direction: string;
    channel_account_id: string;
    body_text: string;
    to_addresses: readonly string[];
  }>(
    'select channel, direction, channel_account_id, body_text, to_addresses from messaging.messages where business_id = $1',
    [b.business.id],
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    channel: 'sms',
    direction: 'outbound',
    channel_account_id: b.phoneNumberId,
    body_text: b.missedCallText,
    to_addresses: [b.from],
  });
});

it('texts a contact back when nobody could be rung', async () => {
  const b = await world({ grants: () => Promise.resolve(undefined) });
  const inboundRes = await b.worker.handle(b.inboundRequest());
  expect(inboundRes.statusCode).toBe(200);

  const calls = await b.query<{ state: string; failure_code: string | null }>(
    'select state, failure_code from messaging.calls where business_id = $1',
    [b.business.id],
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    state: 'refused',
    failure_code: 'member_unavailable',
  });

  const endedRes = await b.worker.handle(b.endedRequest({ CallStatus: 'completed' }));
  expect(endedRes.statusCode).toBe(204);

  const messages = await b.query<{
    channel: string;
    direction: string;
    channel_account_id: string;
    body_text: string;
  }>(
    'select channel, direction, channel_account_id, body_text from messaging.messages where business_id = $1',
    [b.business.id],
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    channel: 'sms',
    direction: 'outbound',
    channel_account_id: b.phoneNumberId,
    body_text: b.missedCallText,
  });
});

it('sends nothing after a call someone answered', async () => {
  const b = await world();
  await b.worker.handle(b.inboundRequest());

  const route = await b.query<{ step_leg_id: string }>(
    'select step_leg_id from messaging.call_routes where business_id = $1',
    [b.business.id],
  );
  const stepLegId = route[0]?.step_leg_id;
  if (stepLegId === undefined) throw new Error('Missing stepLegId');

  await b.worker.handle(b.progressRequest(stepLegId));

  const endedRes = await b.worker.handle(b.endedRequest({ CallStatus: 'completed' }));
  expect(endedRes.statusCode).toBe(204);

  const calls = await b.query<{ connected_at: string | null }>(
    'select connected_at from messaging.calls where business_id = $1',
    [b.business.id],
  );
  expect(calls[0]?.connected_at).not.toBeNull();

  const messages = await b.query('select id from messaging.messages where business_id = $1', [
    b.business.id,
  ]);
  expect(messages).toHaveLength(0);
});

it('sends nothing to a caller blocked by do not disturb', async () => {
  const b = await world({ dndInbound: true });
  await b.worker.handle(b.inboundRequest());

  const calls = await b.query<{ state: string; failure_code: string | null }>(
    'select state, failure_code from messaging.calls where business_id = $1',
    [b.business.id],
  );
  expect(calls[0]).toMatchObject({
    state: 'refused',
    failure_code: 'do_not_call',
  });

  const endedRes = await b.worker.handle(b.endedRequest({ CallStatus: 'completed' }));
  expect(endedRes.statusCode).toBe(204);

  const messages = await b.query('select id from messaging.messages where business_id = $1', [
    b.business.id,
  ]);
  expect(messages).toHaveLength(0);
});

it('sends nothing when the missed-call text is off, or its message is empty', async () => {
  const off = await world({ missedCallTextEnabled: false });
  await off.worker.handle(off.inboundRequest());
  await off.worker.handle(off.endedRequest({ CallStatus: 'canceled' }));
  const offMessages = await off.query('select id from messaging.messages where business_id = $1', [
    off.business.id,
  ]);
  expect(offMessages).toHaveLength(0);

  const empty = await world({ missedCallTextEnabled: false, missedCallText: null });
  await empty.worker.handle(empty.inboundRequest());
  await empty.worker.handle(empty.endedRequest({ CallStatus: 'canceled' }));
  const emptyMessages = await empty.query(
    'select id from messaging.messages where business_id = $1',
    [empty.business.id],
  );
  expect(emptyMessages).toHaveLength(0);
});

it("sends nothing to a caller who isn't a contact", async () => {
  const b = await world({ matchContact: false });
  await b.worker.handle(b.inboundRequest());
  await b.worker.handle(b.endedRequest({ CallStatus: 'canceled' }));

  const calls = await b.query<{ contact_identity_id: string | null }>(
    'select contact_identity_id from messaging.calls where business_id = $1',
    [b.business.id],
  );
  expect(calls[0]?.contact_identity_id).toBeNull();

  const messages = await b.query('select id from messaging.messages where business_id = $1', [
    b.business.id,
  ]);
  expect(messages).toHaveLength(0);
});

it("sends nothing from a number that can't text", async () => {
  const b = await world({ capabilities: ['voice'] });
  await b.worker.handle(b.inboundRequest());
  await b.worker.handle(b.endedRequest({ CallStatus: 'canceled' }));

  const messages = await b.query('select id from messaging.messages where business_id = $1', [
    b.business.id,
  ]);
  expect(messages).toHaveLength(0);
});

it("holds the text in the contact's quiet hours, as any message", async () => {
  const b = await world();
  await b.query("update crm.contacts set timezone = 'Pacific/Auckland' where id = $1", [
    b.contact.id,
  ]);
  await b.query(
    `update messaging.settings set quiet_hours_enabled = true,
     quiet_hours_start = ((now() at time zone 'Pacific/Auckland') - interval '1 hour')::time,
     quiet_hours_end = ((now() at time zone 'Pacific/Auckland') + interval '2 hours')::time
     where business_id = $1`,
    [b.business.id],
  );

  await b.worker.handle(b.inboundRequest());
  await b.worker.handle(b.endedRequest({ CallStatus: 'canceled' }));

  const messages = await b.query<{
    status: string;
    error_code: string | null;
    scheduled_for: string | null;
  }>('select status, error_code, scheduled_for from messaging.messages where business_id = $1', [
    b.business.id,
  ]);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    status: 'queued',
    error_code: 'quiet_hours',
  });
  expect(messages[0]?.scheduled_for).not.toBeNull();
});

it("keeps two businesses' missed calls apart", async () => {
  const b1 = await world({ missedCallText: 'Missed by Business 1' });
  const b2 = await world({ missedCallText: 'Missed by Business 2' });

  await b1.worker.handle(b1.inboundRequest());
  await b1.worker.handle(b1.endedRequest({ CallStatus: 'canceled' }));

  await b2.worker.handle(b2.inboundRequest());
  await b2.worker.handle(b2.endedRequest({ CallStatus: 'canceled' }));

  const messages1 = await b1.query<{
    body_text: string;
    to_addresses: readonly string[];
    channel_account_id: string;
  }>(
    'select body_text, to_addresses, channel_account_id from messaging.messages where business_id = $1',
    [b1.business.id],
  );
  expect(messages1).toHaveLength(1);
  expect(messages1[0]).toMatchObject({
    body_text: 'Missed by Business 1',
    to_addresses: [b1.from],
    channel_account_id: b1.phoneNumberId,
  });

  const messages2 = await b2.query<{
    body_text: string;
    to_addresses: readonly string[];
    channel_account_id: string;
  }>(
    'select body_text, to_addresses, channel_account_id from messaging.messages where business_id = $1',
    [b2.business.id],
  );
  expect(messages2).toHaveLength(1);
  expect(messages2[0]).toMatchObject({
    body_text: 'Missed by Business 2',
    to_addresses: [b2.from],
    channel_account_id: b2.phoneNumberId,
  });
});
