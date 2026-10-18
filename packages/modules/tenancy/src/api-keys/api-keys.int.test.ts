import { createHash, randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { apiKey, apiKeyList, createdApiKey } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { apiKeyRoutes, readApiKeyNames } from '../index.js';

let database: TestDatabase;
let db: Database;
let services: Services;

// The names the server would look up in the auth module; here, the ones a test gives.
const people = new Map<string, string>();
const routes = apiKeyRoutes({
  people: (_trx, ids) =>
    Promise.resolve(
      new Map(ids.flatMap((id) => (people.has(id) ? [[id, people.get(id) ?? '']] : []))),
    ),
});

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

function route(operationId: string) {
  const found = routes.find((each) => each.endpoint.operationId === operationId);
  if (found === undefined) throw new Error(`No route for ${operationId}.`);
  return found;
}

/** An admin of a new business, named, who may manage keys and tags. */
async function admin(): Promise<
  Invocation & { readonly business: { id: string; context: TenantContext } }
> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  people.set(user.id, 'Dana Brooks');
  return {
    business,
    context: {
      ...business.context,
      userId: user.id,
      actorKind: 'user',
      actorId: user.id,
      correlationId: randomUUID(),
    },
    permissions: new Set(['apps.manage', 'tags.manage']),
  };
}

const create = async (invocation: Invocation, body: unknown) =>
  createdApiKey.parse(
    await route('createApiKey').run({ invocation, params: {}, query: {}, body }, services),
  );

const list = async (invocation: Invocation) =>
  apiKeyList.parse(
    await route('listApiKeys').run(
      { invocation, params: {}, query: {}, body: undefined },
      services,
    ),
  ).items;

const revoke = (invocation: Invocation, id: string) =>
  route('revokeApiKey').run({ invocation, params: { id }, query: {}, body: undefined }, services);

const asOwner = <Row extends object>(text: string, values: unknown[]) =>
  database.as('crm_owner', (sql) => sql.query<Row>(text, values));

