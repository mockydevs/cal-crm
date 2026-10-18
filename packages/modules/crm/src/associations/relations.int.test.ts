// Relations between records under an association, against a migrated Postgres seeded as a
// new business is: any pair of objects through one API, the system ones through their own
// commands, each side held to its limit, and every record's Associations panel.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import {
  association,
  customRecord,
  objectDefinition,
  recordAssociations,
  relation,
  type Association,
  type Permission,
  type Relation,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  parsePublicId,
  toPublicId,
  type TenantContext,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { seedBusinessDefaults } from '../defaults/defaults.js';
import { linkDealContactCommand } from '../deals/contact-links.js';
import { createDealCommand } from '../deals/deals.js';
import { createObjectRoutes, crmRoutes } from '../index.js';
import { NO_UUID, uuidOf as lookupUuid } from '../records/public-ids.js';
import { removeRelationCommands, writeRelationCommands } from './relations.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const routes = [...createObjectRoutes({ uses: () => Promise.resolve([]) }), ...crmRoutes];

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
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('It was not refused.');
};
const issueOf = async (promise: Promise<unknown>) => {
  const error = await refusal(promise);
  return error instanceof ValidationError ? error.issues[0] : error;
};

interface Scene {
  readonly invocation: Invocation;
  readonly context: TenantContext;
  type(key: string): Promise<string>;
  associate(body: object): Promise<Association>;
  pet(name: string): Promise<string>;
  contact(name: string): Promise<string>;
  company(name: string): Promise<string>;
  deal(name: string): Promise<string>;
  relate(body: object, invocation?: Invocation): Promise<Relation>;
  panel(id: string, query?: object): Promise<ReturnType<typeof recordAssociations.parse>>;
  events(
    prefix: string,
  ): Promise<{ type: string; payload: Record<string, unknown>; records: string[] }[]>;
}

/** A business as business.create leaves it, with a Pet object. */
async function scene(): Promise<Scene> {
  const agency = await database.fixtures.agency();
  const staff: TenantContext = {
    agencyId: agency.id,
    actorKind: 'system',
    correlationId: randomUUID(),
  };
  const suffix = randomUUID().slice(0, 8);
  const { id } = await database.withTenant(staff, (sql) =>
    sql.one<{ id: string }>(
      'insert into tenancy.businesses (agency_id, name, slug) values ($1, $2, $3) returning id',
      [agency.id, `Business ${suffix}`, `business-${suffix}`],
    ),
  );
  const context: TenantContext = { ...staff, businessId: id };
  await withTenant(db, context, (trx) => seedBusinessDefaults(trx, id));
  const invocation: Invocation = { context, permissions: 'all' };
  objectDefinition.parse(
    await call(
      'createObject',
      invocation,
      {},
      {
        singularLabel: 'Pet',
        pluralLabel: 'Pets',
        primaryField: { label: 'Pet name', valueType: 'text' },
      },
    ),
  );
  const stage = await database.withTenant(context, async (sql) => {
    const [seededStage] = await sql.query<{ id: string; pipeline_id: string }>(
      'select id, pipeline_id from crm.pipeline_stages order by position limit 1',
    );
    if (seededStage !== undefined) return seededStage;
    const pipeline = await sql.one<{ id: string }>(
      "insert into crm.pipelines (business_id, name) values ($1, 'Sales') returning id",
      [id],
    );
    return sql.one<{ id: string; pipeline_id: string }>(
      `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
       values ($1, $2, 'New lead', 0) returning id, pipeline_id`,
      [id, pipeline.id],
    );
  });
  return {
    invocation,
    context,
    type: async (key) =>
      toPublicId(
        'link_type',
        (
          await database.withTenant(context, (sql) =>
            sql.one<{ id: string }>('select id from crm.link_types where key = $1', [key]),
          )
        ).id,
      ),
    associate: async (body) =>
      association.parse(await call('createAssociation', invocation, {}, body)),
    pet: async (name) =>
      customRecord.parse(
        await call(
          'createCustomRecord',
          invocation,
          { key: 'pet' },
          { fields: { pet_name: name } },
        ),
      ).id,
    contact: async (firstName) =>
      toPublicId('contact', (await database.fixtures.contact(context, { firstName })).id),
    company: async (name) =>
      ((await call('createCompany', invocation, {}, { name })) as { id: string }).id,
    deal: async (name) =>
      (
        await runCommand(
          services,
          createDealCommand,
          {
            name,
            pipelineId: toPublicId('pipeline', stage.pipeline_id),
            stageId: toPublicId('stage', stage.id),
            currency: 'USD',
          },
          invocation,
        )
      ).id,
    relate: async (body, as = invocation) =>
      relation.parse(await call('createRelation', as, {}, body)),
    panel: async (recordId, query = {}) =>
      recordAssociations.parse(
        await call('getRecordAssociations', invocation, { id: recordId }, undefined, query),
      ),
    events: (prefix) =>
      database.withTenant(context, (sql) =>
        sql.query(
          `select e.type, e.payload,
                  array(select t.record_id::text from crm.timeline_entries t
                        where t.event_id = e.id order by t.record_id) as records
           from events.events e where e.type like $1 order by e.recorded_at, e.id`,
          [`${prefix}%`],
        ),
      ),
  };
}
const uuidOf = (id: string) =>
  (['contact', 'company', 'deal', 'custom'] as const)
    .map((kind) => parsePublicId(kind, id))
    .find((uuid) => uuid !== undefined) ?? '';

