// Settings → Phone System, through its routes against a migrated database: the settings
// persist per business under row-level security, refuse what can't work, and never claim
// calls can be made.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  phoneNumberSettings,
  phoneSystemNumberList,
  phoneSystemSettings,
  phoneSystemMemberList,
  type Permission,
  type PhoneNumberSettings,
  type PhoneSystemSettings,
  type UpdatePhoneNumberSettingsInput,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { createPhoneSystemRoutes } from './phone-routes.js';

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

const routes = createPhoneSystemRoutes();
function route(operation: string): ApiRoute {
  const found = routes.find(({ endpoint }) => endpoint.operationId === operation);
  if (found === undefined) throw new Error(`Missing route ${operation}`);
  return found;
}
const call = (operation: string, invocation: Invocation, params: unknown = {}, body?: unknown) =>
  route(operation).run({ invocation, params, body, query: {} }, services);

const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).issues.map(({ path, code }) => ({ path, code }));
};

let numberSeq = 0;
it('pages only selectable business members and refuses a disabled routing destination', async () => {
  const b = await business();
  const other = await business();
  const first = await b.member();
  const second = await b.member();
  const disabled = await b.member();
  const stranger = await other.member();
  await database.as('crm_owner', (sql) =>
    sql.query('update auth.users set disabled_at=now() where id=$1', [disabled.userId]),
  );
  const page = async (query: unknown) =>
    phoneSystemMemberList.parse(
      await route('listPhoneSystemMembers').run(
        { invocation: b.invocation, params: {}, query, body: undefined },
        services,
      ),
    );
  const a = await page({ limit: 1 });
  expect(a.data).toHaveLength(1);
  expect(a.nextCursor).toBe(a.data[0]?.id);
  const c = await page({ after: a.nextCursor, limit: 100 });
  const ids = [...a.data, ...c.data].map(({ id }) => id);
  expect(ids).toContain(first.id);
  expect(ids).toContain(second.id);
  expect(ids).not.toContain(disabled.id);
  expect(ids).not.toContain(stranger.id);
  expect(c.nextCursor).toBeNull();
  const number = await b.number(['voice']);
  const current = await readNumber(b.invocation, number.id);
  expect(
    await refusal(
      call(
        'updatePhoneNumberSettings',
        b.invocation,
        { id: number.id },
        numberBody(current, { ownerId: disabled.id }),
      ),
    ),
  ).toEqual([{ path: '/ownerId', code: 'unavailable_member' }]);
});
/** A unique number in the fictional 555-01xx range, one per call across the file. */
const fictional = () => `+1415555${String(1000 + (numberSeq += 1))}`;

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
  const role = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name) values ($1, 'business', $2, 'Team') returning id`,
      [agency.id, `team_${randomUUID().replaceAll('-', '_')}`],
    ),
  );
  /** Someone on this business's team, as their membership's public id. */
  const member = async () => {
    const person = await database.fixtures.user();
    const membership = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4) returning id`,
        [agency.id, tenant.id, person.id, role.id],
      ),
    );
    return { userId: person.id, rowId: membership.id, id: toPublicId('membership', membership.id) };
  };
  const connection = await database.as('crm_owner', async (sql) => {
    const secret = await sql.one<{ id: string }>(
      `insert into vault.secrets(agency_id,business_id,purpose,key_version,enc,ciphertext)
       values($1,$2,'sms.twilio.credentials',1,decode(repeat('00',32),'hex'),decode(repeat('00',32),'hex')) returning id`,
      [agency.id, tenant.id],
    );
    return sql.one<{ id: string }>(
      `insert into messaging.provider_connections(agency_id,business_id,provider,label,account_ref,secret_id)
       values($1,$2,'twilio','Front desk','AC' || substr(md5(random()::text), 1, 32),$3) returning id`,
      [agency.id, tenant.id, secret.id],
    );
  });
  /** A registered number, as registering one from the connection stores it. */
  const number = (capabilities: readonly string[], name = 'Main line') =>
    database.withTenant(tenant.context, async (sql) => {
      const channel = await sql.one<{ id: string }>(
        `insert into messaging.channel_accounts (business_id, channel, name) values ($1, 'sms', $2) returning id`,
        [tenant.id, name],
      );
      const e164 = fictional();
      await sql.query(
        `insert into messaging.phone_numbers (business_id,id,e164,provider_connection_id,provider_number_ref,capabilities)
         values ($1,$2,$3,$4,'PN' || substr(md5(random()::text), 1, 32),$5)`,
        [tenant.id, channel.id, e164, connection.id, capabilities],
      );
      return { rowId: channel.id, id: toPublicId('phone_number', channel.id), e164 };
    });
  const connect = () =>
    database.as('crm_owner', (sql) =>
      sql.query(`update messaging.provider_connections set status = 'connected' where id = $1`, [
        connection.id,
      ]),
    );
  return { agency, tenant, invocation, member, number, connect };
}