describe('POST /api-keys (api_key.create)', () => {
  it('makes a key, shows it once, and keeps only its hash and its start', async () => {
    const dana = await admin();

    const made = await create(dana, { name: ' Zapier ', scopes: ['tags.manage'] });

    expect(made.key).toMatch(/^crm_live_[0-9a-f]{64}$/);
    expect(made).toMatchObject({
      name: 'Zapier',
      prefix: made.key.slice(0, 21),
      scopes: ['tags.manage'],
      createdBy: 'Dana Brooks',
      lastUsedAt: null,
    });
    const [row] = await asOwner<{ key_hash: Buffer; key_prefix: string; business_id: string }>(
      'select key_hash, key_prefix, business_id from tenancy.api_keys where id = $1',
      [parsePublicId('api_key', made.id)],
    );
    expect(row?.key_hash.equals(createHash('sha256').update(made.key).digest())).toBe(true);
    expect(row).toMatchObject({ key_prefix: made.prefix, business_id: dana.business.id });
    // Nowhere else: not the audit log, not the event.
    const kept = await asOwner<{ input: unknown; payload: unknown }>(
      `select a.input, e.payload from audit.commands a, events.events e
       where a.correlation_id = $1 and e.correlation_id = $1`,
      [dana.context.correlationId],
    );
    expect(JSON.stringify(kept)).not.toContain(made.key.slice(21));
    expect(kept).toEqual([
      {
        input: { name: 'Zapier', scopes: ['tags.manage'] },
        payload: { name: 'Zapier', prefix: made.prefix, scopes: ['tags.manage'] },
      },
    ]);
  });

  it("can't give a key a permission its maker doesn't have", async () => {
    const dana = await admin();

    const attempt = create(dana, { name: 'Zapier', scopes: ['tags.manage', 'team.manage'] });

    await expect(attempt).rejects.toThrow(ValidationError);
    await expect(attempt).rejects.toMatchObject({
      issues: [{ path: '/scopes', code: 'not_yours' }],
    });
    expect(await list(dana)).toEqual([]);
  });

  it('lets the system give a key any permission a key may have', async () => {
    const dana = await admin();

    const made = await create(
      { ...dana, permissions: 'all' },
      { name: 'Everything', scopes: ['files.upload', 'tags.manage', 'team.manage'] },
    );

    expect(made.scopes).toEqual(['files.upload', 'tags.manage', 'team.manage']);
  });

  it('requires an actual agency membership before a business user can mint an agency key', async () => {
    const dana = await admin();
    const { businessId: _none, ...atTheAgency } = dana.context;

    await expect(
      create({ ...dana, context: atTheAgency }, { name: 'Zapier', scopes: ['tags.manage'] }),
    ).rejects.toThrow('An agency role is required to create an agency key.');
  });

  it('stores selected read-only access and expiry without inventing a write grant', async () => {
    const dana = await admin();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const made = await create(dana, {
      name: 'Read contacts',
      scopes: [],
      readOnly: true,
      readGroups: ['Contacts'],
      expiresAt,
    });
    expect(made).toMatchObject({
      scope: 'business',
      readOnly: true,
      readGroups: ['Contacts'],
      expiresAt,
    });
    const [row] = await asOwner<{
      scopes: string[];
      read_only: boolean;
      read_groups: string[];
      expires_at: Date;
    }>('select scopes,read_only,read_groups,expires_at from tenancy.api_keys where id=$1', [
      parsePublicId('api_key', made.id),
    ]);
    expect(row).toEqual({
      scopes: [],
      read_only: true,
      read_groups: ['Contacts'],
      expires_at: new Date(expiresAt),
    });
  });

  it('refuses agency-only scopes in a business key, even for a trusted all-grants invocation', async () => {
    const dana = await admin();
    await expect(
      create(
        { ...dana, permissions: 'all' },
        { name: 'Wrong account', scopes: ['businesses.create'] },
      ),
    ).rejects.toMatchObject({ issues: [{ path: '/scopes', code: 'wrong_scope' }] });
    expect(await list(dana)).toEqual([]);
  });

  it('never lets a key create another key even if the caller fabricates all command grants', async () => {
    const dana = await admin();
    await expect(
      create(
        { ...dana, context: { ...dana.context, actorKind: 'api_key' }, permissions: 'all' },
        { name: 'Child', scopes: ['tags.manage'] },
      ),
    ).rejects.toThrow('Only a person or the system can manage API keys.');
  });
});

describe('agency key delegation', () => {
  async function staff() {
    const dana = await admin();
    await asOwner(
      `with role as (
      insert into tenancy.roles (agency_id,scope,key,name,is_builtin,permissions)
      values ($1,'agency','integrations','Integrations',false,array['apps.manage','businesses.create','tags.manage']) returning id)
      insert into tenancy.memberships (agency_id,business_id,user_id,role_id) select $1,null,$2,id from role`,
      [dana.context.agencyId, dana.context.userId],
    );
    const { businessId: _none, ...context } = dana.context;
    return {
      ...dana,
      context,
      permissions: new Set(['apps.manage', 'businesses.create'] as const),
    };
  }

  it('uses the agency role grants at both scopes without requiring a business ID', async () => {
    const user = await staff();
    const made = await create(user, {
      name: 'Agency bot',
      scopes: ['businesses.create', 'tags.manage'],
      readGroups: ['Businesses', 'Tags'],
    });
    expect(made).toMatchObject({ scope: 'agency', scopes: ['businesses.create', 'tags.manage'] });
    const [row] = await asOwner<{ business_id: string | null }>(
      'select business_id from tenancy.api_keys where id=$1',
      [parsePublicId('api_key', made.id)],
    );
    expect(row?.business_id).toBeNull();
    expect((await list(user)).map((key) => key.id)).toEqual([made.id]);
    expect(
      await list({ ...user, context: { ...user.context, businessId: user.business.id } }),
    ).toEqual([]);
  });

  it('does not delegate a business grant the actual agency role lacks', async () => {
    const user = await staff();
    await expect(
      create(user, { name: 'Too much', scopes: ['contacts.manage'] }),
    ).rejects.toMatchObject({ issues: [{ path: '/scopes', code: 'not_yours' }] });
    expect(await list(user)).toEqual([]);
  });

  it('rechecks key-management permission when the actual agency role changed after authentication', async () => {
    const user = await staff();
    await asOwner(
      "update tenancy.roles set permissions=array['tags.manage'] where agency_id=$1 and key='integrations'",
      [user.context.agencyId],
    );
    await expect(
      create(user, { name: 'Stale manager', scopes: ['tags.manage'] }),
    ).rejects.toMatchObject({ permission: 'apps.manage' });
    expect(await list({ ...user, permissions: new Set() })).toEqual([]);
  });
});

