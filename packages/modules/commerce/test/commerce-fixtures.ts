// What the commerce module's Postgres tests share: a business with a contact and someone
// who may do everything, the module's routes run as the server runs them (with tenancy's
// and the CRM's own readers handed over), and a clock the test sets.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation } from '@repo/commands';
import type { Permission } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { readContact, readDeal } from '@repo/module-crm';
import { holdActiveBusiness, readBusinessProfile } from '@repo/module-tenancy';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, inject } from 'vitest';

import { createCommerceRoutes } from '../src/index.js';

export interface CommerceFixture {
  readonly agency: { readonly id: string };
  readonly business: Awaited<ReturnType<TestDatabase['fixtures']['business']>>;
  /** Someone who may do everything in the business. */
  readonly manager: Invocation;
  /** The same person with only these permissions. */
  readonly withPermissions: (...permissions: Permission[]) => Invocation;
  /** A contact of the business, by its public id. */
  readonly contactId: string;
  readonly contact: { readonly id: string };
}

export interface CommerceSuite {
  readonly database: TestDatabase;
  readonly db: Database;
  readonly fixture: (contact?: {
    firstName?: string;
    lastName?: string;
    email?: string;
  }) => Promise<CommerceFixture>;
  /** Runs one of the module's routes, as the given person or the manager. */
  readonly api: (
    f: CommerceFixture,
    operationId: string,
    input?: { readonly params?: unknown; readonly query?: unknown; readonly body?: unknown },
    invocation?: Invocation,
  ) => Promise<unknown>;
  /** Sets the moment the module takes as now. */
  readonly at: (to: string) => void;
}

/** The moment the suite's clock starts at: a Monday morning in Nairobi and in UTC. */
export const NOW = '2026-10-12T09:30:00.000Z';

/**
 * A suite of the module's routes. On the real clock when asked, as the server runs them;
 * otherwise on a clock the test sets, starting at NOW.
 */
export function commerceSuite(clock: 'set' | 'real' = 'set'): CommerceSuite {
  let database: TestDatabase;
  let db: Database;
  let moment = new Date(NOW);
  beforeAll(async () => {
    database = await testDatabase(inject('databaseServer'));
    db = connectDatabase({
      connectionString: database.url('crm_app'),
      onConnectionError: () => undefined,
    });
  });
  afterAll(async () => {
    await db.destroy();
    await database.close();
  });

  const routes = createCommerceRoutes({
    business: { holdActive: holdActiveBusiness, profile: readBusinessProfile },
    contacts: { read: readContact },
    deals: { read: readDeal },
    ...(clock === 'real' ? {} : { now: () => moment }),
  });

  const fixture: CommerceSuite['fixture'] = async (
    contact = { firstName: 'Maya', lastName: 'Thompson', email: 'maya@example.com' },
  ) => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const user = await database.fixtures.user();
    const made = await database.fixtures.contact(business.context, contact);
    const context = {
      ...business.context,
      actorKind: 'user' as const,
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    };
    return {
      agency,
      business,
      manager: { context, permissions: 'all' },
      withPermissions: (...permissions) => ({ context, permissions: new Set(permissions) }),
      contact: made,
      contactId: toPublicId('contact', made.id),
    };
  };

  const api: CommerceSuite['api'] = async (f, operationId, input = {}, invocation = f.manager) => {
    const route = routes.find((candidate) => candidate.endpoint.operationId === operationId);
    if (route === undefined) throw new Error(`Missing ${operationId} route.`);
    // Each request has its own correlation id, as the server gives it.
    return route.run(
      {
        invocation: {
          ...invocation,
          context: { ...invocation.context, correlationId: randomUUID() },
        },
        params: input.params ?? {},
        query: input.query ?? {},
        body: input.body,
      },
      { db, authorize: allowEveryone },
    );
  };

  return {
    get database() {
      return database;
    },
    get db() {
      return db;
    },
    fixture,
    api,
    at(to) {
      moment = new Date(to);
    },
  };
}

export const settled = <T>(
  attempt: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  attempt.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/** A refusal as a rejection, whether the route threw before or after it returned a promise. */
export const attempt = <T>(work: () => Promise<T>): Promise<T> => Promise.resolve().then(work);

/** The refusal itself, when it is of the kind expected. */
export async function refusalOf<Refusal extends Error>(
  work: () => Promise<unknown>,
  kind: abstract new (...parameters: never[]) => Refusal,
): Promise<Refusal> {
  const result = await settled(attempt(work));
  if (result.ok) throw new Error('Nothing was refused.');
  if (!(result.error instanceof kind)) throw result.error;
  return result.error;
}