describe('a relation', () => {
  it('relates two records either way round, once, and says so on both timelines', async () => {
    const s = await scene();
    const owner = await s.associate({
      fromObjectKey: 'pet',
      toObjectKey: 'contact',
      label: 'Owner',
      reverseLabel: 'Pet',
      fromLimit: 5,
      toLimit: 2,
    });
    const buddy = await s.pet('Buddy');
    const maya = await s.contact('Maya');
    const made = await s.relate({
      associationId: owner.id,
      firstRecordId: maya,
      secondRecordId: buddy,
    });
    expect(made).toMatchObject({
      associationId: owner.id,
      fromRecordId: buddy,
      toRecordId: maya,
      isPrimary: false,
    });
    // Again, in the other order: the same relation, nothing new.
    expect(
      await s.relate({ associationId: owner.id, firstRecordId: buddy, secondRecordId: maya }),
    ).toEqual(made);
    expect(await s.events('record.associated')).toEqual([
      {
        type: 'record.associated',
        payload: { linkTypeId: owner.id, fromId: buddy, toId: maya, primary: false },
        records: [uuidOf(buddy), uuidOf(maya)].sort(),
      },
    ]);
    expect(
      await issueOf(
        s.relate({ associationId: owner.id, firstRecordId: buddy, secondRecordId: buddy }),
      ),
    ).toMatchObject({ path: '/secondRecordId' });
    expect(
      await issueOf(
        s.relate({
          associationId: owner.id,
          firstRecordId: buddy,
          secondRecordId: await s.company('Acme'),
        }),
      ),
    ).toMatchObject({ path: '/secondRecordId', code: 'wrong_object' });
    expect(
      await issueOf(
        s.relate({
          associationId: owner.id,
          firstRecordId: buddy,
          secondRecordId: maya,
          primary: true,
        }),
      ),
    ).toMatchObject({ path: '/primary', code: 'no_primary' });
  });

  it('is refused past either side’s limit, and a record in the trash takes none', async () => {
    const s = await scene();
    const owner = await s.associate({
      fromObjectKey: 'pet',
      toObjectKey: 'contact',
      label: 'Owner',
      reverseLabel: 'Pet',
      fromLimit: 2,
      toLimit: 1,
    });
    const [buddy, rex, max] = [await s.pet('Buddy'), await s.pet('Rex'), await s.pet('Max')];
    const [maya, lee] = [await s.contact('Maya'), await s.contact('Lee')];
    await s.relate({ associationId: owner.id, firstRecordId: buddy, secondRecordId: maya });
    // Buddy has his one owner.
    const once = await issueOf(
      s.relate({ associationId: owner.id, firstRecordId: buddy, secondRecordId: lee }),
    );
    expect(once).toMatchObject({ code: 'limit_reached' });
    expect(JSON.stringify(once)).toContain('Owner (1)');
    await s.relate({ associationId: owner.id, firstRecordId: rex, secondRecordId: maya });
    // Maya has her two pets.
    const twice = await issueOf(
      s.relate({ associationId: owner.id, firstRecordId: max, secondRecordId: maya }),
    );
    expect(twice).toMatchObject({ code: 'limit_reached' });
    expect(JSON.stringify(twice)).toContain('Pet (2)');
    await call('trashCustomRecord', s.invocation, { key: 'pet', id: max });
    expect(
      await refusal(s.relate({ associationId: owner.id, firstRecordId: max, secondRecordId: lee })),
    ).toBeInstanceOf(ConflictError);
  });

  it('waits for a change of its association’s limits, and then is held to them', async () => {
    const s = await scene();
    const owner = await s.associate({
      fromObjectKey: 'pet',
      toObjectKey: 'contact',
      label: 'Owner',
      reverseLabel: 'Pet',
      fromLimit: 5,
      toLimit: 5,
    });
    const buddy = await s.pet('Buddy');
    await s.relate({
      associationId: owner.id,
      firstRecordId: buddy,
      secondRecordId: await s.contact('Maya'),
    });
    const lee = await s.contact('Lee');
    let settled = false;
    let pending: Promise<unknown> = Promise.resolve();
    await withTenant(db, s.context, async (trx) => {
      // As association.update holds it while it checks and lowers the limit.
      await trx
        .selectFrom('crm.link_types')
        .select('id')
        .where('id', '=', parsePublicId('link_type', owner.id) ?? '')
        .forUpdate()
        .execute();
      pending = s
        .relate({ associationId: owner.id, firstRecordId: buddy, secondRecordId: lee })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
        .finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await trx
        .updateTable('crm.link_types')
        .set({ to_limit: 1 })
        .where('id', '=', parsePublicId('link_type', owner.id) ?? '')
        .execute();
    });
    expect(await pending).toMatchObject({ issues: [{ code: 'limit_reached' }] });
  });

  it('takes its two records in one order, so writes in opposite directions never deadlock', async () => {
    const s = await scene();
    const friend = await s.associate({
      fromObjectKey: 'contact',
      toObjectKey: 'contact',
      label: 'Friend',
      fromLimit: 1000,
      toLimit: 1000,
    });
    const mentor = await s.associate({
      fromObjectKey: 'contact',
      toObjectKey: 'contact',
      label: 'Mentee',
      reverseLabel: 'Mentor',
      fromLimit: 1000,
      toLimit: 1000,
    });
    for (let round = 0; round < 5; round += 1) {
      const [a, b] = [await s.contact(`A${String(round)}`), await s.contact(`B${String(round)}`)];
      const results = await Promise.allSettled([
        s.relate({ associationId: friend.id, firstRecordId: a, secondRecordId: b }),
        s.relate({ associationId: mentor.id, firstRecordId: b, secondRecordId: a }),
      ]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    }
  });

  it('is one per pair under a single label that joins an object to itself, whichever way it is asked', async () => {
    const s = await scene();
    const spouse = await s.associate({
      fromObjectKey: 'contact',
      toObjectKey: 'contact',
      label: 'Spouse',
      fromLimit: 1,
      toLimit: 1,
    });
    const [maya, lee, sam] = [
      await s.contact('Maya'),
      await s.contact('Lee'),
      await s.contact('Sam'),
    ];
    const made = await s.relate({
      associationId: spouse.id,
      firstRecordId: maya,
      secondRecordId: lee,
    });
    expect(
      await s.relate({ associationId: spouse.id, firstRecordId: lee, secondRecordId: maya }),
    ).toEqual(made);
    const count = await database.withTenant(s.context, (sql) =>
      sql.query('select 1 from crm.record_links where link_type_id = $1', [
        parsePublicId('link_type', spouse.id),
      ]),
    );
    expect(count).toHaveLength(1);
    // One spouse each, whichever side each was written on.
    for (const taken of [maya, lee])
      expect(
        await issueOf(
          s.relate({ associationId: spouse.id, firstRecordId: sam, secondRecordId: taken }),
        ),
      ).toMatchObject({ code: 'limit_reached' });
    const panel = await s.panel(lee);
    expect(panel.items.find((group) => group.associationId === spouse.id)).toMatchObject({
      side: 'both',
      label: 'Spouse',
      records: [{ id: maya, kind: 'contact', name: 'Maya' }],
    });
  });

  it('writes a deal’s contact through the deal’s own command: its rows, events and primary', async () => {
    const s = await scene();
    const dealContact = await s.type('deal_contact');
    const deal = await s.deal('Roof');
    const [maya, lee] = [await s.contact('Maya'), await s.contact('Lee')];
    const first = await s.relate({
      associationId: dealContact,
      firstRecordId: maya,
      secondRecordId: deal,
      primary: true,
    });
    expect(first).toMatchObject({ fromRecordId: deal, toRecordId: maya, isPrimary: true });
    await s.relate({
      associationId: dealContact,
      firstRecordId: deal,
      secondRecordId: lee,
      primary: true,
    });
    expect((await s.events('deal.contact')).map((event) => [event.type, event.payload])).toEqual([
      ['deal.contact_linked', { contactId: maya, primary: true }],
      ['deal.contact_linked', { contactId: lee, primary: true }],
    ]);
    // Maya stepped down when Lee became the primary contact.
    const primaries = await database.withTenant(s.context, (sql) =>
      sql.query<{ to_record_id: string }>(
        'select to_record_id from crm.record_links where from_record_id = $1 and is_primary',
        [uuidOf(deal)],
      ),
    );
    expect(primaries).toEqual([{ to_record_id: uuidOf(lee) }]);
    await call('deleteRelation', s.invocation, { relationId: first.id });
    expect((await s.events('deal.contact_unlinked')).map((event) => event.payload)).toEqual([
      { contactId: maya },
    ]);
    expect(await s.events('record.')).toEqual([]);
  });

  it('writes a contact’s company through the contact’s own command, and removes it so', async () => {
    const s = await scene();
    const contactCompany = await s.type('contact_company');
    const maya = await s.contact('Maya');
    const acme = await s.company('Acme');
    const made = await s.relate({
      associationId: contactCompany,
      firstRecordId: acme,
      secondRecordId: maya,
    });
    expect(made).toMatchObject({ fromRecordId: maya, toRecordId: acme, isPrimary: false });
    await call('deleteRelation', s.invocation, { relationId: made.id });
    expect((await s.events('contact.company')).map((event) => event.type)).toEqual([
      'contact.company_linked',
      'contact.company_unlinked',
    ]);
    // Neither is written here, even when asked for directly.
    expect(
      await issueOf(
        runCommand(
          services,
          writeRelationCommands.contact,
          { associationId: contactCompany, fromRecordId: maya, toRecordId: acme },
          s.invocation,
        ),
      ),
    ).toMatchObject({ code: 'system_association' });
    const again = await s.relate({
      associationId: contactCompany,
      firstRecordId: maya,
      secondRecordId: acme,
    });
    expect(
      await issueOf(
        runCommand(
          services,
          removeRelationCommands.contact,
          { relationId: again.id },
          s.invocation,
        ),
      ),
    ).toMatchObject({ code: 'system_association' });
  });

  it('writes a deal’s company, which has no command of its own, here, with its primary', async () => {
    const s = await scene();
    const dealCompany = await s.type('deal_company');
    const deal = await s.deal('Roof');
    const [acme, globex] = [await s.company('Acme'), await s.company('Globex')];
    const first = await s.relate({
      associationId: dealCompany,
      firstRecordId: deal,
      secondRecordId: acme,
      primary: true,
    });
    await s.relate({
      associationId: dealCompany,
      firstRecordId: deal,
      secondRecordId: globex,
      primary: true,
    });
    // Asking again with the primary it has changes nothing; taking it away says so.
    await s.relate({
      associationId: dealCompany,
      firstRecordId: deal,
      secondRecordId: globex,
      primary: true,
    });
    await s.relate({
      associationId: dealCompany,
      firstRecordId: deal,
      secondRecordId: globex,
      primary: false,
    });
    expect(
      (await s.events('record.')).map((event) => [event.type, event.payload['primary']]),
    ).toEqual([
      ['record.associated', true],
      ['record.associated', true],
      ['record.association_changed', false],
    ]);
    const panel = await s.panel(deal);
    expect(
      panel.items
        .find((group) => group.associationId === dealCompany)
        ?.records.map((each) => [each.id, each.isPrimary]),
    ).toEqual([
      [globex, false],
      [acme, false],
    ]);
    await call('deleteRelation', s.invocation, { relationId: first.id });
    expect((await s.events('record.unassociated')).map((event) => event.payload)).toEqual([
      { linkTypeId: dealCompany, fromId: deal, toId: acme },
    ]);
  });

  it('needs the role to change records of both kinds', async () => {
    const s = await scene();
    const owner = await s.associate({
      fromObjectKey: 'pet',
      toObjectKey: 'contact',
      label: 'Owner',
      fromLimit: 5,
      toLimit: 5,
    });
    const buddy = await s.pet('Buddy');
    const maya = await s.contact('Maya');
    const only = (...granted: Permission[]): Invocation => ({
      ...s.invocation,
      permissions: new Set(granted),
    });
    const refused = await refusal(
      s.relate(
        { associationId: owner.id, firstRecordId: maya, secondRecordId: buddy },
        only('records.manage'),
      ),
    );
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect((refused as Error).message).toContain('contacts.manage');
    const made = await s.relate(
      { associationId: owner.id, firstRecordId: maya, secondRecordId: buddy },
      only('records.manage', 'contacts.manage'),
    );
    expect(
      await refusal(call('deleteRelation', only('records.manage'), { relationId: made.id })),
    ).toBeInstanceOf(ForbiddenError);
    expect(
      (await s.panel(buddy)).items.find((group) => group.associationId === owner.id)?.canManage,
    ).toBe(true);
    const asRecordsOnly = recordAssociations.parse(
      await call('getRecordAssociations', only('records.manage'), { id: buddy }, undefined, {
        associationId: owner.id,
        side: 'from',
      }),
    );
    expect(asRecordsOnly.items[0]?.canManage).toBe(false);
    // A command asked directly for records the wrong way round, or of other objects.
    expect(
      await issueOf(
        runCommand(
          services,
          writeRelationCommands.contact,
          { associationId: owner.id, fromRecordId: maya, toRecordId: buddy },
          s.invocation,
        ),
      ),
    ).toMatchObject({ path: '/toRecordId', code: 'wrong_object' });
    // An id of nothing finds nothing, rather than failing the lookup.
    expect(lookupUuid('link_type', 'nope')).toBe(NO_UUID);
  });

  it('removes a deal’s contact in turn with the owner rules, so a link change never deadlocks with it', async () => {
    const s = await scene();
    const ruled = await database.as('crm_owner', (sql) =>
      sql.query(
        `update crm.settings set deal_owner_follows_contact = true where business_id = $1
         returning business_id`,
        [s.context.businessId],
      ),
    );
    expect(ruled).toHaveLength(1);
    const dealContact = await s.type('deal_contact');
    const deal = await s.deal('Roof');
    const maya = await s.contact('Maya');
    const made = await s.relate({
      associationId: dealContact,
      firstRecordId: deal,
      secondRecordId: maya,
      primary: true,
    });
    const settled = (promise: Promise<unknown>) =>
      promise.then(
        () => 'done',
        (error: unknown) => error,
      );
    let pending: Promise<unknown>[] = [];
    await withTenant(db, s.context, async (trx) => {
      // The deal held, as a change of its links holds it: the link change behind it takes
      // the owner rules first, and the removal then queues for them.
      await trx
        .selectFrom('crm.records')
        .select('id')
        .where('id', '=', uuidOf(deal))
        .forNoKeyUpdate()
        .execute();
      const change = settled(
        runCommand(
          services,
          linkDealContactCommand,
          { id: deal, contactId: maya, primary: false },
          s.invocation,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const removal = settled(call('deleteRelation', s.invocation, { relationId: made.id }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      pending = [change, removal];
    });
    expect(await Promise.all(pending)).toEqual(['done', 'done']);
  });

  it('is refused for a record and itself when its command is asked directly', async () => {
    const s = await scene();
    const friend = await s.associate({
      fromObjectKey: 'pet',
      toObjectKey: 'pet',
      label: 'Friend',
      fromLimit: 5,
      toLimit: 5,
    });
    const buddy = await s.pet('Buddy');
    expect(
      await issueOf(
        runCommand(
          services,
          writeRelationCommands.custom,
          { associationId: friend.id, fromRecordId: buddy, toRecordId: buddy },
          s.invocation,
        ),
      ),
    ).toMatchObject({ path: '/toRecordId', code: 'same_record' });
  });

  it('is not found from another business', async () => {
    const s = await scene();
    const other = await scene();
    const owner = await s.associate({
      fromObjectKey: 'pet',
      toObjectKey: 'contact',
      label: 'Owner',
      fromLimit: 5,
      toLimit: 5,
    });
    const made = await s.relate({
      associationId: owner.id,
      firstRecordId: await s.pet('Buddy'),
      secondRecordId: await s.contact('Maya'),
    });
    expect(
      await refusal(call('deleteRelation', other.invocation, { relationId: made.id })),
    ).toBeInstanceOf(NotFoundError);
    expect(
      await refusal(
        other.relate({
          associationId: owner.id,
          firstRecordId: await other.pet('Rex'),
          secondRecordId: await other.contact('Lee'),
        }),
      ),
    ).toBeInstanceOf(NotFoundError);
    expect(await refusal(other.panel(made.fromRecordId))).toBeInstanceOf(NotFoundError);
  });
});

describe('a record’s Associations panel', () => {
  it('shows each association by the label it has from this record, a page of each side at a time', async () => {
    const s = await scene();
    const owner = await s.associate({
      fromObjectKey: 'pet',
      toObjectKey: 'contact',
      label: 'Owner',
      reverseLabel: 'Pet',
      fromLimit: 1000,
      toLimit: 1000,
    });
    const parent = await s.associate({
      fromObjectKey: 'pet',
      toObjectKey: 'pet',
      label: 'Child',
      reverseLabel: 'Parent',
      fromLimit: 1000,
      toLimit: 1000,
    });
    const maya = await s.contact('Maya');
    const pets: string[] = [];
    for (let at = 0; at < 22; at += 1) {
      const pet = await s.pet(`Pet ${String(at)}`);
      pets.push(pet);
      await s.relate({ associationId: owner.id, firstRecordId: pet, secondRecordId: maya });
    }
    const [mum, pup] = [pets[0] ?? '', pets[1] ?? ''];
    await s.relate({ associationId: parent.id, firstRecordId: mum, secondRecordId: pup });

    const fromMaya = await s.panel(maya);
    const ofOwner = fromMaya.items.find((group) => group.associationId === owner.id);
    expect(ofOwner).toMatchObject({
      side: 'to',
      label: 'Pet',
      objectKey: 'pet',
      objectLabel: 'Pets',
      system: false,
      limit: 1000,
      total: 22,
      canManage: true,
    });
    expect(ofOwner?.records).toHaveLength(20);
    expect(ofOwner?.records[0]).toMatchObject({
      id: pets[21],
      kind: 'custom',
      name: 'Pet 21',
      inTrash: false,
    });
    // The system associations of a contact come first, with nothing related yet.
    expect(fromMaya.items.slice(0, 2).map((group) => [group.label, group.total])).toEqual([
      ['Deal', 0],
      ['Company', 0],
    ]);
    const rest = await s.panel(maya, { associationId: owner.id, side: 'to', after: ofOwner?.next });
    expect(rest.items).toHaveLength(1);
    expect(rest.items[0]?.records.map((each) => each.name)).toEqual(['Pet 1', 'Pet 0']);
    expect(rest.items[0]?.next).toBeNull();

    const fromMum = await s.panel(mum);
    expect(fromMum.items.map((group) => [group.label, group.side, group.total])).toEqual([
      ['Owner', 'from', 1],
      ['Child', 'from', 1],
      ['Parent', 'to', 0],
    ]);
    const fromPup = await s.panel(pup, { associationId: parent.id, side: 'to' });
    expect(fromPup.items[0]?.records.map((each) => each.id)).toEqual([mum]);

    await call('trashCustomRecord', s.invocation, { key: 'pet', id: mum });
    expect(
      (await s.panel(pup, { associationId: parent.id, side: 'to' })).items[0]?.records[0]?.inTrash,
    ).toBe(true);
    expect((await s.panel(mum)).items.every((group) => !group.canManage)).toBe(true);
  });

  it('refuses a page of a side the record is not on, or after a relation not of it', async () => {
    const s = await scene();
    const owner = await s.associate({
      fromObjectKey: 'pet',
      toObjectKey: 'contact',
      label: 'Owner',
      fromLimit: 5,
      toLimit: 5,
    });
    const buddy = await s.pet('Buddy');
    expect(await issueOf(s.panel(buddy, { associationId: owner.id, side: 'to' }))).toMatchObject({
      path: '/side',
    });
    expect(
      await issueOf(
        s.panel(buddy, {
          associationId: owner.id,
          side: 'from',
          after: toPublicId('record_link', '01890a5d-ac96-774b-bcce-b30209900001'),
        }),
      ),
    ).toMatchObject({ path: '/after', code: 'unknown_relation' });
    expect(
      await refusal(s.panel(buddy, { associationId: await s.type('deal_company'), side: 'from' })),
    ).toBeInstanceOf(NotFoundError);
  });
});
