import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { company, contactCompanies, contactCompany, recordActivity } from '@repo/contracts';
import { connectDatabase } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { activityRoutes, crmRoutes } from '../index.js';

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
async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  await database.withTenant(business.context, (sql) =>
    sql.query(
      `insert into crm.link_types(business_id,key,from_object_type_id,to_object_type_id,label,reverse_label,allows_primary) select app.business_id(),'contact_company',c.id,o.id,'Company','Person',true from crm.object_types c cross join crm.object_types o where c.kind='contact' and o.kind='company'`,
    ),
  );
  const contact = await database.fixtures.contact(business.context);
  return {
    invocation: {
      context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
      permissions: 'all',
    } satisfies Invocation,
    id: toPublicId('contact', contact.id),
  };
}
async function call(
  operationId: string,
  invocation: Invocation,
  params: unknown = {},
  body?: unknown,
  query: unknown = {},
) {
  const route = [...crmRoutes, ...activityRoutes({ actorNames: {} })].find(
    (item) => item.endpoint.operationId === operationId,
  );
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, body, params, query }, services);
}
async function create(invocation: Invocation, name: string) {
  return company.parse(await call('createCompany', invocation, {}, { name }));
}

it('pages retained links without skipping companies and rejects unrelated cursors', async () => {
  const { invocation, id } = await fixture();
  const ids: string[] = [];
  for (let index = 0; index < 52; index++) {
    const saved = await create(invocation, `Company ${String(index)}`);
    ids.push(saved.id);
    await call('linkContactCompany', invocation, { id, companyId: saved.id }, {});
  }
  const first = contactCompanies.parse(await call('getContactCompanies', invocation, { id }));
  expect(first.items).toHaveLength(50);
  expect(first.next).not.toBeNull();
  const next = contactCompanies.parse(
    await call('getContactCompanies', invocation, { id }, undefined, { after: first.next }),
  );
  expect(next.items).toHaveLength(2);
  expect(next.next).toBeNull();
  expect(new Set([...first.items, ...next.items].map((item) => item.company.id))).toEqual(
    new Set(ids),
  );
  const unrelated = await create(invocation, 'Unlinked');
  await expect(
    call('getContactCompanies', invocation, { id }, undefined, { after: unrelated.id }),
  ).rejects.toBeInstanceOf(ValidationError);
  const foreign = await fixture();
  const foreignCompany = await create(foreign.invocation, 'Foreign');
  await expect(
    call('getContactCompanies', invocation, { id }, undefined, { after: foreignCompany.id }),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('refuses writes through missing, archived or incompatible link configuration without losing saved associations', async () => {
  for (const configuration of ['archived', 'no-primary', 'missing'] as const) {
    const { invocation, id } = await fixture();
    const saved = await create(invocation, 'Company');
    if (configuration !== 'missing')
      await call('linkContactCompany', invocation, { id, companyId: saved.id }, {});
    await database.withTenant(invocation.context, (sql) =>
      sql.query(
        configuration === 'missing'
          ? "delete from crm.link_types where key='contact_company'"
          : configuration === 'archived'
            ? "update crm.link_types set archived_at=now() where key='contact_company'"
            : "update crm.link_types set allows_primary=false where key='contact_company'",
      ),
    );
    await expect(
      call('linkContactCompany', invocation, { id, companyId: saved.id }, { primary: true }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      call('unlinkContactCompany', invocation, { id, companyId: saved.id }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      contactCompanies.parse(await call('getContactCompanies', invocation, { id })).items,
    ).toHaveLength(configuration === 'missing' ? 0 : 1);
  }
});

it('links companies and atomically moves the sole primary while retaining every association', async () => {
  const { invocation, id } = await fixture();
  const first = await create(invocation, 'First');
  const second = await create(invocation, 'Second');
  expect(
    contactCompany.parse(
      await call('linkContactCompany', invocation, { id, companyId: first.id }, { primary: true }),
    ).isPrimary,
  ).toBe(true);
  expect(
    contactCompany.parse(
      await call('linkContactCompany', invocation, { id, companyId: first.id }, {}),
    ).isPrimary,
  ).toBe(true);
  await call('linkContactCompany', invocation, { id, companyId: second.id }, { primary: true });
  const linked = contactCompanies.parse(await call('getContactCompanies', invocation, { id }));
  expect(linked.items).toHaveLength(2);
  expect(linked.items.filter((item) => item.isPrimary).map((item) => item.company.id)).toEqual([
    second.id,
  ]);
  await Promise.all([
    call('linkContactCompany', invocation, { id, companyId: first.id }, { primary: true }),
    call('linkContactCompany', invocation, { id, companyId: second.id }, { primary: true }),
  ]);
  const concurrent = contactCompanies.parse(await call('getContactCompanies', invocation, { id }));
  expect(concurrent.items).toHaveLength(2);
  expect(concurrent.items.filter((item) => item.isPrimary)).toHaveLength(1);
  await call('unlinkContactCompany', invocation, { id, companyId: first.id });
  await call('unlinkContactCompany', invocation, { id, companyId: first.id });
  expect(
    contactCompanies
      .parse(await call('getContactCompanies', invocation, { id }))
      .items.map((item) => item.company.id),
  ).toEqual([second.id]);
});

it('emits one change per actual association change on all affected records, without duplicate retries', async () => {
  const { invocation, id } = await fixture();
  const first = await create(invocation, 'First');
  const second = await create(invocation, 'Second');
  await call('linkContactCompany', invocation, { id, companyId: first.id }, { primary: true });
  await call('linkContactCompany', invocation, { id, companyId: second.id }, { primary: true });
  await call('linkContactCompany', invocation, { id, companyId: second.id }, { primary: true });
  const contactHistory = recordActivity.parse(await call('listRecordActivity', invocation, { id }));
  expect(contactHistory.items.map((item) => item.type)).toEqual([
    'contact.company_linked',
    'contact.company_linked',
  ]);
  const oldPrimaryHistory = recordActivity.parse(
    await call('listRecordActivity', invocation, { id: first.id }),
  );
  expect(oldPrimaryHistory.items.map((item) => item.type)).toEqual([
    'contact.company_linked',
    'contact.company_linked',
    'company.created',
  ]);
  await call('linkContactCompany', invocation, { id, companyId: second.id }, { primary: false });
  expect(
    contactCompanies
      .parse(await call('getContactCompanies', invocation, { id }))
      .items.filter((item) => item.isPrimary),
  ).toHaveLength(0);
  await call('unlinkContactCompany', invocation, { id, companyId: second.id });
  await call('unlinkContactCompany', invocation, { id, companyId: second.id });
  expect(
    recordActivity
      .parse(await call('listRecordActivity', invocation, { id }))
      .items.map((item) => item.type),
  ).toEqual([
    'contact.company_unlinked',
    'contact.company_link_changed',
    'contact.company_linked',
    'contact.company_linked',
  ]);
});

it('hides foreign contact/company ids before validating the body, and trusts only invocation provenance', async () => {
  const own = await fixture();
  const foreign = await fixture();
  const ownCompany = await create(own.invocation, 'Own');
  const foreignCompany = await create(foreign.invocation, 'Private');
  await expect(
    call('getContactCompanies', own.invocation, { id: foreign.id }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call(
      'linkContactCompany',
      own.invocation,
      { id: foreign.id, companyId: ownCompany.id },
      { sourceKind: 'user' },
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('linkContactCompany', own.invocation, { id: own.id, companyId: foreignCompany.id }, {}),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('unlinkContactCompany', own.invocation, { id: own.id, companyId: foreignCompany.id }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call(
      'linkContactCompany',
      own.invocation,
      { id: own.id, companyId: ownCompany.id },
      { sourceKind: 'user' },
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  const viewer: Invocation = { ...own.invocation, permissions: new Set() };
  expect(
    contactCompanies.parse(await call('getContactCompanies', viewer, { id: own.id })).canManage,
  ).toBe(false);
  await expect(
    call('linkContactCompany', viewer, { id: own.id, companyId: ownCompany.id }, {}),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await call(
    'linkContactCompany',
    { ...own.invocation, permissions: new Set(['contacts.manage']) },
    { id: own.id, companyId: ownCompany.id },
    {},
  );
});

it('retains trashed-company links and lets a live contact remove them, while refusing new links to trash', async () => {
  const { invocation, id } = await fixture();
  const saved = await create(invocation, 'Retained');
  await call('linkContactCompany', invocation, { id, companyId: saved.id }, { primary: true });
  await call('trashCompany', invocation, { id: saved.id });
  const retained = contactCompanies.parse(await call('getContactCompanies', invocation, { id }));
  expect(retained.items[0]?.company.trashedAt).not.toBeNull();
  await expect(
    call('linkContactCompany', invocation, { id, companyId: saved.id }, {}),
  ).rejects.toBeInstanceOf(ConflictError);
  await call('unlinkContactCompany', invocation, { id, companyId: saved.id });
  expect(
    contactCompanies.parse(await call('getContactCompanies', invocation, { id })).items,
  ).toEqual([]);
});

it('retains links in contact trash and refuses all association changes until restore', async () => {
  const { invocation, id } = await fixture();
  const saved = await create(invocation, 'Retained');
  await call('linkContactCompany', invocation, { id, companyId: saved.id }, {});
  await call('trashContact', invocation, { id });
  const retained = contactCompanies.parse(await call('getContactCompanies', invocation, { id }));
  expect(retained.items).toHaveLength(1);
  expect(retained.canManage).toBe(false);
  await expect(
    call('linkContactCompany', invocation, { id, companyId: saved.id }, { primary: true }),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(
    call('unlinkContactCompany', invocation, { id, companyId: saved.id }),
  ).rejects.toBeInstanceOf(ConflictError);
});

it.each(['contact', 'company'] as const)(
  'waits for in-flight %s trash and then refuses the link',
  async (kind) => {
    const { invocation, id } = await fixture();
    const saved = await create(invocation, 'Race');
    const updated = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const trash = database.withTenant(invocation.context, async (sql) => {
      await sql.query(
        kind === 'contact'
          ? 'update crm.contacts set deleted_at=now() where id=$1'
          : 'update crm.companies set deleted_at=now() where id=$1',
        [parsePublicId(kind, kind === 'contact' ? id : saved.id)],
      );
      updated.resolve(undefined);
      await release.promise;
    });
    await updated.promise;
    const attempt = call(
      'linkContactCompany',
      invocation,
      { id, companyId: saved.id },
      { primary: true },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await expect
        .poll(
          async () => {
            const row = await database.as('crm_app', (sql) =>
              sql.one<{ waiting: boolean }>(
                "select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like $1) as waiting",
                [kind === 'contact' ? '%contacts%' : '%companies%'],
              ),
            );
            return row.waiting;
          },
          { timeout: 1000 },
        )
        .toBe(true);
    } finally {
      release.resolve(undefined);
      await trash;
    }
    expect(await attempt).toBeInstanceOf(ConflictError);
    expect(
      contactCompanies.parse(await call('getContactCompanies', invocation, { id })).items,
    ).toEqual([]);
  },
);
