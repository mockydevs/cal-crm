# packages/testing

Integration tests against a real Postgres 18, the image installs run, in Docker
(Testcontainers):
- one server per test run, with the install bootstrap and every migration applied to a
  template database;
- each test file gets its own copy of the template, so files run in parallel without
  seeing each other's rows. A copy is ready in well under a second (about 80 ms locally);
- `withTenant` runs work as `crm_app` with the tenant context set, as the API and the
  worker do, so row-level security applies;
- fixtures create agencies, users, businesses and contacts, each written by the role that
  writes it in the product.

It's a test-only package that exports its TypeScript source (a Turborepo
"Just-in-Time" package), and it doesn't depend on `@repo/db`: the global setup passes in
the bootstrap file and the migrations. Its own tests are in `packages/db`, which has the
migrations.

## Docker Desktop port allocation

The workspace applies a one-line pnpm patch to Testcontainers 12.2.0. For automatic
host ports it sends an empty `HostPort`, matching `docker run -p 8080`, instead of
`"0"`. Explicit host ports are unchanged. On this Windows Docker Desktop 29.8.2
host, the original binding reproduced an empty `NetworkSettings.Ports` mapping;
the empty binding published a real port. Both Ryuk and PostgreSQL were affected.
The patched setup and a real concurrent calendar reservation test pass without a
fixed port, disabled cleanup, or longer timeout.

Docker has an [open report of the matching port-allocation symptom](https://github.com/docker/desktop-feedback/issues/338).
The patch is registered through [pnpm's supported patch workflow](https://pnpm.io/cli/patch),
so fresh installs apply it from the lockfile. Recheck it when upgrading
Testcontainers or Docker; remove it only after the unpatched integration setup
and existing tests pass on the affected platform. The package version remains
12.2.0, with no changes to wait strategies or resource cleanup.

## Use it in a package

**1. A global setup** starts the server and hands its details to the test files:

```ts
// test/global-setup.ts
import { bootstrapFile, migrate } from '@repo/db';
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
    migrate: (connectionString) => migrate({ connectionString }),
  });
  project.provide('databaseServer', connection);
  return stop;
}
```

List it under `test.globalSetup` in the package's `vitest.integration.config.js`.

**2. Each test file** takes a database of its own:

```ts
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(() => database.close());

it('shows a business only its own contacts', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  await database.fixtures.contact(business.context, { firstName: 'Dana' });

  const contacts = await database.withTenant(business.context, (sql) =>
    sql.query('select first_name from crm.contacts'),
  );
  expect(contacts).toEqual([{ first_name: 'Dana' }]);
});
```

`database.url(role)` gives a connection string for code under test, `database.as(role,
work)` runs work with no tenant context, and `startPostgres` gives a bare server for
tests that need databases without migrations (the migration runner's own tests).

## An S3-compatible server

`startS3()` starts Garage, an S3-compatible store, in Docker, with one key and one bucket. It returns the server's
details (endpoint, region, bucket and credentials) and a `stop` function. Its tests are in
`packages/adapters/storage`, which uses it.
