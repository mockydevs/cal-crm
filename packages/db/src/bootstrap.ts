import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

/**
 * The install bootstrap: roles, the database and extensions. It runs once per install,
 * as a superuser: through psql (with psql variables for the passwords), or through
 * bootstrapDatabase.
 */
export const bootstrapFile = fileURLToPath(
  new URL('../bootstrap/0001_roles_and_database.sql', import.meta.url),
);

const ROLES = ['crm_owner', 'crm_app', 'crm_auth', 'crm_worker'] as const;
type Role = (typeof ROLES)[number];
const DATABASE = 'crm';

export interface BootstrapOptions {
  /** A superuser's connection string to the server, such as its postgres database. */
  adminUrl: string;
  /** Each role's connection string; the bootstrap takes the password from each. */
  urls: Readonly<Record<Role, string>>;
}

export interface BootstrapResult {
  /** False when the roles and the database were already there, and nothing was done. */
  created: boolean;
  warnings: string[];
}

/**
 * Runs the install bootstrap on an external Postgres server through a superuser's
 * connection: the four roles with the passwords of their connection strings, the crm
 * database, and its extensions. It does nothing when they are all there already, and
 * refuses to finish a bootstrap that something else began.
 */
export async function bootstrapDatabase(options: BootstrapOptions): Promise<BootstrapResult> {
  const passwords = passwordsOf(options.urls);
  const [onServer, inDatabase] = await bootstrapStatements();
  const warnings: string[] = [];

  const admin = new pg.Client({ connectionString: options.adminUrl });
  await admin.connect();
  let created = false;
  try {
    const roles = await admin.query<{ rolname: string }>(
      'select rolname from pg_roles where rolname = any($1)',
      [[...ROLES]],
    );
    const database = await admin.query('select 1 from pg_database where datname = $1', [DATABASE]);
    const present = roles.rows.map((row) => row.rolname);
    const done = present.length === ROLES.length && database.rowCount === 1;
    if (!done) {
      if (present.length > 0 || database.rowCount === 1) {
        throw new Error(
          `The server already has ${[...present, ...(database.rowCount === 1 ? [`the ${DATABASE} database`] : [])].join(', ')}, but not all of the install's roles and database. Finish or undo that bootstrap by hand before installing.`,
        );
      }
      for (const statement of onServer) await admin.query(fill(statement, passwords, admin));
      created = true;
    }
  } finally {
    await admin.end();
  }

  const url = new URL(options.adminUrl);
  url.pathname = `/${DATABASE}`;
  const inCrm = new pg.Client({ connectionString: url.toString() });
  await inCrm.connect();
  try {
    if (created) {
      for (const statement of inDatabase) await inCrm.query(fill(statement, passwords, inCrm));
    }
    const vector = await inCrm.query("select 1 from pg_available_extensions where name = 'vector'");
    if (vector.rowCount === 0)
      warnings.push(
        "This Postgres server doesn't offer the pgvector extension. Today nothing needs it; the AI features that keep embeddings will.",
      );
  } finally {
    await inCrm.end();
  }
  return { created, warnings };
}

/** The roles' passwords, from their connection strings, which must name the right role. */
function passwordsOf(urls: Readonly<Record<Role, string>>): Map<string, string> {
  const passwords = new Map<string, string>();
  for (const role of ROLES) {
    const url = new URL(urls[role]);
    if (decodeURIComponent(url.username) !== role)
      throw new Error(`The connection string for ${role} signs in as another role.`);
    if (url.password === '') throw new Error(`The connection string for ${role} has no password.`);
    if (url.pathname !== `/${DATABASE}`)
      throw new Error(`The connection string for ${role} must name the ${DATABASE} database.`);
    passwords.set(`${role.slice('crm_'.length)}_password`, decodeURIComponent(url.password));
  }
  return passwords;
}

/**
 * The bootstrap file's statements, in two parts: those run on the server, then those run
 * in the crm database (after its \connect). psql's own lines are left out.
 */
async function bootstrapStatements(): Promise<[string[], string[]]> {
  const text = await readFile(bootstrapFile, 'utf8');
  const [onServer = '', inDatabase = ''] = text.split(/^\\connect\s+crm\s*$/m);
  const statements = (part: string) =>
    part
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--') && !line.trimStart().startsWith('\\'))
      .join('\n')
      .split(/;\s*$/m)
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '');
  return [statements(onServer), statements(inDatabase)];
}

/** A statement with each psql variable :'name' replaced by its password, quoted. */
function fill(statement: string, passwords: Map<string, string>, client: pg.Client): string {
  return statement.replace(/:'(\w+)'/g, (_, name: string) => {
    const password = passwords.get(name);
    if (password === undefined)
      throw new Error(`The bootstrap asks for ${name}, which is unknown.`);
    return client.escapeLiteral(password);
  });
}
