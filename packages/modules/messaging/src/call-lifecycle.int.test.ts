// The call ledger against a migrated database: requests are checked and stored as
// requested, the worker reserves before it asks the provider and never asks twice, an
// uncertain answer stays unknown until the provider reports, progress reports are applied
// once and in order, and every read stays inside its business.
import { randomBytes, randomUUID } from 'node:crypto';

import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  call as callSchema,
  callDetail,
  callList,
  type Call,
  type Permission,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  addCallLeg,
  createEndCallTask,
  createPlaceCallTask,
  recordCallProgress,
  recordInboundCall,
  recordInboundTerminal,
  type CallProvider,
  type CallProviderResult,
  type EndedCall,
  type PlacedCall,
  type ReadCallGrants,
} from './call-ledger.js';
import { readCallDetail } from './call-records.js';
import { createCallRoutes } from './call-routes.js';
import { voiceIdentity } from './voice/voice-identity.js';
import type { VoiceProgress } from './voice/voice-progress.js';

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

const available = createCallRoutes(() => Promise.resolve({ available: true, unavailable: null }));
const callerAccess: ReadCallGrants = async (trx, context, userId) => {
  const row = await trx
    .selectFrom('tenancy.memberships as m')
    .innerJoin('tenancy.roles as r', 'r.id', 'm.role_id')
    .select('r.permissions')
    .where('m.business_id', '=', context.businessId ?? '')
    .where('m.user_id', '=', userId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : new Set(
        row.permissions.filter(
          (permission): permission is Permission => permission === 'calls.place',
        ),
      );
};
it('rechecks a departed or permission-revoked caller before any paid worker action', async () => {
  for (const removeMembership of [true, false]) {
    const b = await business();
    const call = await b.request();
    const id = parsePublicId('membership', b.membershipId);
    await database.as('crm_owner', (sql) =>
      removeMembership
        ? sql.query('delete from tenancy.memberships where id=$1', [id])
        : sql.query(
            "update tenancy.roles set permissions='{}' where id=(select role_id from tenancy.memberships where id=$1)",
            [id],
          ),
    );
    const fake = provider();
    await createPlaceCallTask(fake.port, callerAccess).run({ callId: rowId(call) }, b.job);
    expect(await read(b, call)).toMatchObject({ state: 'refused', failure: 'member_unavailable' });
    expect(fake.placed).toEqual([]);
  }
});
const unavailable = createCallRoutes(() =>
  Promise.resolve({
    available: false,
    unavailable: { code: 'calling_not_set_up', message: 'Set up calling first.' },
  }),
);
it('enforces connection tenant ownership at the database boundary', async () => {
  const b = await business();
  const other = await business();
  const call = await b.request();
  await expect(
    b.query('update messaging.calls set provider_connection_id=$1 where id=$2', [
      other.connectionId,
      rowId(call),
    ]),
  ).rejects.toMatchObject({ code: '23503' });
});
it('enforces connection tenant ownership on a call leg too', async () => {
  const b = await business();
  const other = await business();
  const call = await b.request();
  await createPlaceCallTask(provider().port, callerAccess).run({ callId: rowId(call) }, b.job);
  await expect(
    b.query('update messaging.call_legs set provider_connection_id=$1 where call_id=$2', [
      other.connectionId,
      rowId(call),
    ]),
  ).rejects.toMatchObject({ code: '23503' });
});
function route(operation: string, routes = available): ApiRoute {
  const found = routes.find(({ endpoint }) => endpoint.operationId === operation);
  if (found === undefined) throw new Error(`Missing route ${operation}`);
  return found;
}
const run = (
  operation: string,
  invocation: Invocation,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
  routes = available,
) =>
  route(operation, routes).run(
    { invocation, params: request.params ?? {}, query: request.query ?? {}, body: request.body },
    services,
  );

const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).issues.map(({ code }) => code);
};
/** A UUIDv7 no row has. */
const UNKNOWN = '01890a5d-ac96-774b-bcce-b302099a8057';
const hex = (length: number) => randomBytes(length / 2).toString('hex');
const sid = () => `CA${hex(32)}`;
let numberSeq = 0;
const fictional = () => `+1415555${String(2000 + (numberSeq += 1))}`;
const key = () => `call-${randomUUID().replaceAll('-', '')}`.slice(0, 40);

