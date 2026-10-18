import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  MAX_ASSOCIATION_LABELS,
  association,
  associationList,
  type Association,
} from '@repo/contracts';
import { connectDatabase } from '@repo/db';
import { ForbiddenError, NotFoundError, ValidationError, toPublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createObjectRoutes, crmRoutes } from '../index.js';

let database: TestDatabase;
let services: Services;
const routes = [...createObjectRoutes({ uses: () => Promise.resolve([]) }), ...crmRoutes];

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

/** A business with a Pet object, and the three system links every business starts with. */
async function inBusiness(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const invocation: Invocation = {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
  await database.withTenant(business.context, (sql) =>
    sql.query(
      `insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id,
                                   label, reverse_label, allows_primary, is_system)
       select app.business_id(), l.key, f.id, t.id, l.label, l.reverse, true, true
       from (values ('deal_contact', 'deal', 'contact', 'Contact', 'Deal'),
                    ('contact_company', 'contact', 'company', 'Company', 'Person'),
                    ('deal_company', 'deal', 'company', 'Company', 'Deal'))
              as l (key, from_kind, to_kind, label, reverse)
       join crm.object_types f on f.kind = l.from_kind
       join crm.object_types t on t.kind = l.to_kind`,
    ),
  );
  await call(
    'createObject',
    invocation,
    {},
    {
      singularLabel: 'Pet',
      pluralLabel: 'Pets',
      primaryField: { label: 'Pet name', valueType: 'text' },
    },
  );
  return invocation;
}
async function call(
  operationId: string,
  invocation: Invocation,
  params: unknown = {},
  body?: unknown,
  query: unknown = {},
): Promise<unknown> {
  const route = routes.find((item) => item.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, body, params, query }, services);
}
const owner = {
  fromObjectKey: 'pet',
  toObjectKey: 'contact',
  label: 'Owner',
  reverseLabel: 'Pet',
  fromLimit: 1000,
  toLimit: 2,
};
const create = async (invocation: Invocation, body: object = owner): Promise<Association> =>
  association.parse(await call('createAssociation', invocation, {}, body));
const list = async (invocation: Invocation, query: object = {}) =>
  associationList.parse(await call('listAssociations', invocation, {}, undefined, query));
const issueOf = (error: unknown) => (error instanceof ValidationError ? error.issues[0] : error);
const failure = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

/** Links a new pet to new contacts under the association, as the relations commands will. */
async function linked(invocation: Invocation, made: Association, contacts: number) {
  return database.withTenant(invocation.context, async (sql) => {
    const petType = await sql.one<{ id: string; primary_field_id: string }>(
      "select id, primary_field_id from crm.object_types where key = 'pet'",
    );
    const pet = await sql.one<{ id: string }>(
      `insert into crm.records (business_id, kind, object_type_id)
       values (app.business_id(), 'custom', $1) returning id`,
      [petType.id],
    );
    await sql.query(
      `insert into crm.custom_records (business_id, id, title, created_by_kind)
       values (app.business_id(), $1, 'Rex', 'system')`,
      [pet.id],
    );
    for (let n = 0; n < contacts; n += 1)
      await sql.query(
        `with record as (
           insert into crm.records (business_id, kind, object_type_id)
           select app.business_id(), 'contact', id from crm.object_types where kind = 'contact'
           returning id),
         contact as (
           insert into crm.contacts (business_id, id, first_name, created_by_kind)
           select app.business_id(), id, 'Owner', 'system' from record returning id)
         insert into crm.record_links (business_id, link_type_id, from_record_id, to_record_id, source_kind)
         select app.business_id(), (select id from crm.link_types where key = $1), $2, id, 'system'
         from contact`,
        [made.key, pet.id],
      );
    return pet.id;
  });
}