const readSystem = async (invocation: Invocation): Promise<PhoneSystemSettings> =>
  phoneSystemSettings.parse(await call('getPhoneSystemSettings', invocation));
const readNumber = async (invocation: Invocation, id: string): Promise<PhoneNumberSettings> =>
  phoneNumberSettings.parse(await call('getPhoneNumberSettings', invocation, { id }));
const systemBody = (current: PhoneSystemSettings, change: Partial<PhoneSystemSettings> = {}) => {
  const { calling: _calling, ...fields } = { ...current, ...change };
  return fields;
};
const numberBody = (
  current: PhoneNumberSettings,
  change: Partial<UpdatePhoneNumberSettingsInput> = {},
): UpdatePhoneNumberSettingsInput => ({
  name: current.name,
  ownerId: current.ownerId,
  voice: current.voice,
  revision: current.revision,
  ...change,
});

it('answers the defaults before anything is saved, and says calls cannot be made', async () => {
  const b = await business();
  const settings = await readSystem(b.invocation);
  expect(settings).toEqual({
    defaultNumberId: null,
    inbound: { preferAssignedUser: true, allowAnonymousCallers: true, fallbackNumber: null },
    outbound: {
      callerId: 'account_default',
      connectAgent: 'after_announcement',
      quietHoursWarning: true,
    },
    recording: { retentionDays: null, transcriptionEnabled: false },
    missedCallText: { enabled: false, message: null },
    revision: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    calling: {
      available: false,
      unavailable: expect.objectContaining({ code: 'no_voice_number' }) as unknown,
    },
  });
  expect(
    phoneSystemNumberList.parse(await call('listPhoneSystemNumbers', b.invocation)).data,
  ).toEqual([]);
});

it('lists every registered number, with call handling only where the number takes calls', async () => {
  const b = await business();
  const voice = await b.number(['sms', 'voice'], 'Main line');
  const text = await b.number(['sms'], 'Texts only');
  const { data } = phoneSystemNumberList.parse(await call('listPhoneSystemNumbers', b.invocation));
  expect(
    data.map(({ id, name, e164, isDefault, warnings }) => ({
      id,
      name,
      e164,
      isDefault,
      warnings,
    })),
  ).toEqual([
    { id: voice.id, name: 'Main line', e164: voice.e164, isDefault: false, warnings: [] },
    { id: text.id, name: 'Texts only', e164: text.e164, isDefault: false, warnings: [] },
  ]);
  expect(data[0]?.voice).toEqual({
    recording: { enabled: false, announcement: { enabled: false, message: null } },
    routing: {
      primaryMemberId: null,
      forwardTo: null,
      useBusinessFallback: false,
      ringAlso: [],
      ringTimeoutSeconds: 20,
      voicemailBackup: true,
    },
    advanced: {
      callConnectConfirmation: false,
      whisper: { enabled: false, message: null },
      forwardedCallerId: 'caller',
      preferContactOwner: false,
    },
  });
  expect(data[1]?.voice).toBeNull();
  // A number that takes calls on a working connection is the next step, not calling:
  // calling still has to be set up on its Twilio account.
  await b.connect();
  expect((await readSystem(b.invocation)).calling).toEqual({
    available: false,
    unavailable: expect.objectContaining({ code: 'calling_not_set_up' }) as unknown,
  });
});

