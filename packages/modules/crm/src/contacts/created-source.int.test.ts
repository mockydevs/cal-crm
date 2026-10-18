// How a contact came to be is set once, by the command that makes it, against a migrated
// Postgres as crm_app under row-level security.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import { contactSources, createContactInput, type ContactSource } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, type ActorKind } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { createContact } from './contacts.js';
import { intakeContact } from './intake.js';
import { contactRoutes } from './routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function business(): Promise<(actorKind: ActorKind) => Invocation> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  return (actorKind) => ({
    context: { ...created.context, actorKind, correlationId: randomUUID() },
    permissions: 'all',
  });
}
const sourceOf = (id: string) =>
  database.as('crm_owner', async (sql) => {
    const row = await sql.one<{ created_source: string }>(
      'select created_source from crm.contacts where id = $1',
      [id],
    );
    return row.created_source;
  });

// As the modules that act for the system or for the contact call it: with the way the
// contact came to be, or with none.
const said = z.strictObject({
  firstName: z.string(),
  source: z.enum(contactSources).optional(),
  through: z.enum(['create', 'intake']),
});
const made = defineCommand({
  name: 'test.contact.made',
  permission: 'contacts.manage',
  input: said,
  async handle(trx, input, command): Promise<string> {
    const contact = createContactInput.parse({
      firstName: input.firstName,
      emails: [`${randomUUID()}@example.test`],
    });
    if (input.through === 'create') {
      const created = await createContact(trx, contact, command, input.source);
      return parsePublicId('contact', created.id) ?? '';
    }
    return (await intakeContact(trx, contact, command, input.source)).contactId;
  },
});

it('is the kind of actor when that says it, and unknown when it does not', async () => {
  const as = await business();
  const cases: readonly (readonly [ActorKind, ContactSource])[] = [
    ['user', 'user'],
    ['api_key', 'api'],
    ['form', 'form'],
    ['import', 'import'],
    ['automation', 'automation'],
    ['system', 'unknown'],
    ['contact', 'unknown'],
  ];
  for (const [actorKind, source] of cases) {
    // A form's contact comes through intake, as forms.submit makes it.
    const through = actorKind === 'form' ? 'intake' : 'create';
    const id = await runCommand(services, made, { firstName: actorKind, through }, as(actorKind));
    expect(await sourceOf(id), actorKind).toBe(source);
  }
  // An assistant has no command that makes a contact today: the command layer refuses it
  // before any handler runs, so `assistant` is a source nothing writes yet.
  await expect(
    runCommand(services, made, { firstName: 'Assistant', through: 'create' }, as('ai_agent')),
  ).rejects.toMatchObject({ name: 'ForbiddenError' });
});

it('is what the module that makes the contact says, for the system and for the contact themselves', async () => {
  const as = await business();
  for (const [actorKind, through, source] of [
    ['system', 'create', 'email'],
    ['system', 'create', 'sms'],
    ['contact', 'create', 'webchat'],
    ['contact', 'intake', 'booking'],
  ] as const) {
    const id = await runCommand(
      services,
      made,
      { firstName: source, source, through },
      as(actorKind),
    );
    expect(await sourceOf(id), source).toBe(source);
  }
});

it('is never the caller’s to choose over the API, and never changes afterwards', async () => {
  const as = await business();
  const route = (operationId: string) => {
    const found = contactRoutes.find((each) => each.endpoint.operationId === operationId);
    if (found === undefined) throw new Error(`Missing ${operationId}`);
    return found;
  };
  const request = (body: unknown, params: unknown = {}) => ({
    invocation: as('api_key'),
    params,
    query: {},
    body,
  });
  await expect(
    route('createContact').run(request({ firstName: 'Claimed', createdSource: 'form' }), services),
  ).rejects.toMatchObject({ name: 'ValidationError' });
  const created = z
    .looseObject({ id: z.string(), source: z.string() })
    .parse(
      await route('createContact').run(request({ firstName: 'Keyed', source: 'form' }), services),
    );
  expect(created.source).toBe('form');
  const id = parsePublicId('contact', created.id) ?? '';
  expect(await sourceOf(id)).toBe('api');
  // A person edits it: who made it, and how, stay.
  await expect(async () =>
    route('updateContact').run(
      { ...request({ createdSource: 'form' }, { id: created.id }), invocation: as('user') },
      services,
    ),
  ).rejects.toMatchObject({ name: 'ValidationError' });
  const updated = z.looseObject({ source: z.string() }).parse(
    await route('updateContact').run(
      {
        ...request({ lastName: 'Edited', source: 'Referral' }, { id: created.id }),
        invocation: as('user'),
      },
      services,
    ),
  );
  expect(updated.source).toBe('Referral');
  expect(await sourceOf(id)).toBe('api');
});