describe('an association', () => {
  it('joins two objects with a label each way and a limit each side', async () => {
    const invocation = await inBusiness();
    const made = await create(invocation);
    expect(made).toMatchObject({
      key: 'pet_owner',
      fromObjectKey: 'pet',
      toObjectKey: 'contact',
      label: 'Owner',
      reverseLabel: 'Pet',
      system: false,
      allowsPrimary: false,
      fromLimit: 1000,
      toLimit: 2,
      source: 'system',
    });
    expect(association.parse(await call('getAssociation', invocation, { id: made.id }))).toEqual(
      made,
    );
    const single = await create(invocation, {
      ...owner,
      key: 'pet_vet',
      label: 'Vet',
      reverseLabel: undefined,
    });
    expect(single).toMatchObject({ key: 'pet_vet', label: 'Vet', reverseLabel: 'Vet' });

    const all = await list(invocation);
    expect(all.items.map((item) => [item.key, item.system])).toEqual([
      ['contact_company', true],
      ['deal_company', true],
      ['deal_contact', true],
      ['pet_owner', false],
      ['pet_vet', false],
    ]);
    expect(all.canManage).toBe(true);
    expect((await list(invocation, { objectKey: 'pet' })).items.map((item) => item.key)).toEqual([
      'pet_owner',
      'pet_vet',
    ]);
    expect(
      (await list(invocation, { objectKey: 'company' })).items.map((item) => item.key),
    ).toEqual(['contact_company', 'deal_company']);
  });

  it(`is refused past ${String(MAX_ASSOCIATION_LABELS)} labels for a pair of objects, whichever way they read`, async () => {
    const invocation = await inBusiness();
    for (let n = 1; n <= MAX_ASSOCIATION_LABELS; n += 1)
      await create(
        invocation,
        n % 2 === 0
          ? { ...owner, label: `Owner ${String(n)}` }
          : { ...owner, fromObjectKey: 'contact', toObjectKey: 'pet', label: `Carer ${String(n)}` },
      );
    expect(
      issueOf(await failure(create(invocation, { ...owner, label: 'One more' }))),
    ).toMatchObject({
      code: 'association_limit',
      message: `Two objects can have up to ${String(MAX_ASSOCIATION_LABELS)} associations.`,
    });
    // Another pair is not counted with it. Its key, made from the label, is taken by none of
    // the ten ("Owner 2" made pet_owner_2), and a second one with the same label goes on.
    expect((await create(invocation, { ...owner, toObjectKey: 'company' })).key).toBe('pet_owner');
    expect(
      (await create(invocation, { ...owner, toObjectKey: 'company', reverseLabel: 'Asset' })).key,
    ).toBe('pet_owner_3');
  });

  it.each([
    ['an object the business does not have', { toObjectKey: 'boat' }, '/toObjectKey'],
    ['no such object to start from', { fromObjectKey: 'boat' }, '/fromObjectKey'],
    ['labels the pair already has', {}, '/label'],
    [
      'the same labels read from the other object',
      { fromObjectKey: 'contact', toObjectKey: 'pet', label: 'Pet', reverseLabel: 'Owner' },
      '/label',
    ],
    ['a key already taken', { key: 'deal_contact', label: 'Other' }, '/key'],
  ])('is refused for %s', async (_, changes, path) => {
    const invocation = await inBusiness();
    await create(invocation);
    expect(issueOf(await failure(create(invocation, { ...owner, ...changes })))).toMatchObject({
      path,
    });
  });

  it('changes its labels, and its limits unless a record already has more', async () => {
    const invocation = await inBusiness();
    const made = await create(invocation);
    // Nothing linked yet: any limit goes, and so does a description.
    expect(
      association.parse(
        await call(
          'updateAssociation',
          invocation,
          { id: made.id },
          { label: 'Owner', reverseLabel: 'Pet', description: 'Who it lives with.', toLimit: 1 },
        ),
      ),
    ).toMatchObject({ description: 'Who it lives with.', toLimit: 1 });
    await call(
      'updateAssociation',
      invocation,
      { id: made.id },
      { label: 'Owner', reverseLabel: 'Pet', toLimit: 2 },
    );
    await linked(invocation, made, 2);
    const relabelled = association.parse(
      await call(
        'updateAssociation',
        invocation,
        { id: made.id },
        { label: 'Keeper', reverseLabel: 'Animal', fromLimit: 5 },
      ),
    );
    expect(relabelled).toMatchObject({ label: 'Keeper', reverseLabel: 'Animal', fromLimit: 5 });
    expect(relabelled.toLimit).toBe(2);
    expect(
      issueOf(
        await failure(
          call(
            'updateAssociation',
            invocation,
            { id: made.id },
            { label: 'Keeper', reverseLabel: 'Animal', toLimit: 1 },
          ),
        ),
      ),
    ).toMatchObject({
      path: '/toLimit',
      message: 'A Pet already has 2 of these: allow at least 2.',
    });
  });

  it('is deleted with every link it made, when a business made it', async () => {
    const invocation = await inBusiness();
    const made = await create(invocation);
    const pet = await linked(invocation, made, 2);
    await call('deleteAssociation', invocation, { id: made.id });
    await expect(call('getAssociation', invocation, { id: made.id })).rejects.toThrow(
      NotFoundError,
    );
    const left = await database.withTenant(invocation.context, (sql) =>
      sql.query('select 1 from crm.record_links where from_record_id = $1', [pet]),
    );
    expect(left).toEqual([]);
  });

  it('keeps a system one in place: its labels change, its limits do not, and it stays', async () => {
    const invocation = await inBusiness();
    const system = (await list(invocation)).items.find((item) => item.key === 'deal_contact');
    const id = system?.id ?? '';
    expect(
      association.parse(
        await call(
          'updateAssociation',
          invocation,
          { id },
          { label: 'Person', reverseLabel: 'Opportunity' },
        ),
      ),
    ).toMatchObject({ label: 'Person', reverseLabel: 'Opportunity', system: true, toLimit: null });
    expect(
      issueOf(
        await failure(
          call(
            'updateAssociation',
            invocation,
            { id },
            { label: 'Person', reverseLabel: 'Opportunity', toLimit: 5 },
          ),
        ),
      ),
    ).toMatchObject({ code: 'system_association' });
    expect(issueOf(await failure(call('deleteAssociation', invocation, { id })))).toMatchObject({
      code: 'system_association',
    });
  });

  it('is not found in another business, nor through a deleted object', async () => {
    const invocation = await inBusiness();
    const made = await create(invocation);
    const other = await inBusiness();
    await expect(call('getAssociation', other, { id: made.id })).rejects.toThrow(NotFoundError);
    await expect(call('updateAssociation', other, { id: made.id }, { label: 'x' })).rejects.toThrow(
      NotFoundError,
    );
    await expect(call('deleteAssociation', other, { id: made.id })).rejects.toThrow(NotFoundError);
    await expect(
      call('getAssociation', invocation, {
        id: toPublicId('link_type', '01890a5d-ac96-774b-bcce-b302099a8057'),
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(list(invocation, { objectKey: 'boat' })).rejects.toThrow(NotFoundError);

    await call('deleteObject', invocation, { key: 'pet' }, { confirm: 'Pets' });
    expect((await list(invocation)).items.map((item) => item.key)).not.toContain('pet_owner');
    await expect(call('getAssociation', invocation, { id: made.id })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('is managed only by those whose role allows objects.manage', async () => {
    const invocation = await inBusiness();
    const member: Invocation = { ...invocation, permissions: new Set(['contacts.manage']) };
    await expect(create(member)).rejects.toThrow(ForbiddenError);
    expect((await list(member)).canManage).toBe(false);
  });
});
