// A throwaway Postgres 18 server for tests: the image installs run, with the install
// bootstrap applied, so the crm database exists with its roles and extensions but no
// migrations.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const IMAGE = 'pgvector/pgvector:pg18';
// Every role shares this password; the server lives only as long as the test run.
const PASSWORD = 'test-only';
const SUPERUSER = 'postgres';
// How many connections the test server takes: see startPostgres.
const MAX_CONNECTIONS = 500;

/** The database the bootstrap creates: roles and extensions, no migrations. */
export const BOOTSTRAPPED_DATABASE = 'crm';

/** The install's four roles, plus the server's superuser. */
export type Role = 'crm_owner' | 'crm_app' | 'crm_auth' | 'crm_worker' | typeof SUPERUSER;

/** Where the server is. Plain data, so a global setup can hand it to test workers. */
export interface PostgresServer {
  host: string;
  port: number;
}

/** A connection string for one of the roles. */
export function connectionString(
  server: PostgresServer,
  database: string,
  role: Role = 'crm_owner',
): string {
  const url = new URL(`postgres://${server.host}`);
  url.port = String(server.port);
  url.username = role;
  url.password = PASSWORD;
  url.pathname = `/${database}`;
  return url.toString();
}

// A container that has only just started can drop a connection before Postgres answers,
// while Docker's port forwarding settles under load. So connecting is tried a few times,
// with a growing pause; a statement is never retried, since it may already have run.
const CONNECT_ATTEMPTS = 4;

async function connect(server: PostgresServer, role: Role): Promise<pg.Client> {
  for (let attempt = 1; ; attempt += 1) {
    const client = new pg.Client({ connectionString: connectionString(server, SUPERUSER, role) });
    try {
      await client.connect();
      return client;
    } catch (error) {
      if (attempt === CONNECT_ATTEMPTS) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Couldn't connect to the test Postgres at ${server.host}:${String(server.port)} as ${role}: ${reason}`,
          { cause: error },
        );
      }
      await delay(100 * 2 ** attempt);
    }
  }
}

async function asSuperuser(server: PostgresServer, statements: string[]): Promise<void> {
  const client = await connect(server, SUPERUSER);
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
  } finally {
    await client.end();
  }
}

/** A new database copied from a template, owned by crm_owner like the install's own. */
export async function createDatabase(server: PostgresServer, template: string): Promise<string> {
  const database = `test_${randomUUID().replaceAll('-', '')}`;
  const name = pg.escapeIdentifier(database);
  // A copy doesn't carry the template's owner or database-level grants, so the
  // bootstrap's are repeated.
  await asSuperuser(server, [
    `create database ${name} template ${pg.escapeIdentifier(template)} owner crm_owner`,
    `revoke all on database ${name} from public`,
    `grant connect on database ${name} to crm_app, crm_auth, crm_worker`,
  ]);
  return database;
}

// Without force, Postgres waits up to five seconds for other connections to the database
// to go. pg's Pool.end() resolves before its connections close, and force would cut those
// off with an error.
export async function dropDatabase(server: PostgresServer, database: string): Promise<void> {
  await asSuperuser(server, [`drop database ${pg.escapeIdentifier(database)}`]);
}

export interface PsqlResult {
  exitCode: number;
  output: string;
}

export interface Postgres {
  readonly server: PostgresServer;
  url(database: string, role?: Role): string;
  /** A new database copied from the template: the bootstrapped one unless given another. */
  createDatabase(template?: string): Promise<string>;
  /** Runs a SQL file through psql, as the superuser; for scripts that use psql's variables. */
  psql(database: string, file: string, variables?: Record<string, string>): Promise<PsqlResult>;
  stop(): Promise<void>;
}

/** Starts the server and runs the install bootstrap (packages/db/bootstrap) in it. */
export async function startPostgres(options: { bootstrapFile: string }): Promise<Postgres> {
  const container = await new PostgreSqlContainer(IMAGE)
    .withUsername(SUPERUSER)
    .withPassword(PASSWORD)
    .withDatabase(SUPERUSER)
    // Durability is pointless for a database that is thrown away, and costs time.
    //
    // max_connections: one server holds every test file's database, and the files of a
    // suite run side by side, as many as the machine has cores, each with a pool per role
    // it uses. PostgreSQL's default of 100 (97 for roles that are not superusers) ran out
    // when the server suite's 27 files ran at once on 28 cores with up to 8 connections
    // each ("remaining connection slots are reserved..."). A slot that is never used costs
    // a few kilobytes of shared memory, so the limit is set well clear of any suite.
    .withCommand([
      'postgres',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
      '-c',
      `max_connections=${String(MAX_CONNECTIONS)}`,
    ])
    .start();
  const server = { host: container.getHost(), port: container.getPort() };

  const psql = async (
    database: string,
    file: string,
    variables: Record<string, string> = {},
  ): Promise<PsqlResult> => {
    const target = `/tmp/psql/${randomUUID()}-${basename(file)}`;
    await container.copyContentToContainer([{ content: await readFile(file), target }]);
    const { exitCode, output } = await container.exec([
      'psql',
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      ...Object.entries(variables).flatMap(([name, value]) => ['-v', `${name}=${value}`]),
      '-U',
      SUPERUSER,
      '-d',
      database,
      '-f',
      target,
    ]);
    return { exitCode, output };
  };

  const bootstrap = await psql(SUPERUSER, options.bootstrapFile, {
    owner_password: PASSWORD,
    app_password: PASSWORD,
    auth_password: PASSWORD,
    worker_password: PASSWORD,
  });
  if (bootstrap.exitCode !== 0) {
    await container.stop();
    throw new Error(`The install bootstrap failed:\n${bootstrap.output}`);
  }

  return {
    server,
    url: (database, role) => connectionString(server, database, role),
    createDatabase: (template = BOOTSTRAPPED_DATABASE) => createDatabase(server, template),
    psql,
    async stop() {
      await container.stop();
    },
  };
}