describe('key-only self context', () => {
  it('reports only the actual key account and access policy, with no raw key or user impersonation', async () => {
    const dana = await admin();
    const made = await create(dana, {
      name: 'Reader',
      scopes: [],
      readOnly: true,
      readGroups: ['Contacts'],
    });
    const { userId: _person, ...account } = dana.context;
    const invocation: Invocation = {
      context: {
        ...account,
        actorKind: 'api_key',
        actorId: parsePublicId('api_key', made.id) ?? '',
      },
      permissions: new Set(),
    };
    const read = () =>
      route('getApiKeyContext').run(
        { invocation, params: {}, query: {}, body: undefined },
        services,
      );
    const context = await read();
    expect(context).toMatchObject({
      scope: 'business',
      business: { id: toPublicId('business', dana.business.id) },
      scopes: [],
      readOnly: true,
      readGroups: ['Contacts'],
      expiresAt: null,
    });
    expect(JSON.stringify(context)).not.toContain(made.key);
    await expect(
      route('getApiKeyContext').run(
        { invocation: dana, params: {}, query: {}, body: undefined },
        services,
      ),
    ).rejects.toThrow('Use an API key');
    await revoke(dana, made.id);
    await expect(read()).rejects.toThrow('no longer has access');
  });
});

describe('GET /api-keys', () => {
  it('says whether the reader may manage keys, and which permissions they may give one', async () => {
    const dana = await admin();
    const member: Invocation = { ...dana, permissions: new Set(['tags.manage']) };

    const managing = await route('listApiKeys').run(
      { invocation: dana, params: {}, query: {}, body: undefined },
      services,
    );
    const looking = await route('listApiKeys').run(
      { invocation: member, params: {}, query: {}, body: undefined },
      services,
    );
    const everything = await route('listApiKeys').run(
      { invocation: { ...dana, permissions: 'all' }, params: {}, query: {}, body: undefined },
      services,
    );

    expect(apiKeyList.parse(managing)).toMatchObject({ canManage: true, scopes: ['tags.manage'] });
    expect(apiKeyList.parse(looking)).toMatchObject({ canManage: false, scopes: ['tags.manage'] });
    expect(apiKeyList.parse(everything)).toMatchObject({
      canManage: true,
      scopes: [
        'appointments.manage',
        'automations.manage',
        'automations.publish',
        'business.profile',
        'calendars.manage',
        'calls.place',
        'calls.read',
        'campaigns.manage',
        'campaigns.send',
        'companies.manage',
        'contacts.export',
        'contacts.import',
        'contacts.manage',
        'contacts.merge',
        'conversations.manage',
        'conversations.reply',
        'deals.manage',
        'domains.manage',
        'email.verification.manage',
        'fields.manage',
        'fields.values',
        'files.upload',
        'forms.manage',
        'mailboxes.manage',
        'media.manage',
        'notes.manage',
        'objects.manage',
        'payments.manage',
        'payments.read',
        'phone.manage',
        'pipelines.manage',
        'records.manage',
        'reports.manage',
        'reports.view',
        'sites.manage',
        'sites.publish',
        'sites.share',
        'sms.manage',
        'tags.configure',
        'tags.manage',
        'tasks.manage',
        'team.manage',
        'templates.manage',
        'trash.purge',
        'webchat.manage',
      ],
    });
  });

  it("lists the business's keys that still work, newest first, never with the key", async () => {
    const dana = await admin();
    const other = await admin();
    const first = await create(dana, { name: 'Zapier', scopes: ['tags.manage'] });
    const second = await create(dana, { name: 'Reports', scopes: ['tags.manage'] });
    const gone = await create(dana, { name: 'Old', scopes: ['tags.manage'] });
    await revoke(dana, gone.id);
    await create(other, { name: 'Theirs', scopes: ['tags.manage'] });
    // A key for the whole agency shows inside its businesses under row-level security.
    await asOwner(
      `insert into tenancy.api_keys (agency_id, name, key_prefix, key_hash, scopes)
       values ($1, 'Agency-wide', 'crm_live_agencywide1', sha256('agency'::bytea), array['tags.manage'])`,
      [dana.context.agencyId],
    );

    const keys = await list(dana);

    expect(keys.map((each) => each.name)).toEqual(['Reports', 'Zapier']);
    expect(keys.map((each) => each.id)).toEqual([second.id, first.id]);
    for (const each of keys) {
      expect(apiKey.strict().safeParse(each).success).toBe(true);
    }
  });
});

