import { tenantSettings, type TenantContext } from '@repo/kernel';
import { Logger, runOnce } from 'graphile-worker';
import pg from 'pg';

import { databaseFixtures, type Fixtures } from './fixtures.js';
import {
  connectionString,
  createDatabase,
  dropDatabase,
  startPostgres,
  type PostgresServer,
  type Role,
} from './postgres.js';
import type { Sql, Transactions } from './transactions.js';

/**
 * What test workers need to make their own databases: the server, and the name of a
 * database with every migration applied, to copy. Plain data, so a global setup can hand
 * it to test files (Vitest's provide and inject).
 */
export interface DatabaseServer {
  server: PostgresServer;
  template: string;
}

export interface StartDatabaseServerOptions {
  /** packages/db's install bootstrap. */
  bootstrapFile: string;
  /** Applies the migrations to the database at this connection string, as crm_owner. */
  migrate: (connectionString: string) => Promise<unknown>;
}

/** Starts Postgres once for a test run, and migrates the template every test file copies. */
export async function startDatabaseServer(
  options: StartDatabaseServerOptions,
): Promise<{ connection: DatabaseServer; stop: () => Promise<void> }> {
  const postgres = await startPostgres({ bootstrapFile: options.bootstrapFile });
  try {
    const template = await postgres.createDatabase();
    await options.migrate(postgres.url(template));
    return { connection: { server: postgres.server, template }, stop: () => postgres.stop() };
  } catch (error) {
    await postgres.stop();
    throw error;
  }
}

/** A job as a task received it. */
export interface ReceivedJob {
  task: string;
  payload: unknown;
}

export interface TestDatabase extends Transactions {
  readonly name: string;
  url(role?: Role): string;
  readonly fixtures: Fixtures;
  /**
   * Runs the queued jobs of these tasks, as the worker's role (crm_worker) does, until
   * none are left, and returns what each job received. Jobs of other tasks stay queued.
   */
  runJobs(tasks: readonly string[]): Promise<ReceivedJob[]>;
  /**
   * Closes the connections and drops the database. Close your own connections to it
   * first: the drop waits a few seconds for ones that are closing, then fails.
   */
  close(): Promise<void>;
}

// Sets every app.* setting for the transaction in one statement.
const SET_CONTEXT = `
  select set_config(setting.name, setting.value, true)
  from unnest($1::text[], $2::text[]) as setting (name, value)`;

function sqlOn(client: pg.PoolClient): Sql {
  const query = async <Row extends object>(text: string, values: readonly unknown[] = []) =>
    (await client.query<Row>(text, [...values])).rows;
  return {
    query,
    async one<Row extends object>(text: string, values: readonly unknown[] = []) {
      const rows = await query<Row>(text, values);
      const [row] = rows;
      if (row === undefined || rows.length > 1) {
        throw new Error(`Expected one row, got ${String(rows.length)}: ${text}`);
      }
      return row;
    },
  };
}

/** A database of the test file's own: a copy of the migrated template. */
export async function testDatabase(connection: DatabaseServer): Promise<TestDatabase> {
  const name = await createDatabase(connection.server, connection.template);
  const pools = new Map<Role, pg.Pool>();
  const pool = (role: Role): pg.Pool => {
    let existing = pools.get(role);
    if (existing === undefined) {
      existing = new pg.Pool({ connectionString: connectionString(connection.server, name, role) });
      pools.set(role, existing);
    }
    return existing;
  };

  const transaction = async <T>(
    role: Role,
    context: TenantContext | undefined,
    work: (sql: Sql) => Promise<T>,
  ): Promise<T> => {
    const client = await pool(role).connect();
    try {
      await client.query('begin');
      if (context !== undefined) {
        const settings = tenantSettings(context);
        await client.query(SET_CONTEXT, [
          settings.map(([setting]) => setting),
          settings.map(([, value]) => value),
        ]);
      }
      const result = await work(sqlOn(client));
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  };

  const transactions: Transactions = {
    withTenant: (context, work) => transaction('crm_app', context, work),
    as: (role, work) => transaction(role, undefined, work),
  };
  return {
    ...transactions,
    name,
    url: (role) => connectionString(connection.server, name, role),
    fixtures: databaseFixtures(transactions),
    async runJobs(tasks) {
      const received: ReceivedJob[] = [];
      await runOnce({
        connectionString: connectionString(connection.server, name, 'crm_worker'),
        noHandleSignals: true,
        logger: new Logger(() => () => undefined),
        taskList: Object.fromEntries(
          tasks.map((task) => [
            task,
            (payload: unknown) => {
              received.push({ task, payload });
            },
          ]),
        ),
      });
      return received;
    },
    async close() {
      await Promise.all([...pools.values()].map((each) => each.end()));
      await dropDatabase(connection.server, name);
    },
  };
}
