import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { eventEnvelope } from './index.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});

afterAll(async () => {
  await database.close();
});

const snakeCase = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

describe('eventEnvelope', () => {
  it('has a field for each column of events.events, and nothing else', async () => {
    const columns = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string; nullable: boolean }>(
        `select column_name as name, is_nullable = 'YES' as nullable
         from information_schema.columns
         where table_schema = 'events' and table_name = 'events'
         order by column_name collate "C"`,
      ),
    );

    const fields = Object.entries(eventEnvelope.shape)
      .map(([name, schema]) => ({
        name: snakeCase(name),
        nullable: schema.safeParse(null).success,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    expect(fields).toEqual(columns);
  });
});
