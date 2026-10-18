import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation } from '@repo/commands';
import { contactMemory } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { aiRoutes } from './index.js';

let database: TestDatabase;
let db: Database;
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
async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context);
  const invocation: Invocation = {
    context: { ...business.context, correlationId: randomUUID() },
    permissions: new Set(),
  };
  return { invocation, contactId: contact.id, id: toPublicId('contact', contact.id) };
}
async function read(invocation: Invocation, id: string) {
  const route = aiRoutes.find((each) => each.endpoint.operationId === 'getContactMemory');
  if (route === undefined) throw new Error('Missing getContactMemory route.');
  return contactMemory.parse(
    await route.run(
      { invocation, params: { id }, query: {}, body: undefined },
      { db, authorize: allowEveryone },
    ),
  );
}

it('reads saved contact memory, including in trash, without exposing the model or generating anything', async () => {
  const { invocation, contactId, id } = await fixture();
  expect(await read(invocation, id)).toEqual({ summary: null });
  await database.withTenant(invocation.context, async (sql) => {
    await sql.query(
      'insert into ai.contact_summaries (business_id, contact_id, summary, model, updated_at) values ($1, $2, $3, $4, $5)',
      [
        invocation.context.businessId,
        contactId,
        'Planning an outdoor wedding in October.',
        'private-model-name',
        '2026-10-08T10:00:00Z',
      ],
    );
    await sql.query('update crm.contacts set deleted_at = now() where id = $1', [contactId]);
  });
  expect(await read(invocation, id)).toEqual({
    summary: {
      text: 'Planning an outdoor wedding in October.',
      updatedAt: '2026-10-08T10:00:00.000Z',
      throughEventId: null,
    },
  });
});

it('hides foreign and missing contacts and refuses malformed ids and agency scope', async () => {
  const own = await fixture();
  const foreign = await fixture();
  await expect(read(own.invocation, foreign.id)).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    read(own.invocation, toPublicId('contact', '01890a5d-ac96-774b-bcce-b302099a8057')),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(read(own.invocation, 'con_wrong')).rejects.toBeInstanceOf(ValidationError);
  await expect(
    read(
      {
        ...own.invocation,
        context: {
          agencyId: own.invocation.context.agencyId,
          actorKind: 'system',
          correlationId: randomUUID(),
        },
      },
      own.id,
    ),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('retains the last covered event reference even when earlier history has been archived', async () => {
  const { invocation, contactId, id } = await fixture();
  const eventId = '01890a5d-ac96-774b-bcce-b302099a8057';
  await database.withTenant(invocation.context, (sql) =>
    sql.query(
      'insert into ai.contact_summaries (business_id, contact_id, summary, model, through_event_id) values ($1, $2, $3, $4, $5)',
      [
        invocation.context.businessId,
        contactId,
        'A returning customer.',
        'private-model-name',
        eventId,
      ],
    ),
  );
  expect((await read(invocation, id)).summary).toMatchObject({
    text: 'A returning customer.',
    throughEventId: toPublicId('event', eventId),
  });
});
