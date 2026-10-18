// What the migrate container runs on every deploy: it brings the database up to this
// version as crm_owner, then, on a new install, creates the agency and its built-in roles.
// app and worker start once it has finished. With DATABASE_ADMIN_URL, a superuser's
// connection to an external server, it first creates the roles and the database when the
// server has none of them.
import { bootstrapDatabase, migrateDatabase } from '@repo/db';
import { ensureAgency } from '@repo/module-tenancy';

import { connectForCommand, messageOf, type Output } from './cli.js';

/** Returns the exit code: 0 when done, 1 when it failed, 2 when a setting is missing. */
export async function install(
  env: Readonly<Record<string, string | undefined>>,
  output: { stdout: Output; stderr: Output },
): Promise<number> {
  const connectionString = env['DATABASE_OWNER_URL'] ?? '';
  const agencyName = env['AGENCY_NAME']?.trim() ?? '';
  if (connectionString === '') {
    output.stderr.write(
      "Error: DATABASE_OWNER_URL isn't set. Set it to crm_owner's connection string, for example postgres://crm_owner:<password>@postgres:5432/crm\n",
    );
    return 2;
  }
  if (agencyName === '') {
    output.stderr.write(
      "Error: AGENCY_NAME isn't set. Set it to your agency's name: the first start creates the agency with it.\n",
    );
    return 2;
  }

  const adminUrl = env['DATABASE_ADMIN_URL'] ?? '';
  const roleUrls = {
    crm_owner: connectionString,
    crm_app: env['DATABASE_APP_URL'] ?? '',
    crm_auth: env['DATABASE_AUTH_URL'] ?? '',
    crm_worker: env['DATABASE_WORKER_URL'] ?? '',
  };
  if (adminUrl !== '') {
    const missing = Object.entries(roleUrls)
      .filter(([, url]) => url === '')
      .map(([role]) => `DATABASE_${role.slice('crm_'.length).toUpperCase()}_URL`);
    if (missing.length > 0) {
      output.stderr.write(
        `Error: with DATABASE_ADMIN_URL, the bootstrap also needs ${missing.join(', ')}: it creates each role with the password of its connection string.\n`,
      );
      return 2;
    }
    try {
      const bootstrap = await bootstrapDatabase({ adminUrl, urls: roleUrls });
      output.stdout.write(
        bootstrap.created
          ? 'Created the roles and the database on the Postgres server.\n'
          : 'The roles and the database are already on the Postgres server; nothing to create.\n',
      );
      for (const warning of bootstrap.warnings) output.stderr.write(`Warning: ${warning}\n`);
    } catch (error) {
      output.stderr.write(`Installing failed: ${messageOf(error)}\n`);
      return 1;
    }
  }

  const owner = connectForCommand(connectionString);
  try {
    const result = await migrateDatabase({
      connectionString,
      onApplied: (name) => output.stdout.write(`Applied ${name}\n`),
    });
    for (const warning of result.warnings) output.stderr.write(`Warning: ${warning}\n`);
    const agency = await ensureAgency(owner, { name: agencyName });
    output.stdout.write(
      agency.created
        ? `Created the agency ${agencyName}, with its built-in roles.\n`
        : 'The agency is already here; nothing to create.\n',
    );
    return 0;
  } catch (error) {
    output.stderr.write(`Installing failed: ${messageOf(error)}\n`);
    return 1;
  } finally {
    await owner.destroy();
  }
}