/** A business with a member, a contact's phone, and a voice number on a connected account. */
async function business(options: { readonly defaultNumber?: boolean } = {}) {
  const agency = await database.fixtures.agency();
  const tenant = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const accountSid = `AC${hex(32)}`;
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
  const connection = await database.as('crm_owner', async (sql) => {
    const secret = await sql.one<{ id: string }>(
      `insert into vault.secrets(agency_id,business_id,purpose,key_version,enc,ciphertext)
       values($1,$2,'sms.twilio.credentials',1,decode(repeat('00',32),'hex'),decode(repeat('00',32),'hex')) returning id`,
      [agency.id, tenant.id],
    );
    return sql.one<{ id: string }>(
      `insert into messaging.provider_connections(agency_id,business_id,provider,label,account_ref,secret_id,status)
       values($1,$2,'twilio','Front desk',$3,$4,'connected') returning id`,
      [agency.id, tenant.id, accountSid, secret.id],
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
  const system: Invocation = {
    context: { ...tenant.context, correlationId: randomUUID() },
    permissions: 'all',
  };
  const number = (capabilities: readonly string[] = ['sms', 'voice']) =>
    database.withTenant(tenant.context, async (sql) => {
      const channel = await sql.one<{ id: string }>(
        `insert into messaging.channel_accounts (business_id, channel, name) values ($1, 'sms', 'Main line') returning id`,
        [tenant.id],
      );
      const e164 = fictional();
      await sql.query(
        `insert into messaging.phone_numbers (business_id,id,e164,provider_connection_id,provider_number_ref,capabilities)
         values ($1,$2,$3,$4,'PN' || substr(md5(random()::text), 1, 32),$5)`,
        [tenant.id, channel.id, e164, connection.id, capabilities],
      );
      return { rowId: channel.id, id: toPublicId('phone_number', channel.id), e164 };
    });
  const main = await number();
  if (options.defaultNumber !== false)
    await database.withTenant(tenant.context, (sql) =>
      sql.query(
        'insert into messaging.phone_system_settings (business_id, default_phone_number_id) values ($1, $2)',
        [tenant.id, main.rowId],
      ),
    );
  const contact = await database.fixtures.contact(tenant.context);
  const phone = fictional();
  const identity = await database.withTenant(tenant.context, (sql) =>
    sql.one<{ id: string }>(
      "insert into crm.contact_identities (business_id,contact_id,kind,value,value_normalized,is_primary) values (app.business_id(),$1,'phone',$2,$2,true) returning id",
      [contact.id, phone],
    ),
  );
  const query = <T extends object>(text: string, values: readonly unknown[] = []) =>
    database.withTenant(tenant.context, (sql) => sql.query<T>(text, values));
  const request = async (body: Record<string, unknown> = {}, as = invocation) =>
    callSchema.parse(
      await run('requestCall', as, {
        body: {
          contactIdentityId: toPublicId('contact_identity', identity.id),
          idempotencyKey: key(),
          ...body,
        },
      }),
    );
  return {
    agency,
    tenant,
    user,
    accountSid,
    membershipId: toPublicId('membership', membership.id),
    connectionId: connection.id,
    context,
    invocation,
    system,
    job: { invocation: system, services },
    main,
    number,
    contact,
    phone,
    identity,
    query,
    request,
  };
}

/** A provider stand-in: answers in turn, and records every request. */
function provider(answers: { place?: CallProviderResult | Error; end?: CallProviderResult } = {}) {
  const placed: PlacedCall[] = [];
  const ended: EndedCall[] = [];
  const port: CallProvider = {
    place(call) {
      placed.push(call);
      const answer = answers.place ?? {
        outcome: 'accepted',
        providerCallId: sid(),
        status: 'queued',
      };
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    end(call) {
      ended.push(call);
      return Promise.resolve(
        answers.end ?? {
          outcome: 'accepted',
          providerCallId: call.providerCallId,
          status: 'canceled',
        },
      );
    },
  };
  return { port, placed, ended };
}

const rowId = (call: Call) => parsePublicId('call', call.id) ?? '';
const read = async (b: Awaited<ReturnType<typeof business>>, call: Call) =>
  callDetail.parse(await run('getCall', b.invocation, { params: { id: call.id } }));
const progress = (
  b: Awaited<ReturnType<typeof business>>,
  callSid: string,
  sequence: number,
  status: VoiceProgress['status'],
  extra: Partial<VoiceProgress> = {},
): VoiceProgress => ({
  accountSid: b.accountSid,
  callSid,
  parentSid: null,
  status,
  from: b.main.e164,
  to: b.phone,
  direction: 'outbound-api',
  sequence,
  durationSeconds: null,
  ...extra,
});
const report = (
  b: Awaited<ReturnType<typeof business>>,
  legId: string,
  value: VoiceProgress,
  connectionId = b.connectionId,
) =>
  withTenant(db, b.context, (trx) =>
    recordCallProgress(trx, { legId, connectionId, progress: value }),
  );
const rootLeg = async (b: Awaited<ReturnType<typeof business>>, call: Call) => {
  const [leg] = await b.query<{ id: string; provider_call_sid: string | null; status: string }>(
    'select id, provider_call_sid, status from messaging.call_legs where call_id=$1 and parent_leg_id is null',
    [rowId(call)],
  );
  if (leg === undefined) throw new Error('No first leg.');
  return leg;
};
const remoteLeg = async (b: Awaited<ReturnType<typeof business>>, call: Call) => {
  const [leg] = await b.query<{ id: string; provider_call_sid: string | null; status: string }>(
    'select id, provider_call_sid, status from messaging.call_legs where call_id=$1 and parent_leg_id is not null',
    [rowId(call)],
  );
  if (leg === undefined) throw new Error('No child leg.');
  return leg;
};
const jobs = (taskName: string, callId: string) =>
  database.as('postgres', (sql) =>
    sql.query<{ payload: unknown }>(
      `select p.payload from graphile_worker.jobs j join graphile_worker._private_jobs p on p.id=j.id
       where j.task_identifier=$1 and p.payload->'data'->>'callId'=$2`,
      [taskName, callId],
    ),
  );

describe('requesting a call', () => {
  it('stores a requested call from the default number, queues the worker once, and answers a retry with the same call', async () => {
    const b = await business();
    const idempotencyKey = key();
    const first = await b.request({ idempotencyKey });
    expect(first).toMatchObject({
      direction: 'outbound',
      state: 'requested',
      outcome: null,
      phoneNumberId: b.main.id,
      localNumber: b.main.e164,
      remoteNumber: b.phone,
      contactId: toPublicId('contact', b.contact.id),
      membershipId: b.membershipId,
      connectedAt: null,
    });
    expect(await b.request({ idempotencyKey })).toEqual(first);
    await expect(
      b.request({ idempotencyKey, phoneNumberId: (await b.number()).id }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await jobs('calls.place', rowId(first))).toHaveLength(1);
    const [event] = await b.query<{ type: string }>(
      "select type from events.events where subject_id=$1 and type='call.requested'",
      [rowId(first)],
    );
    expect(event?.type).toBe('call.requested');
  });

  it('refuses what cannot be called, storing nothing', async () => {
    const b = await business();
    expect(
      await refusal(
        b.request({}, { ...b.invocation, context: { ...b.context, actorKind: 'api_key' } }),
      ),
    ).toEqual(['user_required']);
    expect(
      await refusal(
        run(
          'requestCall',
          b.invocation,
          {
            body: {
              contactIdentityId: toPublicId('contact_identity', b.identity.id),
              idempotencyKey: key(),
            },
          },
          unavailable,
        ),
      ),
    ).toEqual(['calling_unavailable']);
    expect(await refusal(b.request({ phoneNumberId: (await b.number(['sms'])).id }))).toEqual([
      'number_unavailable',
    ]);
    expect(
      await refusal(b.request({ contactIdentityId: toPublicId('contact_identity', UNKNOWN) })),
    ).toEqual(['contact_unavailable']);
    await b.query("update crm.contacts set dnd_channels='{call}' where id=$1", [b.contact.id]);
    expect(await refusal(b.request())).toEqual(['do_not_call']);
    await b.query("update crm.contacts set dnd_channels='{}' where id=$1", [b.contact.id]);
    await b.query(
      "insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind,address_normalized) values (app.business_id(),$1,'call','transactional','withdrawn','user','system',$2)",
      [b.contact.id, b.phone],
    );
    expect(await refusal(b.request())).toEqual(['call_consent_withdrawn']);
    const other = await business();
    await database.as('crm_owner', (sql) =>
      sql.query("update messaging.provider_connections set status='failing' where id=$1", [
        other.connectionId,
      ]),
    );
    expect(await refusal(other.request())).toEqual(['connection_unavailable']);
    expect(await b.query('select id from messaging.calls')).toEqual([]);
  });

  it('needs a number when the business has no default one', async () => {
    const b = await business({ defaultNumber: false });
    expect(await refusal(b.request())).toEqual(['number_required']);
    expect((await b.request({ phoneNumberId: b.main.id })).state).toBe('requested');
  });
});

describe('placing a call', () => {
  it('reserves, asks the provider once and records the call as dialing, never connected', async () => {
    const b = await business();
    const call = await b.request();
    const fake = provider();
    const place = createPlaceCallTask(fake.port, callerAccess);
    await place.run({ callId: rowId(call) }, b.job);
    await place.run({ callId: rowId(call) }, b.job);
    const root = await rootLeg(b, call);
    const remote = await remoteLeg(b, call);
    expect(fake.placed).toEqual([
      expect.objectContaining({
        legId: root.id,
        remoteLegId: remote.id,
        identity: voiceIdentity(b.tenant.id, b.user.id),
        from: b.main.e164,
        to: b.phone,
        userId: b.user.id,
        connectionId: b.connectionId,
      }),
    ]);
    const detail = await read(b, call);
    expect(detail).toMatchObject({ state: 'dialing', connectedAt: null });
    expect(detail.legs).toEqual([
      expect.objectContaining({
        party: 'member',
        status: 'queued',
        providerDirection: 'outbound-api',
      }),
      expect.objectContaining({
        party: 'remote',
        status: 'reserved',
      }),
    ]);
  });

  it('turns a lost answer into unknown, and a run after a reservation never places again', async () => {
    const b = await business();
    const call = await b.request();
    const lost = provider({ place: new Error('socket hang up') });
    await createPlaceCallTask(lost.port, callerAccess).run({ callId: rowId(call) }, b.job);
    expect((await read(b, call)).state).toBe('unknown');
    await createPlaceCallTask(lost.port, callerAccess).run({ callId: rowId(call) }, b.job);
    expect(lost.placed).toHaveLength(1);

    // A second run while the first awaits the provider finds the reservation: unknown.
    const again = await b.request();
    let inner: Promise<void> | undefined;
    const reentrant: CallProvider = {
      place: async () => {
        inner = createPlaceCallTask(lost.port, callerAccess).run({ callId: rowId(again) }, b.job);
        await inner;
        expect((await read(b, again)).state).toBe('unknown');
        return { outcome: 'accepted', providerCallId: sid(), status: 'queued' };
      },
      end: () => Promise.resolve({ outcome: 'unknown' }),
    };
    await createPlaceCallTask(reentrant, callerAccess).run({ callId: rowId(again) }, b.job);
    expect(lost.placed).toHaveLength(1);
    // The answer that did arrive settles it.
    expect((await read(b, again)).state).toBe('dialing');
  });

  it('records a provider rejection as rejected, with nothing placed', async () => {
    const b = await business();
    const call = await b.request();
    await createPlaceCallTask(
      provider({ place: { outcome: 'rejected', code: 21215 } }).port,
      callerAccess,
    ).run({ callId: rowId(call) }, b.job);
    expect(await read(b, call)).toMatchObject({ state: 'rejected', failure: 'provider_rejected' });
  });

  it('checks again before reserving: a contact who opted out in between is never rung', async () => {
    const b = await business();
    const call = await b.request();
    await b.query('update crm.contacts set do_not_contact=true where id=$1', [b.contact.id]);
    const fake = provider();
    await createPlaceCallTask(fake.port, callerAccess).run({ callId: rowId(call) }, b.job);
    expect(fake.placed).toEqual([]);
    expect(await read(b, call)).toMatchObject({
      state: 'refused',
      failure: 'do_not_call',
      legs: [],
    });

    await b.query('update crm.contacts set do_not_contact=false where id=$1', [b.contact.id]);
    const moved = await b.request();
    await b.query('update crm.contact_identities set value=$2, value_normalized=$2 where id=$1', [
      b.identity.id,
      fictional(),
    ]);
    await createPlaceCallTask(fake.port, callerAccess).run({ callId: rowId(moved) }, b.job);
    expect(fake.placed).toEqual([]);
    expect(await read(b, moved)).toMatchObject({ state: 'refused', failure: 'number_unavailable' });
  });
});

describe('progress reports', () => {
  async function dialing() {
    const b = await business();
    const call = await b.request();
    const callSid = sid();
    await createPlaceCallTask(
      provider({ place: { outcome: 'accepted', providerCallId: callSid, status: 'queued' } }).port,
      callerAccess,
    ).run({ callId: rowId(call) }, b.job);
    return {
      b,
      call,
      callSid,
      leg: await rootLeg(b, call),
      remote: await remoteLeg(b, call),
    };
  }

  it('moves a call through ringing, connected and ended, once per report and never backwards', async () => {
    const { b, call, callSid, leg, remote } = await dialing();
    const contactSid = sid();
    const dial = { direction: 'outbound-dial' as const, parentSid: callSid, to: b.phone };

    expect((await report(b, leg.id, progress(b, callSid, 1, 'ringing'))).result).toBe('advanced');
    expect((await read(b, call)).state).toBe('dialing');
    expect((await report(b, leg.id, progress(b, callSid, 1, 'ringing'))).result).toBe('duplicate');

    expect((await report(b, leg.id, progress(b, callSid, 2, 'in-progress'))).result).toBe(
      'advanced',
    );
    expect((await read(b, call)).state).toBe('dialing');
    expect((await report(b, leg.id, progress(b, callSid, 0, 'initiated'))).result).toBe('stale');

    expect((await report(b, remote.id, progress(b, contactSid, 1, 'ringing', dial))).result).toBe(
      'advanced',
    );
    expect((await read(b, call)).state).toBe('ringing');

    expect(
      (await report(b, remote.id, progress(b, contactSid, 2, 'in-progress', dial))).result,
    ).toBe('advanced');
    const connected = await read(b, call);
    expect(connected.state).toBe('connected');
    expect(connected.connectedAt).not.toBeNull();

    expect(
      (
        await report(
          b,
          remote.id,
          progress(b, contactSid, 3, 'completed', { ...dial, durationSeconds: 42 }),
        )
      ).result,
    ).toBe('advanced');
    expect(
      (await report(b, leg.id, progress(b, callSid, 3, 'completed', { durationSeconds: 45 })))
        .result,
    ).toBe('advanced');
    expect(await read(b, call)).toMatchObject({
      state: 'ended',
      outcome: 'completed',
      needsReconciliation: false,
      legs: [
        expect.objectContaining({ status: 'completed' }),
        expect.objectContaining({ status: 'completed', durationSeconds: 42 }),
      ],
    });
  });

  it('ends an unanswered call with the provider’s outcome', async () => {
    const { b, call, callSid, leg, remote } = await dialing();
    await report(b, leg.id, progress(b, callSid, 1, 'ringing'));
    await report(b, leg.id, progress(b, callSid, 2, 'no-answer'));
    expect(await read(b, call)).toMatchObject({
      state: 'ended',
      outcome: 'no_answer',
      connectedAt: null,
      legs: [
        expect.objectContaining({ status: 'no-answer' }),
        expect.objectContaining({ id: toPublicId('call_leg', remote.id), status: 'canceled' }),
      ],
    });
  });

  it('ends a call where the contact is busy with outcome busy', async () => {
    const { b, call, callSid, leg, remote } = await dialing();
    const contactSid = sid();
    const dial = { direction: 'outbound-dial' as const, parentSid: callSid, to: b.phone };
    await report(b, leg.id, progress(b, callSid, 1, 'in-progress'));
    await report(b, remote.id, progress(b, contactSid, 1, 'busy', dial));
    await report(b, leg.id, progress(b, callSid, 2, 'completed'));
    expect(await read(b, call)).toMatchObject({
      state: 'ended',
      outcome: 'busy',
      connectedAt: null,
      legs: [
        expect.objectContaining({ status: 'completed' }),
        expect.objectContaining({ id: toPublicId('call_leg', remote.id), status: 'busy' }),
      ],
    });
  });

  it('ends a call as failed when the browser answered but the contact was never dialed', async () => {
    const { b, call, callSid, leg, remote } = await dialing();
    await report(b, leg.id, progress(b, callSid, 1, 'in-progress'));
    await report(b, leg.id, progress(b, callSid, 2, 'completed'));
    expect(await read(b, call)).toMatchObject({
      state: 'ended',
      outcome: 'failed',
      connectedAt: null,
      legs: [
        expect.objectContaining({ status: 'completed' }),
        expect.objectContaining({ id: toPublicId('call_leg', remote.id), status: 'canceled' }),
      ],
    });
  });

  it('marks contradictions for reconciliation instead of guessing', async () => {
    const { b, call, callSid, leg } = await dialing();
    await report(b, leg.id, progress(b, callSid, 1, 'ringing'));
    expect((await report(b, leg.id, progress(b, callSid, 1, 'busy'))).result).toBe('conflict');
    expect((await report(b, leg.id, progress(b, sid(), 2, 'ringing'))).result).toBe('conflict');
    const detail = await read(b, call);
    expect(detail.needsReconciliation).toBe(true);
    expect(detail.legs[0]?.conflict).toBe(true);
    expect(detail.state).toBe('dialing');
  });

  it('checks provider identity before deduplicating or reserving a progress sequence', async () => {
    const { b, callSid, leg } = await dialing();
    await report(b, leg.id, progress(b, callSid, 1, 'ringing'));
    expect((await report(b, leg.id, progress(b, sid(), 1, 'ringing'))).result).toBe('conflict');
    expect((await report(b, leg.id, progress(b, sid(), 2, 'in-progress'))).result).toBe('conflict');
    expect((await report(b, leg.id, progress(b, callSid, 2, 'in-progress'))).result).toBe(
      'advanced',
    );
  });

  it('refuses a report for a leg of another connection or business', async () => {
    const { b, callSid, leg } = await dialing();
    const other = await business();
    expect(
      (await report(b, leg.id, progress(b, callSid, 1, 'ringing'), other.connectionId)).result,
    ).toBe('unknown_leg');
    expect(
      (await report(other, leg.id, progress(b, callSid, 1, 'ringing'), b.connectionId)).result,
    ).toBe('unknown_leg');
  });

  it('settles an unknown call from the provider’s first report, without placing it again', async () => {
    const b = await business();
    const call = await b.request();
    await createPlaceCallTask(provider({ place: { outcome: 'unknown' } }).port, callerAccess).run(
      { callId: rowId(call) },
      b.job,
    );
    const leg = await rootLeg(b, call);
    expect(leg).toMatchObject({ status: 'unknown', provider_call_sid: null });
    const callSid = sid();
    expect((await report(b, leg.id, progress(b, callSid, 0, 'initiated'))).result).toBe('advanced');
    expect(await read(b, call)).toMatchObject({
      state: 'dialing',
      legs: [
        expect.objectContaining({ providerCallId: callSid, status: 'initiated' }),
        expect.objectContaining({ party: 'remote', status: 'reserved' }),
      ],
    });
  });

  it('adds dialed legs that name their parent, and reports a member leg answering without connecting the call', async () => {
    const { b, call, callSid, leg } = await dialing();
    const child = await withTenant(db, b.context, (trx) =>
      addCallLeg(trx, {
        callId: rowId(call),
        parentLegId: leg.id,
        party: 'member',
        userId: b.user.id,
        to: 'client:agent',
      }),
    );
    if (child === null) throw new Error('The leg was not added.');
    const childSid = sid();
    const dial = { direction: 'outbound-dial', parentSid: callSid, to: 'client:agent' } as const;
    expect((await report(b, child, progress(b, childSid, 0, 'in-progress', dial))).result).toBe(
      'advanced',
    );
    const detail = await read(b, call);
    expect(detail.state).toBe('dialing');
    expect(detail.legs[2]).toMatchObject({
      party: 'member',
      membershipId: b.membershipId,
      status: 'in-progress',
    });
    expect(
      (await report(b, child, progress(b, childSid, 1, 'completed', { ...dial, parentSid: sid() })))
        .result,
    ).toBe('conflict');
    expect(
      await withTenant(db, b.context, (trx) =>
        addCallLeg(trx, {
          callId: rowId(call),
          parentLegId: UNKNOWN,
          party: 'remote',
          userId: null,
          to: b.phone,
        }),
      ),
    ).toBeNull();
  });
});

describe('hanging up', () => {
  it('finishes a queued cancellation from the terminal REST response without waiting for a callback', async () => {
    const b = await business();
    const call = await b.request();
    const callSid = sid();
    const fake = provider({
      place: { outcome: 'accepted', providerCallId: callSid, status: 'queued' },
    });
    await createPlaceCallTask(fake.port, callerAccess).run({ callId: rowId(call) }, b.job);
    await run('hangUpCall', b.invocation, { params: { id: call.id } });
    await createEndCallTask(fake.port).run({ callId: rowId(call) }, b.job);
    expect(await read(b, call)).toMatchObject({
      state: 'ended',
      outcome: 'canceled',
      connectedAt: null,
      needsReconciliation: false,
      legs: [
        expect.objectContaining({ status: 'canceled' }),
        expect.objectContaining({ status: 'canceled' }),
      ],
    });
  });

  it('keeps terminal progress that crosses an end response and flags contradictory results', async () => {
    for (const agrees of [false, true]) {
      const b = await business();
      const call = await b.request();
      const callSid = sid();
      const fake = provider({
        place: { outcome: 'accepted', providerCallId: callSid, status: 'queued' },
      });
      await createPlaceCallTask(fake.port, callerAccess).run({ callId: rowId(call) }, b.job);
      const leg = await rootLeg(b, call);
      await run('hangUpCall', b.invocation, { params: { id: call.id } });
      const crossed: CallProvider = {
        ...fake.port,
        async end() {
          await report(b, leg.id, progress(b, callSid, 3, 'busy'));
          return {
            outcome: 'accepted',
            providerCallId: callSid,
            status: agrees ? 'busy' : 'canceled',
          };
        },
      };
      await createEndCallTask(crossed).run({ callId: rowId(call) }, b.job);
      expect(await read(b, call)).toMatchObject({
        state: 'ended',
        outcome: 'busy',
        needsReconciliation: !agrees,
        legs: [
          expect.objectContaining({ status: 'busy', conflict: !agrees }),
          expect.objectContaining({ status: 'canceled' }),
        ],
      });
    }
  });

  it('refuses an end response naming another provider call', async () => {
    const b = await business();
    const call = await b.request();
    const fake = provider({
      end: { outcome: 'accepted', providerCallId: sid(), status: 'canceled' },
    });
    await createPlaceCallTask(fake.port, callerAccess).run({ callId: rowId(call) }, b.job);
    await run('hangUpCall', b.invocation, { params: { id: call.id } });
    await createEndCallTask(fake.port).run({ callId: rowId(call) }, b.job);
    expect(await read(b, call)).toMatchObject({ state: 'dialing', needsReconciliation: true });
  });

  it('cancels a call not yet placed; the worker then leaves it alone', async () => {
    const b = await business();
    const call = await b.request();
    const canceled = callSchema.parse(
      await run('hangUpCall', b.invocation, { params: { id: call.id } }),
    );
    expect(canceled).toMatchObject({ state: 'canceled', hangUpRequested: true });
    const fake = provider();
    await createPlaceCallTask(fake.port, callerAccess).run({ callId: rowId(call) }, b.job);
    expect(fake.placed).toEqual([]);
  });

  it('asks the worker to end a placed call: canceled while ringing, completed once answered', async () => {
    const b = await business();
    const fake = provider();
    for (const answered of [false, true]) {
      const call = await b.request();
      const callSid = sid();
      await createPlaceCallTask(
        provider({ place: { outcome: 'accepted', providerCallId: callSid, status: 'queued' } })
          .port,
        callerAccess,
      ).run({ callId: rowId(call) }, b.job);
      if (answered) {
        await report(b, (await rootLeg(b, call)).id, progress(b, callSid, 1, 'in-progress'));
        const remote = await remoteLeg(b, call);
        await report(
          b,
          remote.id,
          progress(b, sid(), 1, 'in-progress', {
            direction: 'outbound-dial',
            parentSid: callSid,
            to: b.phone,
          }),
        );
      }
      const asked = callSchema.parse(
        await run('hangUpCall', b.invocation, { params: { id: call.id } }),
      );
      expect(asked).toMatchObject({
        hangUpRequested: true,
        state: answered ? 'connected' : 'dialing',
      });
      // A second press asks nothing more.
      await run('hangUpCall', b.invocation, { params: { id: call.id } });
      expect(await jobs('calls.end', rowId(call))).toHaveLength(1);
      await createEndCallTask(fake.port).run({ callId: rowId(call) }, b.job);
      await createEndCallTask(fake.port).run({ callId: rowId(call) }, b.job);
      expect(fake.ended.at(-1)).toEqual({
        callId: rowId(call),
        connectionId: b.connectionId,
        providerCallId: callSid,
        status: answered ? 'completed' : 'canceled',
      });
    }
    expect(fake.ended).toHaveLength(2);
  });

  it('waits for the provider’s id before ending an unknown call, then says a hang-up is waiting', async () => {
    const b = await business();
    const call = await b.request();
    await createPlaceCallTask(provider({ place: { outcome: 'unknown' } }).port, callerAccess).run(
      { callId: rowId(call) },
      b.job,
    );
    await run('hangUpCall', b.invocation, { params: { id: call.id } });
    const fake = provider();
    await createEndCallTask(fake.port).run({ callId: rowId(call) }, b.job);
    expect(fake.ended).toEqual([]);
    const answer = await report(b, (await rootLeg(b, call)).id, progress(b, sid(), 1, 'ringing'));
    expect(answer).toMatchObject({ result: 'advanced', hangUpWaiting: true });
  });

  it('lets a person end only their own calls unless they manage the phone system', async () => {
    const b = await business();
    const call = await b.request();
    const colleague = await database.fixtures.user();
    const as = (permissions: Invocation['permissions']): Invocation => ({
      context: { ...b.context, actorId: colleague.id, userId: colleague.id },
      permissions,
    });
    await expect(
      run('hangUpCall', as(new Set(['calls.place'])), { params: { id: call.id } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      callSchema.parse(
        await run('hangUpCall', as(new Set(['calls.place', 'phone.manage'])), {
          params: { id: call.id },
        }),
      ).state,
    ).toBe('canceled');
  });
});

describe('reading calls', () => {
  it('pages newest first with filters, and never shows another business’s calls', async () => {
    const b = await business();
    const made = [];
    for (let index = 0; index < 3; index += 1) made.push(await b.request());
    const first = callList.parse(await run('listCalls', b.invocation, { query: { limit: '2' } }));
    expect(first.items.map(({ id }) => id)).toEqual([made[2]?.id, made[1]?.id]);
    const second = callList.parse(
      await run('listCalls', b.invocation, { query: { limit: '2', after: first.nextCursor } }),
    );
    expect(second).toEqual({ items: [made[0]], nextCursor: null });
    const inbound = callList.parse(
      await run('listCalls', b.invocation, { query: { direction: 'inbound' } }),
    );
    expect(inbound.items).toEqual([]);
    const byContact = callList.parse(
      await run('listCalls', b.invocation, {
        query: { contactId: toPublicId('contact', UNKNOWN) },
      }),
    );
    expect(byContact.items).toEqual([]);

    const other = await business();
    expect(callList.parse(await run('listCalls', other.invocation)).items).toEqual([]);
    await expect(
      run('getCall', other.invocation, { params: { id: made[0]?.id } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      run('hangUpCall', other.invocation, { params: { id: made[0]?.id } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(run('listCalls', b.invocation, { query: { limit: '51' } })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('inbound calls', () => {
  it('records an account-bound final number callback without inventing a progress sequence', async () => {
    const b = await business();
    const callSid = sid();
    const inbound = {
      phoneNumberId: b.main.rowId,
      connectionId: b.connectionId,
      providerCallId: callSid,
      from: b.phone,
      to: b.main.e164,
    };
    const first = await withTenant(db, b.context, (trx) =>
      recordInboundCall(trx, b.context, inbound),
    );
    if (first === null) throw new Error('Not recorded.');
    const terminal = {
      accountSid: b.accountSid,
      callSid,
      from: b.phone,
      to: b.main.e164,
      direction: 'inbound' as const,
      status: 'completed' as const,
      durationSeconds: 12,
    };
    const finish = (value = terminal, connectionId = b.connectionId) =>
      withTenant(db, b.context, (trx) =>
        recordInboundTerminal(trx, { connectionId, terminal: value }),
      );
    expect(await finish({ ...terminal, from: '+12025550199' })).toMatchObject({
      result: 'unknown_leg',
    });
    expect(await finish({ ...terminal, accountSid: `AC${'9'.repeat(32)}` })).toMatchObject({
      result: 'unknown_leg',
    });
    const other = await business();
    expect(await finish(terminal, other.connectionId)).toMatchObject({ result: 'unknown_leg' });
    expect(await finish()).toEqual({ result: 'advanced', callId: first.callId });
    expect(await finish()).toEqual({ result: 'duplicate', callId: first.callId });
    expect(await finish({ ...terminal, durationSeconds: 13 })).toEqual({
      result: 'conflict',
      callId: first.callId,
    });
    const recorded = await withTenant(db, b.context, (trx) =>
      readCallDetail(trx, toPublicId('call', first.callId)),
    );
    expect(recorded).toMatchObject({
      state: 'ended',
      outcome: 'no_answer',
      needsReconciliation: true,
      legs: [expect.objectContaining({ status: 'completed', durationSeconds: 12 })],
    });
    expect(
      await b.query('select sequence from messaging.call_progress where leg_id=$1', [first.legId]),
    ).toEqual([]);
  });

  it('recognizes a completed member leg when its answered report is delayed or missing', async () => {
    for (const parentFirst of [false, true]) {
      const b = await business();
      const callSid = sid();
      const childSid = sid();
      const first = await withTenant(db, b.context, (trx) =>
        recordInboundCall(trx, b.context, {
          phoneNumberId: b.main.rowId,
          connectionId: b.connectionId,
          providerCallId: callSid,
          from: b.phone,
          to: b.main.e164,
        }),
      );
      if (first === null) throw new Error('Not recorded.');
      const member = await withTenant(db, b.context, (trx) =>
        addCallLeg(trx, {
          callId: first.callId,
          parentLegId: first.legId,
          party: 'member',
          userId: b.user.id,
          to: 'client:member',
        }),
      );
      if (member === null) throw new Error('No member leg.');
      const parent = () =>
        report(
          b,
          first.legId,
          progress(b, callSid, 3, 'completed', {
            direction: 'inbound',
            from: b.phone,
            to: b.main.e164,
          }),
        );
      const dial = { direction: 'outbound-dial', parentSid: callSid } as const;
      if (parentFirst) await parent();
      await report(
        b,
        member,
        progress(b, childSid, 3, 'completed', {
          ...dial,
          durationSeconds: 8,
        }),
      );
      expect((await report(b, member, progress(b, childSid, 2, 'in-progress', dial))).result).toBe(
        'stale',
      );
      if (!parentFirst) await parent();
      const recorded = await withTenant(db, b.context, (trx) =>
        readCallDetail(trx, toPublicId('call', first.callId)),
      );
      expect(recorded).toMatchObject({ state: 'ended', outcome: 'completed' });
    }
  });
  it('records a call once per provider id, matched to the caller’s contact', async () => {
    const b = await business();
    const callSid = sid();
    const inbound = {
      phoneNumberId: b.main.rowId,
      connectionId: b.connectionId,
      providerCallId: callSid,
      from: b.phone,
      to: b.main.e164,
    };
    const first = await withTenant(db, b.context, (trx) =>
      recordInboundCall(trx, b.context, inbound),
    );
    const again = await withTenant(db, b.context, (trx) =>
      recordInboundCall(trx, b.context, inbound),
    );
    expect(again).toEqual(first);
    const [listed] = callList.parse(
      await run('listCalls', b.invocation, { query: { direction: 'inbound' } }),
    ).items;
    expect(listed).toMatchObject({
      direction: 'inbound',
      state: 'ringing',
      remoteNumber: b.phone,
      contactId: toPublicId('contact', b.contact.id),
      membershipId: null,
    });
    if (first === null || listed === undefined) throw new Error('Not recorded.');
    await report(
      b,
      first.legId,
      progress(b, callSid, 1, 'in-progress', {
        direction: 'inbound',
        from: b.phone,
        to: b.main.e164,
      }),
    );
    // The provider answers an inbound call itself; it connects when a member answers.
    const inbound2 = { direction: 'inbound', from: b.phone, to: b.main.e164 } as const;
    expect((await read(b, listed)).state).toBe('ringing');
    const member = await withTenant(db, b.context, (trx) =>
      addCallLeg(trx, {
        callId: first.callId,
        parentLegId: first.legId,
        party: 'member',
        userId: b.user.id,
        to: 'client:member',
      }),
    );
    if (member === null) throw new Error('No member leg.');
    await report(
      b,
      member,
      progress(b, sid(), 0, 'in-progress', { direction: 'outbound-dial', parentSid: callSid }),
    );
    expect((await read(b, listed)).state).toBe('connected');
    await report(b, first.legId, progress(b, callSid, 2, 'completed', inbound2));
    expect(await read(b, listed)).toMatchObject({ state: 'ended', outcome: 'completed' });

    // A caller who hides their number and hangs up before anyone answers was missed.
    const hiddenSid = sid();
    const hidden = await withTenant(db, b.context, (trx) =>
      recordInboundCall(trx, b.context, { ...inbound, providerCallId: hiddenSid, from: '' }),
    );
    if (hidden === null) throw new Error('Not recorded.');
    await report(
      b,
      hidden.legId,
      progress(b, hiddenSid, 1, 'completed', { ...inbound2, from: 'anonymous' }),
    );
    const missed = await read(b, { ...listed, id: toPublicId('call', hidden.callId) });
    expect(missed).toMatchObject({
      state: 'ended',
      outcome: 'no_answer',
      contactId: null,
      remoteNumber: null,
    });
    // A key may end any call; one with no contact has no timeline to write to.
    const other = await withTenant(db, b.context, (trx) =>
      recordInboundCall(trx, b.context, { ...inbound, providerCallId: sid(), from: '' }),
    );
    if (other === null) throw new Error('Not recorded.');
    const asKey: Invocation = {
      context: { ...b.system.context, actorKind: 'api_key' },
      permissions: 'all',
    };
    expect(
      callSchema.parse(
        await run('hangUpCall', asKey, { params: { id: toPublicId('call', other.callId) } }),
      ).hangUpRequested,
    ).toBe(true);
    expect(
      await withTenant(db, b.context, (trx) =>
        recordInboundCall(trx, b.context, { ...inbound, providerCallId: sid(), to: fictional() }),
      ),
    ).toBeNull();
  });
});

describe('provider answers that cross progress reports', () => {
  /** Places a call whose provider reports progress before it answers the request. */
  async function crossed(answer: (callSid: string) => CallProviderResult) {
    const b = await business();
    const call = await b.request();
    const firstSid = sid();
    const port: CallProvider = {
      place: async (placed) => {
        await report(b, placed.legId, progress(b, firstSid, 1, 'ringing'));
        return answer(firstSid);
      },
      end: () => Promise.resolve({ outcome: 'unknown' }),
    };
    await createPlaceCallTask(port, callerAccess).run({ callId: rowId(call) }, b.job);
    return read(b, call);
  }

  it('keeps the report status when the same call is accepted, and flags any contradiction', async () => {
    expect(
      await crossed((callSid) => ({
        outcome: 'accepted',
        providerCallId: callSid,
        status: 'queued',
      })),
    ).toMatchObject({
      state: 'dialing',
      needsReconciliation: false,
      legs: [
        expect.objectContaining({ status: 'ringing' }),
        expect.objectContaining({ status: 'reserved' }),
      ],
    });
    expect(await crossed(() => ({ outcome: 'unknown' }))).toMatchObject({
      state: 'dialing',
      needsReconciliation: false,
    });
    expect(await crossed(() => ({ outcome: 'rejected', code: null }))).toMatchObject({
      state: 'dialing',
      needsReconciliation: true,
    });
    expect(
      await crossed(() => ({ outcome: 'accepted', providerCallId: sid(), status: 'queued' })),
    ).toMatchObject({ needsReconciliation: true });
  });

  it('flags a provider id another leg holds, and ends a call accepted as already over', async () => {
    const b = await business();
    const shared = sid();
    const fixed = provider({
      place: { outcome: 'accepted', providerCallId: shared, status: 'queued' },
    });
    const first = await b.request();
    const second = await b.request();
    await createPlaceCallTask(fixed.port, callerAccess).run({ callId: rowId(first) }, b.job);
    await createPlaceCallTask(fixed.port, callerAccess).run({ callId: rowId(second) }, b.job);
    expect((await read(b, second)).needsReconciliation).toBe(true);
    const lost = await b.request();
    await createPlaceCallTask(provider({ place: { outcome: 'unknown' } }).port, callerAccess).run(
      { callId: rowId(lost) },
      b.job,
    );
    expect(
      (await report(b, (await rootLeg(b, lost)).id, progress(b, shared, 1, 'ringing'))).result,
    ).toBe('conflict');

    const over = await b.request();
    await createPlaceCallTask(
      provider({ place: { outcome: 'accepted', providerCallId: sid(), status: 'canceled' } }).port,
      callerAccess,
    ).run({ callId: rowId(over) }, b.job);
    expect(await read(b, over)).toMatchObject({ state: 'ended', outcome: 'canceled' });
    expect(
      await withTenant(db, b.context, (trx) =>
        addCallLeg(trx, {
          callId: rowId(over),
          parentLegId: UNKNOWN,
          party: 'remote',
          userId: null,
          to: b.phone,
        }),
      ),
    ).toBeNull();
  });

  it('flags a second ending that contradicts the first, and ignores tasks for missing calls', async () => {
    const b = await business();
    const call = await b.request();
    const callSid = sid();
    await createPlaceCallTask(
      provider({ place: { outcome: 'accepted', providerCallId: callSid, status: 'queued' } }).port,
      callerAccess,
    ).run({ callId: rowId(call) }, b.job);
    const leg = await rootLeg(b, call);
    await report(b, leg.id, progress(b, callSid, 3, 'completed'));
    expect((await report(b, leg.id, progress(b, callSid, 4, 'busy'))).result).toBe('conflict');
    const fake = provider();
    await createPlaceCallTask(fake.port, callerAccess).run({ callId: UNKNOWN }, b.job);
    await createEndCallTask(fake.port).run({ callId: UNKNOWN }, b.job);
    expect([...fake.placed, ...fake.ended]).toEqual([]);
    await expect(
      withTenant(db, b.context, (trx) => readCallDetail(trx, 'call_x')),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses at reservation when the phone identity is gone or the member is disabled', async () => {
    const b = await business();
    const fake = provider();
    const gone = await b.request();
    await b.query('delete from crm.contact_identities where id=$1', [b.identity.id]);
    await createPlaceCallTask(fake.port, callerAccess).run({ callId: rowId(gone) }, b.job);
    expect(await read(b, gone)).toMatchObject({
      state: 'refused',
      failure: 'contact_unavailable',
      contactIdentityId: null,
    });

    const c = await business();
    const disabled = await c.request();
    await database.as('crm_auth', (sql) =>
      sql.query('update auth.users set disabled_at=now() where id=$1', [c.user.id]),
    );
    await createPlaceCallTask(fake.port, callerAccess).run({ callId: rowId(disabled) }, c.job);
    expect(await read(c, disabled)).toMatchObject({
      state: 'refused',
      failure: 'member_unavailable',
      membershipId: null,
    });
    expect(fake.placed).toEqual([]);
  });
});