it('saves the calling defaults, refuses a save over newer ones, and records which changed', async () => {
  const b = await business();
  const main = await b.number(['sms', 'voice']);
  const before = await readSystem(b.invocation);
  const saved = phoneSystemSettings.parse(
    await call(
      'updatePhoneSystemSettings',
      b.invocation,
      {},
      systemBody(before, {
        defaultNumberId: main.id,
        inbound: {
          preferAssignedUser: false,
          allowAnonymousCallers: false,
          fallbackNumber: '+14155550199',
        },
        outbound: {
          callerId: 'local_presence',
          connectAgent: 'before_announcement',
          quietHoursWarning: false,
        },
        recording: { retentionDays: 90, transcriptionEnabled: true },
        missedCallText: { enabled: true, message: 'Sorry we missed your call.' },
      }),
    ),
  );
  expect(await readSystem(b.invocation)).toEqual(saved);
  expect(saved).toMatchObject({
    defaultNumberId: main.id,
    inbound: { fallbackNumber: '+14155550199' },
    recording: { retentionDays: 90 },
  });
  expect(saved.revision).not.toBe(before.revision);
  expect((await readNumber(b.invocation, main.id)).isDefault).toBe(true);

  await expect(
    call('updatePhoneSystemSettings', b.invocation, {}, systemBody(before)),
  ).rejects.toBeInstanceOf(ConflictError);

  const events = await database.withTenant(b.tenant.context, (sql) =>
    sql.query<{ subject_id: string; payload: Record<string, unknown> }>(
      `select subject_id, payload from events.events where type = 'phone_system_settings.updated'`,
    ),
  );
  expect(events).toEqual([
    {
      subject_id: b.tenant.id,
      payload: {
        defaultNumberId: main.rowId,
        outboundCallerId: 'local_presence',
        recordingRetentionDays: 90,
        transcriptionEnabled: true,
        missedCallTextEnabled: true,
      },
    },
  ]);
  // The fallback number is someone's phone: it stays out of the event.
  expect(JSON.stringify(events)).not.toContain('5550199');
});

it('refuses a default number that cannot call, a number of another business, and a fallback that loops', async () => {
  const b = await business();
  const other = await business();
  const text = await b.number(['sms']);
  const voice = await b.number(['sms', 'voice']);
  const elsewhere = await other.number(['sms', 'voice']);
  const current = await readSystem(b.invocation);
  const save = (change: Partial<PhoneSystemSettings>) =>
    call('updatePhoneSystemSettings', b.invocation, {}, systemBody(current, change));
  expect(await refusal(save({ defaultNumberId: text.id }))).toEqual([
    { path: '/defaultNumberId', code: 'number_cannot_call' },
  ]);
  expect(await refusal(save({ defaultNumberId: elsewhere.id }))).toEqual([
    { path: '/defaultNumberId', code: 'unavailable_number' },
  ]);
  expect(
    await refusal(save({ inbound: { ...current.inbound, fallbackNumber: voice.e164 } })),
  ).toEqual([{ path: '/inbound/fallbackNumber', code: 'forwards_to_own_number' }]);
  expect(await readSystem(b.invocation)).toEqual(current);
});

it('saves a number’s name, owner, routing, recording and advanced options', async () => {
  const b = await business();
  const main = await b.number(['sms', 'voice']);
  const [owner, first, second] = [await b.member(), await b.member(), await b.member()];
  const before = await readNumber(b.invocation, main.id);
  const voice = {
    recording: {
      enabled: true,
      announcement: { enabled: true, message: 'This call is recorded.' },
    },
    routing: {
      primaryMemberId: first.id,
      forwardTo: '+14155550142',
      useBusinessFallback: false,
      ringAlso: [second.id],
      ringTimeoutSeconds: 25,
      voicemailBackup: false,
    },
    advanced: {
      callConnectConfirmation: true,
      whisper: { enabled: true, message: 'A call from the website.' },
      forwardedCallerId: 'business_number' as const,
      preferContactOwner: true,
    },
  };
  const saved = phoneNumberSettings.parse(
    await call(
      'updatePhoneNumberSettings',
      b.invocation,
      { id: main.id },
      numberBody(before, { name: 'Sales line', ownerId: owner.id, voice }),
    ),
  );
  expect(saved).toMatchObject({ name: 'Sales line', ownerId: owner.id, voice, warnings: [] });
  expect(await readNumber(b.invocation, main.id)).toEqual(saved);
  // The name is the number's channel name everywhere else too.
  const [channel] = await database.withTenant(b.tenant.context, (sql) =>
    sql.query<{ name: string }>('select name from messaging.channel_accounts where id = $1', [
      main.rowId,
    ]),
  );
  expect(channel?.name).toBe('Sales line');

  await expect(
    call('updatePhoneNumberSettings', b.invocation, { id: main.id }, numberBody(before)),
  ).rejects.toBeInstanceOf(ConflictError);
  const [event] = await database.withTenant(b.tenant.context, (sql) =>
    sql.query<{ subject_id: string; payload: Record<string, unknown> }>(
      `select subject_id, payload from events.events where type = 'phone_number.settings_updated'`,
    ),
  );
  expect(event).toEqual({
    subject_id: main.rowId,
    payload: { nameChanged: true, ownerUserId: owner.userId, recordingEnabled: true },
  });
  expect(JSON.stringify(event)).not.toContain('5550142');
});

