// Browser calling tokens against a migrated database: the worker signs a token only for a
// person who may still place calls, for the account calling is set up on, naming that person
// in this business; nobody else reads it, and maintenance clears it once it has expired.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import type { Permission } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  type TenantContext,
} from '@repo/kernel';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { ReadCallGrants } from './call-ledger.js';
import { SMS_CREDENTIALS } from './sms-connect.js';
import { newWebhookToken } from './sms-webhook-url.js';
import {
  createIssueVoiceGrantTask,
  expireVoiceGrants,
  readVoiceGrant,
  requestVoiceGrantCommand,
  VOICE_TOKEN_SECONDS,
} from './voice-grants.js';
import { voiceIdentity } from './voice/voice-identity.js';
import { VOICE_SIGNING_KEY } from './voice-setup.js';

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

const hex = (length: number) => randomBytes(length / 2).toString('hex');

/** What the person's role allows in the business now, as the worker is given it. */
const grantsOf: ReadCallGrants = async (trx, context, userId) => {
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

/** A business whose member Dana may place calls, with calling set up on its Twilio account. */
async function business() {
  const agency = await database.fixtures.agency();
  const tenant = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const membership = await database.as('crm_owner', async (sql) => {
    const role = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, permissions) values ($1, 'business', $2, 'Team', array['calls.place']) returning id`,
      [agency.id, `team_${randomUUID().replaceAll('-', '_')}`],
    );
    return sql.one<{ id: string }>(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4) returning id`,
      [agency.id, tenant.id, user.id, role.id],
    );
  });
  const context: TenantContext = {
    ...tenant.context,
    actorKind: 'user',
    actorId: user.id,
    userId: user.id,
    correlationId: randomUUID(),
  };
  const invocation: Invocation = { context, permissions: 'all' };
  const account = async (label: string) =>
    withTenant(db, tenant.context, async (trx) => {
      const accountSid = `AC${hex(32)}`;
      const key = { sid: `SK${hex(32)}`, secret: hex(32), type: 'standard' as const };
      const credentials = await vault.store(
        trx,
        { agencyId: agency.id, businessId: tenant.id, purpose: SMS_CREDENTIALS },
        JSON.stringify({ accountSid, authToken: hex(32), webhookToken: newWebhookToken() }),
      );
      const connection = await trx
        .insertInto('messaging.provider_connections')
        .values({
          agency_id: agency.id,
          business_id: tenant.id,
          provider: 'twilio',
          label,
          account_ref: accountSid,
          secret_id: credentials,
          status: 'connected',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const keySecret = await vault.store(
        trx,
        { agencyId: agency.id, businessId: tenant.id, purpose: VOICE_SIGNING_KEY },
        JSON.stringify(key),
      );
      await trx
        .insertInto('messaging.voice_setups')
        .values({
          business_id: tenant.id,
          connection_id: connection.id,
          status: 'ready',
          key_sid: key.sid,
          secret_id: keySecret,
          finished_at: new Date(),
        })
        .execute();
      return { connectionId: connection.id, accountSid, key, keySecretId: keySecret };
    });
  const main = await account('Front desk');
  const job = {
    invocation: {
      context: { ...tenant.context, correlationId: randomUUID() },
      permissions: 'all' as const,
    },
    services,
  };
  const request = (as = invocation) => runCommand(services, requestVoiceGrantCommand, {}, as);
  const issue = (grantId: string) =>
    createIssueVoiceGrantTask(vault, grantsOf).run({ grantId }, job);
  const read = (id: string, as = context) => withTenant(db, as, (trx) => readVoiceGrant(trx, id));
  const owner = (text: string, values: readonly unknown[] = []) =>
    database.as('crm_owner', (sql) => sql.query(text, values));
  return {
    agency,
    tenant,
    user,
    membership,
    context,
    invocation,
    main,
    account,
    request,
    issue,
    read,
    owner,
  };
}

const rowId = (id: string) => parsePublicId('voice_grant', id) ?? '';
const claims = (token: string) => {
  const [header, payload] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8')) as unknown,
    payload: JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as {
      iss: string;
      sub: string;
      iat: number;
      exp: number;
      grants: unknown;
    },
  };
};

