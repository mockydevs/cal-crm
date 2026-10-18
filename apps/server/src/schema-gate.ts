// The app's wait at start: in a rolling deploy the old app keeps serving while the new one
// starts and the worker migrates. The new app answers /health only once the database has
// every migration its release brings, so the platform removes the old one only then.

/** The database didn't reach this release's schema in time; the platform keeps the old app. */
export class SchemaNotReadyError extends Error {
  override readonly name = 'SchemaNotReadyError';
}

export interface SchemaGateOptions {
  /** This release's migrations the database hasn't applied: missingMigrations as crm_app. */
  missing: () => Promise<string[]>;
  /** Where the gate says what it waits for: once each time that changes. */
  log: (message: string) => void;
  /** Between two looks: 2 seconds by default. */
  intervalMs?: number;
  /** How long it waits in all: 15 minutes by default, longer than a migration run's lock wait. */
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const INTERVAL_MS = 2_000;
const TIMEOUT_MS = 15 * 60 * 1000;

export async function waitForSchema(options: SchemaGateOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = options.intervalMs ?? INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const started = now();
  let lastSaid: string | undefined;
  for (;;) {
    let missing: string[];
    try {
      missing = await options.missing();
    } catch (error) {
      // Unreachable is not a schema answer: the app starts as it always has, and /ready says
      // the database doesn't answer. Only a database that names missing migrations holds it.
      options.log(
        `Couldn't check the database's migrations (${error instanceof Error ? error.message : String(error)}); starting, and /ready says whether the database answers.`,
      );
      return;
    }
    if (missing.length === 0) return;
    const waitingFor = missing.join(', ');
    const message = `Waiting for the database to have ${waitingFor} before serving.`;
    if (message !== lastSaid) {
      options.log(message);
      lastSaid = message;
    }
    if (now() - started >= timeoutMs) {
      throw new SchemaNotReadyError(
        `After ${String(Math.round(timeoutMs / 1000))} seconds the database still doesn't have ${waitingFor}. ` +
          'Check that the worker, which migrates, has started and finished.',
      );
    }
    await sleep(Math.min(intervalMs, timeoutMs - (now() - started)));
  }
}