it('names only a texts-only number and its owner, and asks call handling of a number that takes calls', async () => {
  const b = await business();
  const text = await b.number(['sms']);
  const voice = await b.number(['sms', 'voice']);
  const textSettings = await readNumber(b.invocation, text.id);
  const voiceSettings = await readNumber(b.invocation, voice.id);
  expect(
    await refusal(
      call(
        'updatePhoneNumberSettings',
        b.invocation,
        { id: text.id },
        numberBody(textSettings, { voice: voiceSettings.voice }),
      ),
    ),
  ).toEqual([{ path: '/voice', code: 'voice_not_supported' }]);
  expect(
    await refusal(
      call(
        'updatePhoneNumberSettings',
        b.invocation,
        { id: voice.id },
        numberBody(voiceSettings, { voice: null }),
      ),
    ),
  ).toEqual([{ path: '/voice', code: 'voice_required' }]);
  const owner = await b.member();
  expect(
    phoneNumberSettings.parse(
      await call(
        'updatePhoneNumberSettings',
        b.invocation,
        { id: text.id },
        numberBody(textSettings, { name: 'Texts', ownerId: owner.id }),
      ),
    ),
  ).toMatchObject({ name: 'Texts', ownerId: owner.id, voice: null });
});

it('rings only people on this business’s team, and forwards only outside it', async () => {
  const b = await business();
  const other = await business();
  const main = await b.number(['sms', 'voice']);
  const second = await b.number(['sms', 'voice']);
  const colleague = await b.member();
  const stranger = await other.member();
  const current = await readNumber(b.invocation, main.id);
  const voice = current.voice;
  if (voice === null) throw new Error('A number that takes calls has call handling.');
  const save = (routing: Partial<typeof voice.routing>, ownerId: string | null = null) =>
    call(
      'updatePhoneNumberSettings',
      b.invocation,
      { id: main.id },
      numberBody(current, {
        ownerId,
        voice: { ...voice, routing: { ...voice.routing, ...routing } },
      }),
    );
  expect(await refusal(save({ primaryMemberId: stranger.id }))).toEqual([
    { path: '/voice/routing/primaryMemberId', code: 'unavailable_member' },
  ]);
  expect(await refusal(save({ ringAlso: [colleague.id, stranger.id] }))).toEqual([
    { path: '/voice/routing/ringAlso/1', code: 'unavailable_member' },
  ]);
  expect(await refusal(save({}, stranger.id))).toEqual([
    { path: '/ownerId', code: 'unavailable_member' },
  ]);
  for (const forwardTo of [main.e164, second.e164])
    expect(await refusal(save({ forwardTo }))).toEqual([
      { path: '/voice/routing/forwardTo', code: 'forwards_to_own_number' },
    ]);
  expect(await readNumber(b.invocation, main.id)).toEqual(current);
});

it('warns of routing that reaches nobody, rings too briefly, or falls back to nothing', async () => {
  const b = await business();
  const main = await b.number(['sms', 'voice']);
  const current = await readNumber(b.invocation, main.id);
  const voice = current.voice;
  if (voice === null) throw new Error('A number that takes calls has call handling.');
  const saved = phoneNumberSettings.parse(
    await call(
      'updatePhoneNumberSettings',
      b.invocation,
      { id: main.id },
      numberBody(current, {
        voice: {
          ...voice,
          routing: {
            ...voice.routing,
            useBusinessFallback: true,
            voicemailBackup: false,
            ringTimeoutSeconds: 10,
          },
        },
      }),
    ),
  );
  expect(saved.warnings).toEqual(['fallback_not_set', 'no_destination', 'short_ring_timeout']);
  // With a fallback number set, the fallback is somewhere to go.
  const system = await readSystem(b.invocation);
  await call(
    'updatePhoneSystemSettings',
    b.invocation,
    {},
    systemBody(system, { inbound: { ...system.inbound, fallbackNumber: '+14155550177' } }),
  );
  expect((await readNumber(b.invocation, main.id)).warnings).toEqual(['short_ring_timeout']);
});

