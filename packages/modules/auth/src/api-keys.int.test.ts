import { createHash, randomBytes } from 'node:crypto';

import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createAuthentication, type Authentication } from './index.js';

let database: TestDatabase;
let auth: Authentication;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  auth = createAuthentication({
    connectionString: database.url('crm_auth'),
    secret: 'a-test-secret-of-at-least-32-characters',
    publicUrl: 'https://crm.example.test',
    onConnectionError: () => undefined,
    log: () => undefined,
    sendMail: () => Promise.resolve(),
  });
});

afterAll(async () => {
  await auth.close();
  await database.close();
});

const newKey = () => `crm_live_${randomBytes(32).toString('hex')}`;

/** A key stored as the API keys commands store one, in a new business. */
async function stored(
  values: {
    scopes?: string[];
    agencyWide?: boolean;
    readOnly?: boolean;
    readGroups?: string[] | null;
  } = {},
): Promise<{
  key: string;
  id: string;
  agencyId: string;
  businessId: string;
  businessSlug: string;
}> {
  const agency = await database.fixtures.agency();
  const businessSlug = `key-${randomBytes(8).toString('hex')}`;
  const business = await database.fixtures.business(agency.id, { slug: businessSlug });
  const key = newKey();
  const { id } = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.api_keys (agency_id, business_id, name, key_prefix, key_hash, scopes, read_only, read_groups)
       values ($1, $2, 'Zapier', $3, $4, $5, $6, $7) returning id`,
      [
        agency.id,
        values.agencyWide === true ? null : business.id,
        key.slice(0, 21),
        createHash('sha256').update(key).digest(),
        values.scopes ?? ['tags.manage'],
        values.readOnly ?? false,
        values.readGroups ?? null,
      ],
    ),
  );
  return { key, id, agencyId: agency.id, businessId: business.id, businessSlug };
}

const asOwner = (text: string, values: unknown[]) =>
  database.as('crm_owner', (sql) => sql.query(text, values));

const lastUsed = async (id: string) =>
  (
    await database.as('crm_owner', (sql) =>
      sql.one<{ last_used_at: Date | null }>(
        'select last_used_at from tenancy.api_keys where id = $1',
        [id],
      ),
    )
  ).last_used_at;

describe('apiKey', () => {
  it('finds a working key: its business, its permissions, and the key itself', async () => {
    const made = await stored({ scopes: ['tags.manage', 'files.upload'] });

    const access = await auth.apiKey(made.key);

    expect(access).toEqual({
      keyId: made.id,
      agencyId: made.agencyId,
      businessId: made.businessId,
      permissions: new Set(['tags.manage', 'files.upload']),
    });
  });

  it('refuses a key the moment it is revoked', async () => {
    const made = await stored();
    expect(await auth.apiKey(made.key)).toBeDefined();

    await asOwner('update tenancy.api_keys set revoked_at = now() where id = $1', [made.id]);

    expect(await auth.apiKey(made.key)).toBeUndefined();
  });

  it.each([
    [
      'expired',
      "update tenancy.api_keys set expires_at = now() - interval '1 second' where id = $1",
    ],
    [
      "in a business that's suspended",
      `update tenancy.businesses set status = 'suspended'
       where id = (select business_id from tenancy.api_keys where id = $1)`,
    ],
  ])('refuses a key that is %s', async (_case, change) => {
    const made = await stored();

    await asOwner(change, [made.id]);

    expect(await auth.apiKey(made.key)).toBeUndefined();
  });

  it('keeps an agency key at the agency until an active same-agency target is selected', async () => {
    const made = await stored({ agencyWide: true });
    expect(await auth.apiKey(made.key)).toEqual({
      keyId: made.id,
      agencyId: made.agencyId,
      scope: 'agency',
      permissions: new Set(['tags.manage']),
    });
    expect((await auth.apiKey(made.key, { businessId: made.businessId }))?.businessId).toBe(
      made.businessId,
    );
  });

  it.each([false, true])(
    'resolves active targets within the issuing agency (agency key: %s)',
    async (agencyWide) => {
      const made = await stored({ agencyWide });
      const siblingSlug = `sibling-${randomBytes(8).toString('hex')}`;
      const sibling = await database.fixtures.business(made.agencyId, { slug: siblingSlug });
      const foreignAgency = await database.fixtures.agency();
      const foreignSlug = `foreign-${randomBytes(8).toString('hex')}`;
      const foreign = await database.fixtures.business(foreignAgency.id, { slug: foreignSlug });

      expect((await auth.apiKey(made.key, { businessSlug: made.businessSlug }))?.businessId).toBe(
        made.businessId,
      );
      expect((await auth.apiKey(made.key, { businessId: made.businessId }))?.businessId).toBe(
        made.businessId,
      );
      for (const target of [{ businessId: sibling.id }, { businessSlug: siblingSlug }]) {
        const access = await auth.apiKey(made.key, target);
        if (agencyWide) expect(access?.businessId).toBe(sibling.id);
        else expect(access).toBeUndefined();
      }
      for (const target of [
        { businessId: foreign.id },
        { businessSlug: foreignSlug },
        { businessSlug: 'no-such-business' },
      ]) {
        expect(await auth.apiKey(made.key, target)).toBeUndefined();
      }
      expect(
        await auth.apiKey(made.key, {
          businessId: made.businessId,
          businessSlug: made.businessSlug,
        }),
      ).toBeUndefined();
      expect(await auth.apiKey(made.key, { businessSlug: 'Invalid Slug' })).toBeUndefined();
    },
  );

  it.each(['suspended', 'archived'])(
    'refuses %s targets without moving an agency key out of its own context',
    async (status) => {
      const made = await stored({ agencyWide: true });
      await asOwner('update tenancy.businesses set status = $2 where id = $1', [
        made.businessId,
        status,
      ]);
      expect(await auth.apiKey(made.key, { businessId: made.businessId })).toBeUndefined();
      expect(await auth.apiKey(made.key, { businessSlug: made.businessSlug })).toBeUndefined();
      expect(await auth.apiKey(made.key)).not.toHaveProperty('businessId');
    },
  );

  it('keeps concurrently selected businesses request-local', async () => {
    const made = await stored({ agencyWide: true });
    const siblingSlug = `concurrent-${randomBytes(8).toString('hex')}`;
    const sibling = await database.fixtures.business(made.agencyId, { slug: siblingSlug });
    const [own, other] = await Promise.all([
      auth.apiKey(made.key, { businessSlug: made.businessSlug }),
      auth.apiKey(made.key, { businessSlug: siblingSlug }),
    ]);
    expect(own?.businessId).toBe(made.businessId);
    expect(other?.businessId).toBe(sibling.id);
    expect(await auth.apiKey(made.key)).not.toHaveProperty('businessId');
  });

  it('authenticates a read-only key with selected groups and no native grants', async () => {
    const made = await stored({ scopes: [], readOnly: true, readGroups: ['Contacts', 'Files'] });
    expect(await auth.apiKey(made.key)).toEqual({
      keyId: made.id,
      agencyId: made.agencyId,
      businessId: made.businessId,
      readOnly: true,
      readGroups: ['Contacts', 'Files'],
      permissions: new Set(),
    });
  });

  it('fails closed for unknown stored read groups, including mixed known/unknown groups', async () => {
    const made = await stored({ readGroups: ['Contacts', 'Future privileged group'] });
    expect(await auth.apiKey(made.key)).toBeUndefined();
    expect(await lastUsed(made.id)).toBeNull();
  });

  it('filters unknown and person/security/key-management scopes on agency credentials', async () => {
    const made = await stored({
      agencyWide: true,
      scopes: [
        'businesses.create',
        'tags.manage',
        'apps.manage',
        'agency.security',
        'ai.manage',
        'assistant.use',
        'audit.read',
        'views.save',
        'contacts.everything',
      ],
    });
    expect((await auth.apiKey(made.key))?.permissions).toEqual(
      new Set(['businesses.create', 'tags.manage']),
    );
  });

  it.each([
    ['revoked', 'update tenancy.api_keys set revoked_at = now() where id = $1'],
    [
      'expired',
      "update tenancy.api_keys set expires_at = now() - interval '1 second' where id = $1",
    ],
  ])(
    'rechecks an agency credential that becomes %s after target selection',
    async (_case, change) => {
      const made = await stored({ agencyWide: true });
      expect(await auth.apiKey(made.key, { businessSlug: made.businessSlug })).toBeDefined();
      await asOwner(change, [made.id]);
      expect(await auth.apiKey(made.key)).toBeUndefined();
      expect(await auth.apiKey(made.key, { businessSlug: made.businessSlug })).toBeUndefined();
    },
  );

  it('looks up only the full token hash and never accepts the displayed prefix', async () => {
    const made = await stored();
    expect(await auth.apiKey(made.key.slice(0, 21))).toBeUndefined();
    const changed = `${made.key.slice(0, -1)}${made.key.endsWith('a') ? 'b' : 'a'}`;
    expect(await auth.apiKey(changed)).toBeUndefined();
    expect(await auth.apiKey(made.key)).toBeDefined();
  });

  it.each([
    ['a key nobody made', newKey()],
    ['something that is no key', 'Bearer something'],
    ['a key with a character too many', `${newKey()}0`],
  ])('refuses %s', async (_case, key) => {
    expect(await auth.apiKey(key)).toBeUndefined();
  });

  it('notes when a key was last used, at most once a minute', async () => {
    const made = await stored();

    await auth.apiKey(made.key);
    const first = await lastUsed(made.id);
    await auth.apiKey(made.key);

    expect(first).toBeInstanceOf(Date);
    expect(await lastUsed(made.id)).toEqual(first);

    await asOwner(
      "update tenancy.api_keys set last_used_at = now() - interval '2 minutes' where id = $1",
      [made.id],
    );
    const stale = await lastUsed(made.id);
    await auth.apiKey(made.key);

    expect((await lastUsed(made.id))?.getTime()).toBeGreaterThan(stale?.getTime() ?? 0);
  });

  it("gives a key only the permissions a key may have, whatever's stored", async () => {
    const made = await stored({
      scopes: ['tags.manage', 'apps.manage', 'businesses.create', 'contacts.everything'],
    });

    expect((await auth.apiKey(made.key))?.permissions).toEqual(new Set(['tags.manage']));
  });
});
