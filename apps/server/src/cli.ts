// What the server's commands share: node dist/install.js and node dist/vault.js.
import { connectDatabase, type Database } from '@repo/db';

export interface Output {
  write(text: string): unknown;
}

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A command's database connection. A connection that drops fails the query using it, which
 * the command reports, so the pool has nothing more to say.
 */
export function connectForCommand(connectionString: string): Database {
  return connectDatabase({ connectionString, onConnectionError: () => undefined });
}
