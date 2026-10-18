// Migrating the whole database: our SQL migrations, then Graphile Worker's own, which
// install and upgrade the job queue in the graphile_worker schema. Both run as crm_owner;
// the worker's role (crm_worker) can't create anything.
import { Logger, runMigrations } from 'graphile-worker';

import { migrate, type MigrateOptions, type MigrateResult } from './migrate.js';

export type MigrateDatabaseOptions = Omit<MigrateOptions, 'directory'>;

/**
 * Graphile Worker's preset, as this install uses it: tasks are given as a list, never
 * loaded from files, so its file-loading plugins are off.
 */
export const workerPreset: GraphileConfig.Preset = {
  disablePlugins: ['LoadTaskFromJsPlugin', 'LoadTaskFromExecutableFilePlugin'],
};

export interface MigrateDatabaseResult extends MigrateResult {
  /** What Graphile Worker warned about, such as a queue newer than this release knows. */
  warnings: string[];
}

/**
 * Applies this package's migrations, then Graphile Worker's. A dry run lists ours and
 * changes nothing; Graphile Worker can't say what it would apply.
 */
export async function migrateDatabase(
  options: MigrateDatabaseOptions,
): Promise<MigrateDatabaseResult> {
  const result = await migrate(options);
  const warnings: string[] = [];
  if (options.dryRun !== true) {
    await runMigrations({
      connectionString: options.connectionString,
      preset: workerPreset,
      logger: new Logger(() => (level, message) => {
        if (level === 'error' || level === 'warning') {
          warnings.push(message);
        }
      }),
    });
  }
  return { ...result, warnings };
}
