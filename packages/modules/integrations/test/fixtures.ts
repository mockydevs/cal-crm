// What the integrations module's Postgres tests share: a database of the file's own, the
// crm_app pool, the two halves of the vault (the app's that seals and the worker's that
// opens), a business with people in it, and the worker's jobs run as the queue would.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  type AnyTask,
  type Grants,
  type Invocation,
  type Services,
} from '@repo/commands';
import { connectDatabase, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, inject } from 'vitest';

export interface Suite {
  readonly database: TestDatabase;
  readonly db: Database;
  readonly services: Services;
  readonly vault: Vault;
}

export function suite(): Suite {
  const shared: { database?: TestDatabase; db?: Database; vault?: Vault } = {};
  beforeAll(async () => {
    shared.database = await testDatabase(inject('databaseServer'));
    shared.db = connectDatabase({
      connectionString: shared.database.url('crm_app'),
      maxConnections: 4,
      onConnectionError: () => undefined,
    });
    shared.vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
  });
  afterAll(async () => {
    await shared.db?.destroy();
    await shared.database?.close();
  });
  const need = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error('The suite has not started yet.');
    return value;
  };
  return {
    get database() {
      return need(shared.database);
    },
    get db() {
      return need(shared.db);
    },
    get services() {
      return { db: need(shared.db), authorize: allowEveryone };
    },
    get vault() {
      return need(shared.vault);
    },
  };
}

export interface Place {
  readonly agencyId: string;
  readonly businessId: string;
  readonly slug: string;
  /** The worker, in the business. */
  readonly system: TenantContext;
  /** A person with these grants, made a member of the business. */
  readonly person: (grants?: Grants, name?: string) => Promise<Person>;
}

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly invocation: Invocation;
}

/** People's names, as the routes read them: whoever the test made. */
export const names = new Map<string, string>();
export function people(
  _trx: unknown,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  for (const id of ids) {
    const name = names.get(id);
    if (name !== undefined) found.set(id, name);
  }
  return Promise.resolve(found);
}

export async function place(suite: Suite): Promise<Place> {
  const { database } = suite;
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const { slug } = await database.as('crm_owner', (sql) =>
    sql.one<{ slug: string }>('select slug from tenancy.businesses where id = $1', [business.id]),
  );
  const system: TenantContext = {
    ...business.context,
    actorKind: 'system',
    correlationId: randomUUID(),
  };
  return {
    agencyId: agency.id,
    businessId: business.id,
    slug,
    system,
    async person(grants = new Set(['integrations.manage'] as const), name = 'Dana Brooks') {
      const user = await database.fixtures.user({ name });
      names.set(user.id, name);
      const context: TenantContext = {
        agencyId: agency.id,
        businessId: business.id,
        userId: user.id,
        actorKind: 'user',
        actorId: user.id,
        correlationId: randomUUID(),
      };
      return { id: user.id, name, invocation: { context, permissions: grants } };
    },
  };
}

/** Runs the queued jobs of these tasks as the worker would, until none are left. */
export async function work(suite: Suite, tasks: readonly AnyTask[]): Promise<string[]> {
  const byName = new Map(tasks.map((task) => [task.name, task]));
  const ran: string[] = [];
  for (let round = 0; round < 20; round += 1) {
    const received = await suite.database.runJobs([...byName.keys()]);
    if (received.length === 0) break;
    for (const job of received) {
      const envelope = job.payload as {
        agencyId: string;
        businessId: string;
        correlationId: string;
        data: unknown;
      };
      const task = byName.get(job.task);
      if (task === undefined) throw new Error(`No task ${job.task}.`);
      await task.run(task.data.parse(envelope.data), {
        invocation: {
          context: {
            agencyId: envelope.agencyId,
            businessId: envelope.businessId,
            actorKind: 'system',
            correlationId: envelope.correlationId,
          },
          permissions: 'all',
        },
        services: suite.services,
      });
      ran.push(job.task);
    }
  }
  return ran;
}
