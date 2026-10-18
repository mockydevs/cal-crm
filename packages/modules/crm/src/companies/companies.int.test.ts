import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { company, companyList } from '@repo/contracts';
import { connectDatabase } from '@repo/db';
import { ConflictError, NotFoundError, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { crmRoutes } from '../index.js';

let database: TestDatabase;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  services = {
    db: connectDatabase({
      connectionString: database.url('crm_app'),
      onConnectionError: () => undefined,
    }),
    authorize: allowEveryone,
  };
});
afterAll(async () => {
  await services.db.destroy();
  await database.close();
});
async function fixture(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  return {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
}
async function call(operationId: string, invocation: Invocation, body?: unknown, id?: string) {
  const route = crmRoutes.find((item) => item.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return company.parse(
    await route.run(
      { invocation, body, params: id === undefined ? {} : { id }, query: {} },
      services,
    ),
  );
}

it('creates and reads a company, refusing its live domain twice in one business', async () => {
  const invocation = await fixture();
  const created = await call('createCompany', invocation, {
    name: ' Acme Events ',
    domain: 'ACME.EXAMPLE',
  });
  expect(created).toMatchObject({
    name: 'Acme Events',
    domain: 'acme.example',
    phone: null,
    trashedAt: null,
    canManage: true,
  });
  expect(created.id).toMatch(/^com_/);
  expect(await call('getCompany', invocation, undefined, created.id)).toEqual(created);
  await expect(
    call('createCompany', invocation, { name: 'Duplicate', domain: 'acme.example' }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(
    (
      await call('createCompany', await fixture(), {
        name: 'Another business',
        domain: 'acme.example',
      })
    ).domain,
  ).toBe('acme.example');
});

it('edits companies, retains trash, releases live domains and refuses a conflicting restore', async () => {
  const invocation = await fixture();
  const first = await call('createCompany', invocation, {
    name: 'Acme',
    domain: 'acme.example',
    phone: '+254712345678',
  });
  expect((await call('updateCompany', invocation, { name: 'Acme Events' }, first.id)).phone).toBe(
    '+254712345678',
  );
  const trashed = await call('trashCompany', invocation, undefined, first.id);
  expect(trashed.trashedAt).not.toBeNull();
  expect((await call('getCompany', invocation, undefined, first.id)).domain).toBe('acme.example');
  await expect(
    call('updateCompany', invocation, { domain: null }, first.id),
  ).rejects.toBeInstanceOf(ConflictError);
  const replacement = await call('createCompany', invocation, {
    name: 'Replacement',
    domain: 'acme.example',
  });
  await expect(call('restoreCompany', invocation, undefined, first.id)).rejects.toBeInstanceOf(
    ValidationError,
  );
  expect((await call('getCompany', invocation, undefined, first.id)).trashedAt).not.toBeNull();
  await call('updateCompany', invocation, { domain: null, phone: null }, replacement.id);
  expect((await call('restoreCompany', invocation, undefined, first.id)).trashedAt).toBeNull();
});

it('serializes simultaneous live-domain claims and hides foreign companies before validating edits', async () => {
  const invocation = await fixture();
  const claims = await Promise.allSettled([
    call('createCompany', invocation, { name: 'First', domain: 'race.example' }),
    call('createCompany', invocation, { name: 'Second', domain: 'RACE.EXAMPLE' }),
  ]);
  expect(claims.map((claim) => claim.status).sort()).toEqual(['fulfilled', 'rejected']);
  const rejected = claims.find((claim) => claim.status === 'rejected');
  expect(rejected?.reason).toBeInstanceOf(ValidationError);
  const foreign = await call('createCompany', await fixture(), { name: 'Private' });
  await expect(call('getCompany', invocation, undefined, foreign.id)).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(call('updateCompany', invocation, { name: '' }, foreign.id)).rejects.toBeInstanceOf(
    NotFoundError,
  );
});

it('pages live companies newest first and treats search punctuation literally', async () => {
  const invocation = await fixture();
  const created = [];
  for (let index = 0; index < 51; index++)
    created.push(
      await call('createCompany', invocation, {
        name: `Company ${String(index)}`,
        domain: `company-${String(index)}.example`,
      }),
    );
  const special = await call('createCompany', invocation, { name: '100% Events' });
  const route = crmRoutes.find((item) => item.endpoint.operationId === 'listCompanies');
  if (route === undefined) throw new Error('Missing listCompanies route.');
  const list = async (query: unknown) =>
    companyList.parse(
      await route.run({ invocation, params: {}, body: undefined, query }, services),
    );
  const first = await list({});
  const second = await list({ after: first.next });
  expect(first.items).toHaveLength(50);
  expect(first.items.map((item) => item.id).concat(second.items.map((item) => item.id))).toEqual(
    [special, ...created.toReversed()].map((item) => item.id),
  );
  expect(second.next).toBeNull();
  expect((await list({ q: '%' })).items.map((item) => item.name)).toEqual(['100% Events']);
  expect((await list({ q: 'COMPANY-50.EXAMPLE' })).items.map((item) => item.domain)).toEqual([
    'company-50.example',
  ]);
  await call('trashCompany', invocation, undefined, special.id);
  expect((await list({ q: '%' })).items).toEqual([]);
  const foreign = await call('createCompany', await fixture(), { name: 'Private' });
  await expect(list({ after: foreign.id })).rejects.toBeInstanceOf(ValidationError);
});