describe('DELETE /api-keys/{id} (api_key.revoke)', () => {
  it('revokes the key, as an event, and only once', async () => {
    const dana = await admin();
    const made = await create(dana, { name: 'Zapier', scopes: ['tags.manage'] });
    const revoking = { ...dana, context: { ...dana.context, correlationId: randomUUID() } };

    await revoke(revoking, made.id);

    const [row] = await asOwner<{ revoked: boolean }>(
      'select revoked_at is not null as revoked from tenancy.api_keys where id = $1',
      [parsePublicId('api_key', made.id)],
    );
    expect(row).toEqual({ revoked: true });
    expect(
      await asOwner<{ type: string; payload: unknown }>(
        'select type, payload from events.events where correlation_id = $1',
        [revoking.context.correlationId],
      ),
    ).toEqual([{ type: 'api_key.revoked', payload: { name: 'Zapier', prefix: made.prefix } }]);
    await expect(revoke(dana, made.id)).rejects.toThrow(NotFoundError);
  });

  it("finds only the business's own keys", async () => {
    const dana = await admin();
    const other = await admin();
    const theirs = await create(other, { name: 'Theirs', scopes: ['tags.manage'] });

    await expect(revoke(dana, theirs.id)).rejects.toThrow(NotFoundError);
    expect((await list(other)).map((each) => each.id)).toEqual([theirs.id]);
  });
});

describe('readApiKeyNames', () => {
  it('names the keys the reader can see, revoked ones too, for activity', async () => {
    const dana = await admin();
    const other = await admin();
    const made = await create(dana, { name: 'Zapier', scopes: ['tags.manage'] });
    await revoke(dana, made.id);
    const theirs = await create(other, { name: 'Theirs', scopes: ['tags.manage'] });
    const ids = [made.id, theirs.id].map((id) => parsePublicId('api_key', id) ?? '');

    const names = await withTenant(db, dana.context, (trx) => readApiKeyNames(trx, ids));

    expect(names).toEqual(new Map([[ids[0], 'Zapier']]));
    expect(await withTenant(db, dana.context, (trx) => readApiKeyNames(trx, []))).toEqual(
      new Map(),
    );
  });
});

it('runs every change through a command that needs apps.manage', () => {
  expect(
    routes.flatMap((each) =>
      each.command === undefined ? [] : [[each.command.name, each.command.permission]],
    ),
  ).toEqual([
    ['api_key.create', 'apps.manage'],
    ['api_key.revoke', 'apps.manage'],
  ]);
});
