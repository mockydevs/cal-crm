// Starts one Postgres for the integration run and migrates the template each test file
// copies (@repo/testing). Test files read the server's details with inject('databaseServer').
import { bootstrapFile, migrateDatabase } from '@repo/db';
import { startDatabaseServer, type DatabaseServer } from '@repo/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseServer: DatabaseServer;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const { connection, stop } = await startDatabaseServer({
    bootstrapFile,
    migrate: (connectionString) => migrateDatabase({ connectionString }),
  });
  project.provide('databaseServer', connection);
  return stop;
}
