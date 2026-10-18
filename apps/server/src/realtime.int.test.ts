import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { allowEveryone, defineCommand, runCommand } from '@repo/commands';
import { connectDatabase, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import type { Authentication, SignedIn } from '@repo/module-auth';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';
import { startRealtime } from './realtime.js';

function socketEvent(socket: Socket, event: string, timeoutMs = 1000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, receive);
      reject(new Error(`Timed out waiting for ${event}.`));
    }, timeoutMs);
    function receive(...args: unknown[]) {
      clearTimeout(timer);
      resolve(args);
    }
    socket.once(event, receive);
  });
}

let database: TestDatabase;
let db: Database;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

// Sign-in is a boundary here; the two-tab browser test also uses real cookie sign-in.
async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const other = await database.fixtures.business(agency.id);
  let allowed = true;
  let signedIn = true;
  let twoFactorRequired = false;
  let twoFactorEnabled = false;
  let agencyId: string | undefined = agency.id;
  let broken = false;
  const person: SignedIn = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    agencyId: agency.id,
    memberOf: [business.id, other.id],
    agencyStaff: false,
    roles: { agency: undefined, businesses: new Map() },
    twoFactorEnabled: false,
    twoFactorRequired: false,
  };
  const authentication: Pick<Authentication, 'signedIn' | 'workplace'> = {
    signedIn: (headers) =>
      broken
        ? Promise.reject(new Error('Authentication down.'))
        : Promise.resolve(
            signedIn && headers.get('cookie') === 'test=session'
              ? { ...person, twoFactorRequired, twoFactorEnabled, agencyId }
              : undefined,
          ),
    workplace: (_person, id) =>
      Promise.resolve(
        allowed && (id === business.id || id === other.id)
          ? { at: 'business', businessId: id, permissions: new Set() }
          : { at: 'refused', status: 403, code: 'not_a_member', message: 'Refused.' },
      ),
  };
  const http = createServer();
  const realtime = startRealtime({
    httpServer: http,
    databaseUrl: database.url('crm_app'),
    publicUrl: 'http://crm.test',
    authentication,
    logger: pino({ level: 'silent' }),
  });
  await expect
    .poll(async () =>
      realtime.ready().then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('Missing port.');
  const port = address.port;
  const clients: Socket[] = [];
  function client(
    id: unknown = toPublicId('business', business.id),
    origin = 'http://crm.test',
    cookie = 'test=session',
  ) {
    const socket = io(`http://127.0.0.1:${String(port)}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { businessId: id },
      extraHeaders: { origin, ...(cookie.length === 0 ? {} : { cookie }) },
    });
    clients.push(socket);
    return socket;
  }
  return {
    business,
    other,
    realtime,
    client,
    revoke: () => {
      allowed = false;
    },
    signOut: () => {
      signedIn = false;
    },
    requireTwoFactor: () => {
      twoFactorRequired = true;
    },
    breakAuthentication: () => {
      broken = true;
    },
    enableTwoFactor: () => {
      twoFactorEnabled = true;
    },
    leaveAgency: () => {
      agencyId = undefined;
    },
    async close() {
      await realtime.close();
      for (const client of clients) client.disconnect();
    },
  };
}

const change = defineCommand({
  name: 'test.realtime_change',
  permission: 'tags.manage',
  input: z.strictObject({ fail: z.boolean().default(false) }),
  handle: (_trx, input) => {
    if (input.fail) throw new Error('Rollback.');
    return Promise.resolve();
  },
});

it('delivers only committed business changes to both tabs, across app processes, within one second', async () => {
  const f = await fixture();
  try {
    const first = f.client();
    const second = f.client();
    const foreign = f.client(toPublicId('business', f.other.id));
    await Promise.all([
      socketEvent(first, 'connect'),
      socketEvent(second, 'connect'),
      socketEvent(foreign, 'connect'),
    ]);
    const received: unknown[] = [];
    const local: unknown[] = [];
    first.on('business.changed', (payload: unknown) => local.push(payload));
    foreign.on('business.changed', (payload: unknown) => received.push(payload));
    const invocation = {
      context: { ...f.business.context, correlationId: randomUUID() },
      permissions: 'all' as const,
    };
    await expect(
      runCommand({ db, authorize: allowEveryone }, change, { fail: true }, invocation),
    ).rejects.toThrow('Rollback.');
    const firstEvent = socketEvent(first, 'business.changed');
    const secondEvent = socketEvent(second, 'business.changed');
    const started = performance.now();
    await runCommand({ db, authorize: allowEveryone }, change, {}, invocation);
    expect(await firstEvent).toEqual([{ businessId: toPublicId('business', f.business.id) }]);
    expect(await secondEvent).toEqual([{ businessId: toPublicId('business', f.business.id) }]);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(received).toEqual([]);
    expect(local).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('refuses missing cookies, foreign origins, malformed IDs, absent membership and required two-factor setup', async () => {
  const f = await fixture();
  try {
    const refused = async (socket: Socket) => {
      const [error] = await socketEvent(socket, 'connect_error');
      expect(error).toBeInstanceOf(Error);
      expect(socket.connected).toBe(false);
    };
    await refused(f.client(undefined, undefined, ''));
    await refused(f.client(undefined, 'http://foreign.test'));
    await refused(f.client('biz_invalid'));
    await refused(f.client(42));
    f.requireTwoFactor();
    await refused(f.client());
    f.enableTwoFactor();
    await socketEvent(f.client(), 'connect');
    f.revoke();
    await refused(f.client());
    f.leaveAgency();
    await refused(f.client());
    f.breakAuthentication();
    await refused(f.client());
  } finally {
    await f.close();
  }
});

it.each(['membership', 'session'] as const)(
  'disconnects a revoked %s before sending a later hint',
  async (kind) => {
    const f = await fixture();
    try {
      const socket = f.client();
      await socketEvent(socket, 'connect');
      const received: unknown[] = [];
      socket.on('business.changed', (payload: unknown) => received.push(payload));
      if (kind === 'membership') f.revoke();
      else f.signOut();
      const disconnected = socketEvent(socket, 'disconnect');
      await database.as('crm_app', (sql) =>
        sql.query("select pg_notify('crm_business_changed', $1)", [f.business.id]),
      );
      await disconnected;
      expect(received).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it('ignores malformed notifications and closes open websocket connections', async () => {
  const f = await fixture();
  const socket = f.client();
  await socketEvent(socket, 'connect');
  await database.as('crm_app', (sql) =>
    sql.query("select pg_notify('crm_business_changed', 'not-a-business')"),
  );
  const disconnected = socketEvent(socket, 'disconnect');
  await f.close();
  await disconnected;
});

it('recovers a lost database listener and refetches changes missed during the gap', async () => {
  const f = await fixture();
  try {
    const socket = f.client();
    await socketEvent(socket, 'connect');
    await f.realtime.ready();
    const refreshed = socketEvent(socket, 'business.changed', 5000);
    await database.as('crm_app', (sql) =>
      sql.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and application_name = 'crm-realtime'",
      ),
    );
    await expect
      .poll(async () =>
        f.realtime.ready().then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
    expect(await refreshed).toEqual([{ businessId: toPublicId('business', f.business.id) }]);
    await f.realtime.ready();
  } finally {
    await f.close();
  }
});

it('serves health but reports not ready while the database listener cannot connect', async () => {
  const http = createServer();
  const realtime = startRealtime({
    httpServer: http,
    databaseUrl: 'postgres://localhost:1/unavailable',
    publicUrl: 'http://crm.test',
    authentication: {
      signedIn: () => Promise.resolve(undefined),
      workplace: () => Promise.reject(new Error('No session.')),
    },
    logger: pino({ level: 'silent' }),
  });
  await expect(realtime.ready()).rejects.toThrow('Realtime listener unavailable.');
  await realtime.close();
});

it('fails closed if authentication becomes unavailable during delivery', async () => {
  const f = await fixture();
  try {
    const socket = f.client();
    await socketEvent(socket, 'connect');
    f.breakAuthentication();
    const disconnected = socketEvent(socket, 'disconnect');
    await database.as('crm_app', (sql) =>
      sql.query("select pg_notify('crm_business_changed', $1)", [f.business.id]),
    );
    await disconnected;
  } finally {
    await f.close();
  }
});