it('stops ringing someone who left the team, and says so until the routing is saved again', async () => {
  const b = await business();
  const main = await b.number(['sms', 'voice']);
  const [stays, leaves] = [await b.member(), await b.member()];
  const current = await readNumber(b.invocation, main.id);
  const voice = current.voice;
  if (voice === null) throw new Error('A number that takes calls has call handling.');
  await call(
    'updatePhoneNumberSettings',
    b.invocation,
    { id: main.id },
    numberBody(current, {
      ownerId: leaves.id,
      voice: {
        ...voice,
        routing: { ...voice.routing, primaryMemberId: leaves.id, ringAlso: [stays.id] },
      },
    }),
  );
  await database.as('crm_owner', (sql) =>
    sql.query('delete from tenancy.memberships where id = $1', [leaves.rowId]),
  );
  const after = await readNumber(b.invocation, main.id);
  expect(after).toMatchObject({
    ownerId: null,
    voice: { routing: { primaryMemberId: null, ringAlso: [stays.id] } },
    warnings: ['member_left'],
  });
  // Saving what is shown takes the person out for good.
  const resaved = phoneNumberSettings.parse(
    await call('updatePhoneNumberSettings', b.invocation, { id: main.id }, numberBody(after)),
  );
  expect(resaved.warnings).toEqual([]);
});

it('keeps each business’s numbers and settings to itself', async () => {
  const b = await business();
  const other = await business();
  const main = await b.number(['sms', 'voice']);
  const current = await readNumber(b.invocation, main.id);
  await call(
    'updatePhoneNumberSettings',
    b.invocation,
    { id: main.id },
    numberBody(current, { name: 'Ours' }),
  );
  await expect(readNumber(other.invocation, main.id)).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('updatePhoneNumberSettings', other.invocation, { id: main.id }, numberBody(current)),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(
    phoneSystemNumberList.parse(await call('listPhoneSystemNumbers', other.invocation)).data,
  ).toEqual([]);
  // Row-level security, not only the queries, keeps the rows apart.
  const seen = await database.withTenant(other.tenant.context, (sql) =>
    sql.query(
      'select 1 from messaging.phone_number_settings union all select 1 from messaging.phone_system_settings',
    ),
  );
  expect(seen).toEqual([]);
  await expect(
    readNumber(b.invocation, toPublicId('phone_number', '01890a5d-ac96-774b-bcce-b302099a8057')),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('needs phone.manage to read or change any of it', async () => {
  const b = await business();
  const main = await b.number(['sms', 'voice']);
  const current = await readNumber(b.invocation, main.id);
  const system = await readSystem(b.invocation);
  const denied: Invocation = {
    ...b.invocation,
    permissions: new Set<Permission>(['sms.manage', 'conversations.reply']),
  };
  for (const work of [
    () => call('getPhoneSystemSettings', denied),
    () => call('updatePhoneSystemSettings', denied, {}, systemBody(system)),
    () => call('listPhoneSystemNumbers', denied),
    () => call('listPhoneSystemMembers', denied),
    () => call('getPhoneNumberSettings', denied, { id: main.id }),
    () => call('updatePhoneNumberSettings', denied, { id: main.id }, numberBody(current)),
  ])
    await expect(work()).rejects.toBeInstanceOf(ForbiddenError);
  const allowed: Invocation = {
    ...b.invocation,
    permissions: new Set<Permission>(['phone.manage']),
  };
  expect((await readNumber(allowed, main.id)).id).toBe(main.id);
  const colleague = await b.member();
  const selectable = phoneSystemMemberList.parse(await call('listPhoneSystemMembers', allowed));
  expect(selectable.data.map(({ id }) => id)).toContain(colleague.id);
  const saved = phoneNumberSettings.parse(
    await call(
      'updatePhoneNumberSettings',
      allowed,
      { id: main.id },
      numberBody(current, {
        ownerId: colleague.id,
        voice:
          current.voice === null
            ? null
            : {
                ...current.voice,
                routing: { ...current.voice.routing, primaryMemberId: colleague.id },
              },
      }),
    ),
  );
  expect(saved.ownerId).toBe(colleague.id);
  expect(saved.voice?.routing.primaryMemberId).toBe(colleague.id);
});

it('forgets a number’s settings and its place as the default when the number goes', async () => {
  const b = await business();
  const main = await b.number(['sms', 'voice']);
  const current = await readNumber(b.invocation, main.id);
  await call(
    'updatePhoneNumberSettings',
    b.invocation,
    { id: main.id },
    numberBody(current, { name: 'Gone' }),
  );
  const system = await readSystem(b.invocation);
  await call(
    'updatePhoneSystemSettings',
    b.invocation,
    {},
    systemBody(system, { defaultNumberId: main.id }),
  );
  await database.as('crm_owner', (sql) =>
    sql.query('delete from messaging.channel_accounts where id = $1', [main.rowId]),
  );
  expect((await readSystem(b.invocation)).defaultNumberId).toBeNull();
  expect(
    await database.withTenant(b.tenant.context, (sql) =>
      sql.query('select 1 from messaging.phone_number_settings'),
    ),
  ).toEqual([]);
});