describe('a calling token', () => {
  it('is signed by the worker for the person in this business, may receive calls and never dials', async () => {
    const b = await business();
    const requested = await b.request();
    expect(requested).toMatchObject({ status: 'requested', token: null, failure: null });
    await b.issue(rowId(requested.id));
    const issued = await b.read(requested.id);
    expect(issued).toMatchObject({ status: 'issued', failure: null });
    const token = issued.token ?? '';
    const { header, payload } = claims(token);
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' });
    expect(payload).toMatchObject({
      iss: b.main.key.sid,
      sub: b.main.accountSid,
      grants: {
        identity: voiceIdentity(b.tenant.id, b.user.id),
        voice: { incoming: { allow: true } },
      },
    });
    expect(payload.grants).not.toHaveProperty('voice.outgoing');
    expect(payload.exp - payload.iat).toBe(VOICE_TOKEN_SECONDS);
    const [h, p, signature] = token.split('.');
    expect(
      createHmac('sha256', b.main.key.secret)
        .update(`${h ?? ''}.${p ?? ''}`)
        .digest('base64url'),
    ).toBe(signature);
    expect(voiceIdentity(b.tenant.id, b.user.id)).toMatch(/^[A-Za-z0-9_]{1,121}$/);
  });

  it('is for the account the default number belongs to, when calling is set up on several', async () => {
    const b = await business();
    const second = await b.account('Sales line');
    const channel = await database.withTenant(b.tenant.context, async (sql) => {
      const row = await sql.one<{ id: string }>(
        `insert into messaging.channel_accounts (business_id, channel, name) values ($1, 'sms', 'Sales') returning id`,
        [b.tenant.id],
      );
      await sql.query(
        `insert into messaging.phone_numbers (business_id,id,e164,provider_connection_id,provider_number_ref,capabilities)
         values ($1,$2,'+14155550188',$3,$4,'{sms,voice}')`,
        [b.tenant.id, row.id, second.connectionId, `PN${hex(32)}`],
      );
      await sql.query(
        'insert into messaging.phone_system_settings (business_id, default_phone_number_id) values ($1, $2)',
        [b.tenant.id, row.id],
      );
      return row.id;
    });
    expect(channel).toBeDefined();
    const requested = await b.request();
    await b.issue(rowId(requested.id));
    expect(claims((await b.read(requested.id)).token ?? '').payload.sub).toBe(second.accountSid);
  });
});

describe('who gets one', () => {
  it('is refused before calling is set up', async () => {
    const b = await business();
    await b.owner('delete from messaging.voice_setups where business_id = $1', [b.tenant.id]);
    await expect(b.request()).rejects.toBeInstanceOf(ConflictError);
  });

  it('is a person signed in with calls.place, never an API key or a role without it', async () => {
    const b = await business();
    await expect(
      b.request({ ...b.invocation, context: { ...b.context, actorKind: 'api_key' } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      b.request({ ...b.invocation, permissions: new Set(['calls.read']) }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('fails without a token for someone who lost calls.place before it was signed', async () => {
    const b = await business();
    const requested = await b.request();
    await b.owner(
      "update tenancy.roles set permissions='{}' where id=(select role_id from tenancy.memberships where id=$1)",
      [b.membership.id],
    );
    await b.issue(rowId(requested.id));
    expect(await b.read(requested.id)).toMatchObject({
      status: 'failed',
      token: null,
      failure: { code: 'member_unavailable' },
    });
  });

  it('fails as expired, not set up, or with an unreadable key, and never signs', async () => {
    const late = await business();
    const lateRequest = await late.request();
    await late.owner(
      "update messaging.voice_grants set requested_at = now() - interval '1 hour', expires_at = now() - interval '58 minutes' where id = $1",
      [rowId(lateRequest.id)],
    );
    await late.issue(rowId(lateRequest.id));
    expect((await late.read(lateRequest.id)).failure?.code).toBe('expired');

    const gone = await business();
    const goneRequest = await gone.request();
    await gone.owner(
      "update messaging.provider_connections set status = 'disconnected' where id = $1",
      [gone.main.connectionId],
    );
    await gone.issue(rowId(goneRequest.id));
    expect((await gone.read(goneRequest.id)).failure?.code).toBe('not_set_up');

    const broken = await business();
    const brokenRequest = await broken.request();
    await withTenant(db, broken.tenant.context, (trx) =>
      vault.replace(trx, broken.main.keySecretId, '{"sid":"nope"}'),
    );
    await broken.issue(rowId(brokenRequest.id));
    expect((await broken.read(brokenRequest.id)).failure?.code).toBe('key_unreadable');
  });
});

describe('who reads it, and for how long', () => {
  it('is read by the person who asked, and by nobody else in the business or outside it', async () => {
    const b = await business();
    const requested = await b.request();
    await b.issue(rowId(requested.id));
    const colleague = await database.fixtures.user();
    await expect(
      b.read(requested.id, { ...b.context, userId: colleague.id, actorId: colleague.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const other = await business();
    await expect(b.read(requested.id, other.context)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('shows no token once it has expired, and maintenance clears it and old requests', async () => {
    const b = await business();
    const requested = await b.request();
    await b.issue(rowId(requested.id));
    await b.owner(
      "update messaging.voice_grants set token_expires_at = now() - interval '1 minute' where id = $1",
      [rowId(requested.id)],
    );
    expect((await b.read(requested.id)).token).toBeNull();
    const old = await b.request();
    await b.owner(
      "update messaging.voice_grants set requested_at = now() - interval '2 days', expires_at = now() - interval '2 days' + interval '2 minutes' where id = $1",
      [rowId(old.id)],
    );
    expect(await expireVoiceGrants(services)).toBeGreaterThanOrEqual(2);
    const [row] = await b.owner('select token from messaging.voice_grants where id = $1', [
      rowId(requested.id),
    ]);
    expect(row).toEqual({ token: null });
    await expect(b.read(old.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
