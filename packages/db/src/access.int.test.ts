import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  connectDatabase,
  explainUniqueViolation,
  withTenant,
  type Database,
  type DatabaseTransaction,
} from './index.js';

let database: TestDatabase;
// One connection, so every transaction reuses the connection the last one used.
let app: Database;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  app = connectDatabase({
    connectionString: database.url('crm_app'),
    maxConnections: 1,
    onConnectionError: () => undefined,
  });
});

afterAll(async () => {
  await app.destroy();
  await database.close();
});

async function businessWithContact(firstName: string) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  await database.fixtures.contact(business.context, { firstName });
  return business;
}

const firstNames = (context: TenantContext) =>
  withTenant(app, context, (trx) =>
    trx.selectFrom('crm.contacts').select('first_name').orderBy('first_name').execute(),
  );

describe('withTenant', () => {
  it('reads one moment of the database throughout, and writes nothing, when asked for a snapshot', async () => {
    const harbor = await businessWithContact('Ada');
    const names = (trx: DatabaseTransaction) =>
      sql<{ first_name: string }>`select first_name from crm.contacts order by first_name`
        .execute(trx)
        .then(({ rows }) => rows.map((row) => row.first_name));
    const add = (firstName: string) => database.fixtures.contact(harbor.context, { firstName });
    const seen = await withTenant(
      app,
      harbor.context,
      async (trx) => {
        const before = await names(trx);
        await add('Bea');
        return { before, after: await names(trx) };
      },
      { snapshot: true },
    );
    // What was added meanwhile is not seen: both reads are of the same moment.
    expect(seen).toEqual({ before: ['Ada'], after: ['Ada'] });
    // Without a snapshot each statement sees what is committed when it runs.
    const moving = await withTenant(app, harbor.context, async (trx) => {
      const before = await names(trx);
      await add('Cy');
      return { before, after: await names(trx) };
    });
    expect(moving).toEqual({ before: ['Ada', 'Bea'], after: ['Ada', 'Bea', 'Cy'] });
    await expect(
      withTenant(
        app,
        harbor.context,
        (trx) => sql`update crm.contacts set first_name = 'Dee'`.execute(trx),
        { snapshot: true },
      ),
    ).rejects.toThrow(/read-only transaction/);
  });

  it("shows the rows of the context's business", async () => {
    const harbor = await businessWithContact('Dana');
    await businessWithContact('Ravi');

    expect(await firstNames(harbor.context)).toEqual([{ first_name: 'Dana' }]);
  });

  it('sets every part of the context, as the database reads it', async () => {
    const harbor = await businessWithContact('Dana');
    const user = await database.fixtures.user();
    const context: TenantContext = {
      ...harbor.context,
      userId: user.id,
      actorKind: 'user',
      actorId: user.id,
      correlationId: randomUUID(),
    };

    const { rows } = await withTenant(app, context, (trx) =>
      sql<Record<string, string>>`
        select app.agency_id() as "agencyId", app.business_id() as "businessId",
               app.user_id() as "userId", app.actor_kind() as "actorKind",
               app.actor_id() as "actorId", app.correlation_id() as "correlationId"`.execute(trx),
    );

    expect(rows).toEqual([context]);
  });

  it('commits the work, or nothing at all when it fails', async () => {
    const harbor = await businessWithContact('Dana');
    const addTag = (name: string) =>
      withTenant(app, harbor.context, async (trx) => {
        await trx
          .insertInto('crm.tags')
          .values({ business_id: harbor.id, name, created_by_kind: 'system' })
          .execute();
        if (name === 'Doomed') {
          throw new Error('the work failed');
        }
      });

    await addTag('Kept');
    await expect(addTag('Doomed')).rejects.toThrow('the work failed');

    const tags = await withTenant(app, harbor.context, (trx) =>
      trx.selectFrom('crm.tags').select('name').execute(),
    );
    expect(tags).toEqual([{ name: 'Kept' }]);
  });
});

describe('without a tenant context', () => {
  it('every table reads as empty', async () => {
    await businessWithContact('Dana');

    expect(await app.selectFrom('crm.contacts').selectAll().execute()).toEqual([]);
  });

  it('even on the connection the last tenant transaction used', async () => {
    const harbor = await businessWithContact('Dana');
    const bakery = await businessWithContact('Ravi');

    expect(await firstNames(harbor.context)).toEqual([{ first_name: 'Dana' }]);
    expect(await app.selectFrom('crm.contacts').selectAll().execute()).toEqual([]);
    expect(await firstNames(bakery.context)).toEqual([{ first_name: 'Ravi' }]);
  });
});

