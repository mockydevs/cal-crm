// The process: reads the configuration, starts the role and stops it cleanly on SIGTERM
// or SIGINT. In the container, tini passes Docker's SIGTERM on; Docker waits 10 seconds
// before SIGKILL, and the shutdown timeout stays under that. A worker that stops by itself
// takes the process down with it, so that Docker restarts it.
import { missingMigrations } from '@repo/db';
import { pino } from 'pino';

import { apiRoutes } from './api-routes.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { install } from './install-cli.js';
import { telemetry } from './instrumentation.js';
import { loggerOptions } from './logger.js';
import { SchemaNotReadyError, waitForSchema } from './schema-gate.js';
import { start } from './start.js';
import { workerTasks } from './worker-tasks.js';

function configFromEnvironment(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const config = configFromEnvironment();

// A worker deployed on its own migrates first, as the migrate container does.
if (config.migrateOnStart === true) {
  const exitCode = await install(process.env, process);
  if (exitCode !== 0) process.exit(exitCode);
}

// The app serves only once the database has this release's migrations, so in a rolling
// deploy the old app goes on serving until then.
if (config.role === 'app') {
  const logger = pino(loggerOptions(config));
  try {
    await waitForSchema({
      missing: () => missingMigrations({ connectionString: config.databaseAppUrl }),
      log: (message) => {
        logger.info(message);
      },
    });
  } catch (error) {
    if (!(error instanceof SchemaNotReadyError)) throw error;
    logger.fatal(error.message);
    process.exit(1);
  }
}

const running = await start(config, apiRoutes, workerTasks);

let stopping = false;
async function stop(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await running.stop();
    await telemetry?.shutdown();
    process.exit(exitCode);
  } catch (error) {
    process.stderr.write(`Shutdown failed: ${String(error)}\n`);
    process.exit(1);
  }
}

process.once('SIGTERM', () => void stop(0));
process.once('SIGINT', () => void stop(0));
// The worker has logged why it stopped.
void running.ended.then(() => stop(1));
