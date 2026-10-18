import { randomUUID } from 'node:crypto';
import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { connectDatabase, type Database } from '@repo/db';
import { ForbiddenError, NotFoundError, toPublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { businessProfileRoutes, updateProfileCommand } from './profile.js';

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

const body = {
  name: 'Harbor revised',
  timezone: 'Africa/Nairobi',
  currency: 'KES',
  locale: 'en-KE',
  address: {
    line1: '12 Market Road',
    line2: '',
    city: 'Nairobi',
    region: '',
    postalCode: '00100',
    country: 'KE',
  },
  logoFileId: null,
};
const noLogo = vi.fn(() => Promise.resolve());
const command = updateProfileCommand(noLogo);
async function workspace() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const invocation: Invocation = {
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
  return { agency, business, invocation };
}
async function read(invocation: Invocation) {
  const route = businessProfileRoutes(noLogo)[0];
  if (route === undefined) throw new Error('Missing read route.');
  return route.run({ invocation, params: {}, query: {}, body: undefined }, services);
}

describe('business profile', () => {
  it('reads, saves and clears optional settings, with an event and audit entry', async () => {
    const { invocation, business } = await workspace();
    expect(await read(invocation)).toMatchObject({
      id: toPublicId('business', business.id),
      address: null,
      logoFileId: null,
      canManage: true,
    });
    expect(await runCommand(services, command, body, invocation)).toMatchObject(body);
    expect(await read(invocation)).toMatchObject(body);
    await runCommand(services, command, { ...body, address: null }, invocation);
    expect(await read(invocation)).toMatchObject({ address: null });
    const events = await database.as('crm_owner', (sql) =>
      sql.query<{ type: string }>('select type from events.events where subject_id = $1', [
        business.id,
      ]),
    );
    expect(events).toEqual([
      { type: 'business.profile_updated' },
      { type: 'business.profile_updated' },
    ]);
    const audits = await database.as('crm_owner', (sql) =>
      sql.query('select id from audit.commands where command = $1 and business_id = $2', [
        'business.update_profile',
        business.id,
      ]),
    );
    expect(audits).toHaveLength(2);
  });
  it('reads an address stored with keys it does not know, or without some (1A review A6)', async () => {
    const { invocation, business } = await workspace();
    await database.as('crm_owner', (sql) =>
      sql.query(`update tenancy.businesses set address = $2::jsonb where id = $1`, [
        business.id,
        JSON.stringify({
          line1: '1 Harbour Road',
          city: 'Mombasa',
          county: 'Mombasa',
          country: 'KE',
        }),
      ]),
    );

    expect(await read(invocation)).toMatchObject({
      address: {
        line1: '1 Harbour Road',
        line2: '',
        city: 'Mombasa',
        region: '',
        postalCode: '',
        country: 'KE',
      },
    });
    expect(await read(invocation)).not.toHaveProperty('address.county');
  });

  it('shows read-only settings and refuses an ungranted change', async () => {
    const { invocation } = await workspace();
    const viewer: Invocation = { ...invocation, permissions: new Set() };
    expect(await read(viewer)).toMatchObject({ canManage: false });
    await expect(runCommand(services, command, body, viewer)).rejects.toThrow(ForbiddenError);
  });
  it('requires a selected business for reads and writes', async () => {
    const { invocation } = await workspace();
    const { businessId: _business, ...context } = invocation.context;
    await expect(read({ ...invocation, context })).rejects.toThrow('Choose a business first.');
    await expect(runCommand(services, command, body, { ...invocation, context })).rejects.toThrow(
      'Choose a business first.',
    );
  });
  it('does not let an agency-wide RLS view change another business', async () => {
    const { invocation, agency, business } = await workspace();
    const sibling = await database.fixtures.business(agency.id, { name: 'Untouched sibling' });
    await runCommand(services, command, body, invocation);
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ id: string; name: string }>(
        'select id, name from tenancy.businesses where agency_id = $1 order by id',
        [agency.id],
      ),
    );
    expect(rows).toContainEqual({ id: sibling.id, name: 'Untouched sibling' });
    expect(rows).toContainEqual({ id: business.id, name: body.name });
    const foreign = await workspace();
    const inaccessible = {
      ...invocation,
      context: { ...invocation.context, businessId: foreign.business.id },
    };
    await expect(read(inaccessible)).rejects.toThrow(NotFoundError);
    // A forged agency/business pair cannot be audited either: the audit FK rejects it.
    await expect(runCommand(services, command, body, inaccessible)).rejects.toThrow();
  });
  it('validates the logo inside the change transaction and rolls back on failure', async () => {
    const { invocation } = await workspace();
    const before = await read(invocation);
    const logoFileId = toPublicId('file', '0199b7d8-2000-7000-8000-000000000001');
    const refuse = vi.fn(() => Promise.reject(new NotFoundError('File', logoFileId)));
    await expect(
      runCommand(services, updateProfileCommand(refuse), { ...body, logoFileId }, invocation),
    ).rejects.toThrow(NotFoundError);
    expect(refuse).toHaveBeenCalledOnce();
    expect(await read(invocation)).toEqual(before);
  });
  it('returns the saved logo, and allows removing it without deleting the upload', async () => {
    const { invocation, agency, business } = await workspace();
    const file = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        "insert into files.files (agency_id,business_id,storage,storage_key,filename,content_type,size_bytes,sha256,uploaded_by_kind) values ($1,$2,'local',$3,'logo.png','image/png',10,$4,'system') returning id",
        [agency.id, business.id, randomUUID(), Buffer.alloc(32)],
      ),
    );
    const logoFileId = toPublicId('file', file.id);
    expect(await runCommand(services, command, { ...body, logoFileId }, invocation)).toMatchObject({
      logoFileId,
    });
    expect(await read(invocation)).toMatchObject({ logoFileId });
    await runCommand(services, command, body, invocation);
    expect(await read(invocation)).toMatchObject({ logoFileId: null });
    expect(
      await database.as('crm_owner', (sql) =>
        sql.query('select id from files.files where id = $1', [file.id]),
      ),
    ).toHaveLength(1);
  });
});
