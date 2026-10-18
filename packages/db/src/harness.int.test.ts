// The test harness (@repo/testing) itself, against the real migrations.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  connectionString,
  startDatabaseServer,
  startPostgres,
  testDatabase,
  type PostgresServer,
  type TestDatabase,
} from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { bootstrapFile, migrate } from './index.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});

afterAll(async () => {
  await database.close();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address.');
  }
  return address.port;
}

/**
 * A TCP proxy to the test Postgres that drops the first connection it gets, as Docker's
 * port forwarding can for a container that has only just started.
 */
async function proxyDroppingFirstConnection(target: { host: string; port: number }) {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    if (connections === 1) {
      socket.destroy();
      return;
    }
    const upstream = connect(target.port, target.host);
    socket.pipe(upstream).pipe(socket);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  const port = await listen(server);
  return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * A TCP proxy to the test Postgres that can hold back what clients send, as a busy
 * server can be slow to read it.
 */
async function holdingProxy(target: { host: string; port: number }) {
  const connections = new Map<Socket, Socket>();
  const server = createServer((socket) => {
    const upstream = connect(target.port, target.host);
    connections.set(socket, upstream);
    socket.pipe(upstream).pipe(socket);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  const port = await listen(server);
  return {
    port,
    hold() {
      for (const [socket, upstream] of connections) {
        socket.unpipe(upstream);
      }
    },
    release() {
      for (const [socket, upstream] of connections) {
        socket.pipe(upstream);
      }
    },
    close() {
      for (const [socket, upstream] of connections) {
        socket.destroy();
        upstream.destroy();
      }
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Waits until Postgres is dropping the database, or has dropped it. */
async function dropBegun(server: PostgresServer, database: string): Promise<void> {
  const client = new pg.Client({
    connectionString: connectionString(server, 'postgres', 'postgres'),
  });
  await client.connect();
  try {
    for (;;) {
      const { rows } = await client.query<{ begun: boolean }>(
        `select exists (select from pg_stat_activity where state = 'active' and starts_with(query, $1))
             or not exists (select from pg_database where datname = $2) as begun`,
        [`drop database ${pg.escapeIdentifier(database)}`, database],
      );
      if (rows[0]?.begun === true) {
        return;
      }
      await delay(10);
    }
  } finally {
    await client.end();
  }
}

describe('closing a test database', () => {
  it('lets connections that are still closing finish, rather than cutting them off', async () => {
    const real = inject('databaseServer');
    const copy = await testDatabase(real);
    const proxy = await holdingProxy(real.server);
    const pool = new pg.Pool({
      connectionString: connectionString(
        { host: '127.0.0.1', port: proxy.port },
        copy.name,
        'crm_app',
      ),
    });
    const errors: Error[] = [];
    pool.on('error', (error) => {
      errors.push(error);
    });
    try {
      await pool.query('select 1');
      // pg's Pool.end() resolves before its connections close. Here Postgres doesn't
      // read the pool's goodbye until the drop has begun.
      proxy.hold();
      const disconnected = new Promise((resolve) => pool.once('remove', resolve));
      await pool.end();
      const closing = copy.close();
      await dropBegun(real.server, copy.name);
      proxy.release();
      await Promise.all([closing, disconnected]);
    } finally {
      await proxy.close();
    }

    expect(errors).toEqual([]);
  });
});

describe('a test database', () => {
  it('gives a connection string for each role', async () => {
    for (const role of ['crm_owner', 'crm_app', 'crm_auth', 'crm_worker'] as const) {
      const client = new pg.Client({ connectionString: database.url(role) });
      await client.connect();
      try {
        const { rows } = await client.query<{ database: string; role: string }>(
          'select current_database() as database, current_user as role',
        );
        expect(rows).toEqual([{ database: database.name, role }]);
      } finally {
        await client.end();
      }
    }
  });

  it('rolls back the work when it fails', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);

    const failing = database.withTenant(business.context, async (sql) => {
      await sql.query(
        "insert into crm.tags (business_id, name, created_by_kind) values ($1, 'Kept out', 'user')",
        [business.id],
      );
      throw new Error('the work failed');
    });

    await expect(failing).rejects.toThrow('the work failed');
    const tags = await database.withTenant(business.context, (sql) =>
      sql.query('select * from crm.tags'),
    );
    expect(tags).toEqual([]);
  });

  it('reads exactly one row with one(), and refuses none or several', async () => {
    const read = (text: string) => database.as('crm_owner', (sql) => sql.one(text));

    await expect(read('select 1 as answer')).resolves.toEqual({ answer: 1 });
    await expect(read('select 1 where false')).rejects.toThrow('Expected one row, got 0');
    await expect(read('select generate_series(1, 2)')).rejects.toThrow('Expected one row, got 2');
  });

  it('makes a contact with defaults when given no values', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);

    const contact = await database.fixtures.contact(business.context);

    const [row] = await database.withTenant(business.context, (sql) =>
      sql.query('select display_name from crm.contacts where id = $1', [contact.id]),
    );
    expect(row).toEqual({ display_name: 'Test' });
  });
});

describe('the database server', () => {
  // Every test file opens its own pools, one per role it uses, and the files of a suite run
  // side by side: as many as the machine has cores. PostgreSQL's own default of 100
  // connections (97 for roles that are not superusers) was reached by the server suite's
  // 27 files on a 28-core machine, each holding up to 8 at once, and whichever file asked
  // next was refused. The limit is sized for a run of test files, not for one application.
  it('takes more connections than a whole suite of test files opens at once', async () => {
    const [limit] = await database.as('postgres', (sql) =>
      sql.query<{ connections: number; reserved: number }>(
        `select current_setting('max_connections')::int as connections,
                current_setting('superuser_reserved_connections')::int as reserved`,
      ),
    );
    // Sixty files at once, eight connections each, with room to spare.
    expect((limit?.connections ?? 0) - (limit?.reserved ?? 0)).toBeGreaterThanOrEqual(60 * 8);
  });

  it('migrates a template that test databases copy', async () => {
    const { connection, stop } = await startDatabaseServer({
      bootstrapFile,
      migrate: (connectionString) => migrate({ connectionString }),
    });
    try {
      const copy = await testDatabase(connection);
      const [count] = await copy.as('crm_owner', (sql) =>
        sql.query<{ applied: string }>('select count(*) as applied from util.applied_migrations'),
      );
      await copy.close();
      expect(Number(count?.applied)).toBeGreaterThan(0);
    } finally {
      await stop();
    }
  });

  it('reports the error when the migrations fail', async () => {
    const starting = startDatabaseServer({
      bootstrapFile,
      migrate: () => Promise.reject(new Error('the migrations failed')),
    });

    await expect(starting).rejects.toThrow('the migrations failed');
  });

  it('reports a bootstrap that fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crm-bootstrap-'));
    const broken = join(directory, 'broken.sql');
    await writeFile(broken, 'create role;\n');
    try {
      await expect(startPostgres({ bootstrapFile: broken })).rejects.toThrow(
        'The install bootstrap failed',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('connecting to the test Postgres', () => {
  it('gets past a connection that drops while Docker settles', async () => {
    const real = inject('databaseServer');
    const proxy = await proxyDroppingFirstConnection(real.server);
    try {
      const copy = await testDatabase({ ...real, server: { host: '127.0.0.1', port: proxy.port } });
      try {
        await expect(copy.as('crm_owner', (sql) => sql.one('select 1 as ok'))).resolves.toEqual({
          ok: 1,
        });
      } finally {
        await copy.close();
      }
    } finally {
      await proxy.close();
    }
  });

  it('says which server it could not reach', async () => {
    const closed = createServer();
    const port = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));

    await expect(
      testDatabase({ server: { host: '127.0.0.1', port }, template: 'crm' }),
    ).rejects.toThrow(
      `Couldn't connect to the test Postgres at 127.0.0.1:${String(port)} as postgres`,
    );
  });
});
