import { parseArgs } from 'node:util';

import { migrateDatabase } from './migrate-database.js';

const USAGE = `Usage: migrate [--dry-run] [--locked-only]

Applies the database migrations that haven't been applied yet, in order, each in its own
transaction, then Graphile Worker's migrations for the job queue. It connects as
crm_owner, using the connection string in DATABASE_OWNER_URL.

Options:
  --dry-run   list the migrations that would be applied, and change nothing
              (Graphile Worker's migrations aren't checked)
  --locked-only
              apply only the migrations in migrations.lock, beside the migrations,
              and skip drafts that aren't in it yet, naming each; a locked migration
              that no longer matches the lock stops the run (for development
              databases: a deploy applies every migration)
  -h, --help  show this help
`;

export interface Output {
  write(text: string): unknown;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the migrate command. Returns the process exit code: 0 when the database is up to
 * date, 1 when migrating failed, 2 when the command was used wrongly.
 */
export async function main(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: { stdout: Output; stderr: Output },
): Promise<number> {
  let options;
  try {
    options = parseArgs({
      args: [...args],
      options: {
        'dry-run': { type: 'boolean', default: false },
        'locked-only': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }).values;
  } catch (error) {
    output.stderr.write(`Error: ${messageOf(error)}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    output.stdout.write(USAGE);
    return 0;
  }

  // Without this check, an empty connection string would quietly mean localhost.
  const connectionString = env['DATABASE_OWNER_URL'];
  if (connectionString === undefined || connectionString === '') {
    output.stderr.write(
      "Error: DATABASE_OWNER_URL isn't set. Set it to crm_owner's connection string, for " +
        'example postgres://crm_owner:<password>@postgres:5432/crm\n',
    );
    return 2;
  }

  try {
    const dryRun = options['dry-run'];
    const result = await migrateDatabase({
      connectionString,
      dryRun,
      lockedOnly: options['locked-only'],
      onApplied: (name) => output.stdout.write(`Applied ${name}\n`),
    });
    const skipped = result.skipped
      .map((name) => `Skipped ${name}: a draft, not in migrations.lock\n`)
      .join('');
    for (const warning of result.warnings) {
      output.stderr.write(`Warning: ${warning}\n`);
    }
    if (dryRun) {
      output.stdout.write(
        (result.pending.length > 0
          ? result.pending.map((name) => `Would apply ${name}\n`).join('')
          : 'No migrations to apply.\n') +
          skipped +
          "Graphile Worker's migrations aren't checked in a dry run.\n",
      );
    } else {
      output.stdout.write(`${skipped}The database is up to date.\n`);
    }
    return 0;
  } catch (error) {
    output.stderr.write(`Error: ${messageOf(error)}\n`);
    return 1;
  }
}
