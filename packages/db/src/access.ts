// How the API and the worker reach the database: Kysely over node-postgres, with types
// generated from the schema, and a tenant context on every transaction.
import { tenantSettings, type TenantContext } from '@repo/kernel';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';

import type { DB } from './database.gen.js';

export type Database = Kysely<DB>;
export type DatabaseTransaction = Transaction<DB>;

export interface ConnectOptions {
  /**
   * A connection string for crm_app (the API and the worker), crm_auth (sign-in) or
   * crm_worker (the job queue).
   */
  connectionString: string;
  /** The most connections the pool opens at once; node-postgres's default otherwise. */
  maxConnections?: number;
  /**
   * Called once for each connection that fails, as when Postgres restarts, so it can be
   * logged. The pool replaces the connection, and a query that was using it fails too.
   */
  onConnectionError: (error: Error) => void;
  /**
   * Returns bigint (int8) values as JavaScript numbers rather than node-postgres's strings,
   * for code that does arithmetic on them, such as Better Auth's rate limits. A value
   * beyond Number.MAX_SAFE_INTEGER fails rather than lose precision.
   */
  bigintAsNumber?: boolean;
}

function safeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`${value} is too large to be a JavaScript number.`);
  }
  return parsed;
}

const bigintAsNumber: pg.CustomTypesConfig = {
  getTypeParser: (
    oid: Parameters<typeof pg.types.getTypeParser>[0],
    format?: 'text' | 'binary',
  ) => {
    if (oid === pg.types.builtins.INT8 && format !== 'binary') return safeInteger;
    // node-postgres's own parser for every other type.
    const builtIn: unknown = pg.types.getTypeParser(oid, format);
    return builtIn;
  },
};

/** A pool of connections for one database role, typed and ready for withTenant. */
export function connectDatabase(options: ConnectOptions): Database {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: connectPool(options) }) });
}

/**
 * A node-postgres pool, for code that takes one directly, such as Graphile Worker. A
 * connection that fails is reported, not fatal. Call end() to close it.
 */
export function connectPool(options: ConnectOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
    ...(options.bigintAsNumber === true ? { types: bigintAsNumber } : {}),
  });
  // node-postgres reports a broken connection as an 'error' event on the connection, and
  // again on the pool when the connection was idle. Node treats an 'error' event nobody
  // listens to as uncaught, so without these a Postgres restart would stop the process.
  const failed = new WeakSet<pg.PoolClient>();
  const report = (client: pg.PoolClient, error: Error) => {
    if (!failed.has(client)) {
      failed.add(client);
      options.onConnectionError(error);
    }
  };
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      report(client, error);
    });
  });
  pool.on('error', (error, client) => {
    report(client, error);
  });
  return pool;
}

/**
 * Runs the work in one transaction that sets the tenant context before anything else, so
 * row-level security shows only the context's rows. The settings are local to the
 * transaction (set_config(..., true)), so they end with it, even on a pooled connection.
 *
 * With `snapshot`, every statement of the work reads the database as it was at one moment
 * (Postgres's REPEATABLE READ), for work that must see several tables as they were
 * together. Such work must only read: a write could then fail on a row changed meanwhile.
 */
export function withTenant<T>(
  db: Database,
  context: TenantContext,
  work: (trx: DatabaseTransaction) => Promise<T>,
  options: { readonly snapshot?: boolean } = {},
): Promise<T> {
  const transaction =
    options.snapshot === true
      ? db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only')
      : db.transaction();
  return transaction.execute(async (trx) => {
    const settings = tenantSettings(context);
    await sql`
      select set_config(setting.name, setting.value, true)
      from unnest(${settings.map(([name]) => name)}::text[],
                  ${settings.map(([, value]) => value)}::text[]) as setting (name, value)
    `.execute(trx);
    return work(trx);
  });
}

/**
 * For a query's catch: when Postgres refuses a duplicate under one of these unique
 * constraints, throws the error given for it; any other error is thrown unchanged.
 * Constraints are named after their table and purpose, so each maps to a clear message.
 */
export function explainUniqueViolation(
  explanations: Readonly<Record<string, () => Error>>,
): (error: unknown) => never {
  return (error) => {
    if (error instanceof pg.DatabaseError && error.code === '23505') {
      const explain = explanations[error.constraint ?? ''];
      if (explain !== undefined) {
        throw explain();
      }
    }
    throw error;
  };
}