describe('the authentication connection (crm_auth)', () => {
  it('finds users before any tenant context exists', async () => {
    const user = await database.fixtures.user();
    const auth = connectDatabase({
      connectionString: database.url('crm_auth'),
      onConnectionError: () => undefined,
    });
    try {
      const found = await auth
        .selectFrom('auth.users')
        .select('id')
        .where('email_normalized', '=', user.email)
        .execute();
      expect(found).toEqual([{ id: user.id }]);
    } finally {
      await auth.destroy();
    }
  });
});

describe('bigintAsNumber', () => {
  const values = async (bigintAsNumber: boolean) => {
    const auth = connectDatabase({
      connectionString: database.url('crm_auth'),
      onConnectionError: () => undefined,
      bigintAsNumber,
    });
    try {
      const { rows } = await sql<{
        millis: unknown;
      }>`select 1791384168797::bigint as millis`.execute(auth);
      return rows;
    } finally {
      await auth.destroy();
    }
  };

  it("returns bigint as a number when asked, and as node-postgres's string otherwise", async () => {
    expect(await values(true)).toEqual([{ millis: 1791384168797 }]);
    expect(await values(false)).toEqual([{ millis: '1791384168797' }]);
  });

  it('refuses a bigint too large for a JavaScript number, rather than round it', async () => {
    const auth = connectDatabase({
      connectionString: database.url('crm_auth'),
      onConnectionError: () => undefined,
      bigintAsNumber: true,
    });
    try {
      await expect(sql`select 9007199254740993::bigint as too_large`.execute(auth)).rejects.toThrow(
        '9007199254740993 is too large to be a JavaScript number.',
      );
    } finally {
      await auth.destroy();
    }
  });
});

describe('a connection that fails, as when Postgres restarts', () => {
  // A pool of its own, so the failures stay out of the other tests.
  function watchedDatabase() {
    const errors: Error[] = [];
    const { promise: failed, resolve } = Promise.withResolvers<Error>();
    const db = connectDatabase({
      connectionString: database.url('crm_app'),
      onConnectionError: (error) => {
        errors.push(error);
        resolve(error);
      },
    });
    return { db, errors, failed };
  }

  async function terminateBackendOf(executor: Database | DatabaseTransaction): Promise<void> {
    const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(executor);
    // Waits until the backend has gone.
    await database.as('postgres', (superuser) =>
      superuser.one('select pg_terminate_backend($1, 5000) as terminated', [rows[0]?.pid]),
    );
  }

  const answers = (db: Database) => sql<{ ok: number }>`select 1 as ok`.execute(db);

  it('is reported once when it fails while idle, and the pool replaces it', async () => {
    const { db, errors, failed } = watchedDatabase();
    try {
      await terminateBackendOf(db);

      expect(await failed).toMatchObject({ code: '57P01' });
      expect((await answers(db)).rows).toEqual([{ ok: 1 }]);
      expect(errors).toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });

  it('is reported once when it fails during a transaction, which fails', async () => {
    const { db, errors, failed } = watchedDatabase();
    try {
      const transaction = db.transaction().execute(async (trx) => {
        await terminateBackendOf(trx);
        await failed;
        await sql`select 1`.execute(trx);
      });

      await expect(transaction).rejects.toThrow();
      expect(await failed).toMatchObject({ code: '57P01' });
      expect((await answers(db)).rows).toEqual([{ ok: 1 }]);
      expect(errors).toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });
});

describe('explainUniqueViolation', () => {
  async function duplicateTag(): Promise<unknown> {
    const harbor = await businessWithContact('Dana');
    const add = (name: string) =>
      withTenant(app, harbor.context, (trx) =>
        trx
          .insertInto('crm.tags')
          .values({ business_id: harbor.id, name, created_by_kind: 'system' })
          .execute(),
      );
    await add('Hot lead');
    return add('hot-lead').catch((caught: unknown) => caught);
  }
  const explain = (error: unknown, explanations: Record<string, () => Error>) => {
    try {
      explainUniqueViolation(explanations)(error);
    } catch (thrown) {
      return thrown;
    }
    throw new Error('expected it to throw');
  };

  it('turns a duplicate under a named constraint into the error given for it', async () => {
    const error = await duplicateTag();

    expect(
      explain(error, { tags_name_key_unique: () => new Error('A tag like this exists.') }),
    ).toEqual(new Error('A tag like this exists.'));
  });

  it('throws anything else unchanged', async () => {
    const duplicate = await duplicateTag();
    const other = new Error('something else');

    expect(explain(duplicate, { contacts_email_unique: () => new Error('unused') })).toBe(
      duplicate,
    );
    expect(explain(other, { tags_name_key_unique: () => new Error('unused') })).toBe(other);
  });
});
