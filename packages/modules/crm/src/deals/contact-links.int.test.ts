// Deal contacts: links of the deal_contact type that seedBusinessDefaults gives a new
// business. Real Postgres, the real seed, and the real deal and link commands.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import { createDealInput, type Deal } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  type TenantContext,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { seedBusinessDefaults } from '../defaults/defaults.js';
import {
  CONTACT_DEALS_LIMIT,
  DEAL_CONTACT_LINK,
  dealContactLinkInput,
  linkDealContactCommand,
  readContactDeals,
} from './contact-links.js';
import { createDealCommand } from './deals.js';

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

interface Scene {
  readonly invocation: Invocation;
  readonly businessId: string;
  readonly pipelineId: string;
  readonly stageId: string;
  contact(firstName: string): Promise<string>;
  deal(name: string, patch?: Record<string, unknown>): Promise<Deal>;
  links(): Promise<{ deal: string; contact: string; is_primary: boolean; source_kind: string }[]>;
  events(): Promise<{ type: string; subject_id: string; payload: unknown; records: string[] }[]>;
}

async function sceneOf(context: TenantContext): Promise<Scene> {
  const businessId = context.businessId ?? '';
  const invocation: Invocation = {
    context: { ...context, correlationId: randomUUID() },
    permissions: 'all',
  };
  const stage = await database.withTenant(context, async (sql) => {
    const existing = await sql.query<{ id: string; pipeline_id: string }>(
      'select id, pipeline_id from crm.pipeline_stages order by position limit 1',
    );
    if (existing[0] !== undefined) return existing[0];
    const pipeline = await sql.one<{ id: string }>(
      "insert into crm.pipelines (business_id, name) values ($1, 'Sales') returning id",
      [businessId],
    );
    return sql.one<{ id: string; pipeline_id: string }>(
      `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
       values ($1, $2, 'New lead', 0) returning id, pipeline_id`,
      [businessId, pipeline.id],
    );
  });
  const pipelineId = toPublicId('pipeline', stage.pipeline_id);
  const stageId = toPublicId('stage', stage.id);
  return {
    invocation,
    businessId,
    pipelineId,
    stageId,
    contact: async (firstName) =>
      toPublicId('contact', (await database.fixtures.contact(context, { firstName })).id),
    deal: (name, patch = {}) =>
      runCommand(
        services,
        createDealCommand,
        { name, pipelineId, stageId, currency: 'KES', ...patch },
        invocation,
      ),
    links: () =>
      database.withTenant(context, (sql) =>
        sql.query(
          `select link.from_record_id as deal, link.to_record_id as contact, link.is_primary,
                  link.source_kind
           from crm.record_links link
           join crm.link_types type on type.id = link.link_type_id
           where type.key = $1
           order by link.created_at, link.id`,
          [DEAL_CONTACT_LINK],
        ),
      ),
    events: () =>
      database.withTenant(context, (sql) =>
        sql.query(
          `select e.type, e.subject_id, e.payload,
                  array(select t.record_id::text from crm.timeline_entries t
                        where t.event_id = e.id order by t.record_id) as records
           from events.events e
           where e.type like 'deal.contact%'
           order by e.recorded_at, e.id`,
        ),
      ),
  };
}

/** A business as business.create leaves it: seeded by the CRM's own seedBusinessDefaults. */
async function seeded(): Promise<Scene> {
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
  return sceneOf(context);
}

/** A business with the object types but none of the seeded link types. */
async function unseeded(): Promise<Scene> {
  const agency = await database.fixtures.agency();
  return sceneOf((await database.fixtures.business(agency.id)).context);
}

const uuid = (kind: 'deal' | 'contact', id: string) => parsePublicId(kind, id) ?? '';
const link = (s: Scene, input: unknown, invocation: Invocation = s.invocation) =>
  runCommand(services, linkDealContactCommand, input, invocation);

it('links a contact to a deal with the link type a new business is seeded with, once', async () => {
  const s = await seeded();
  const contactId = await s.contact('Maya');
  const deal = await s.deal('Wedding');
  const linked = await link(s, { id: deal.id, contactId, primary: true });
  expect(linked).toMatchObject({ dealId: deal.id, contactId, isPrimary: true });
  expect(await s.links()).toEqual([
    {
      deal: uuid('deal', deal.id),
      contact: uuid('contact', contactId),
      is_primary: true,
      source_kind: 'system',
    },
  ]);
  // The event is on both timelines: the deal's and the contact's.
  expect(await s.events()).toEqual([
    {
      type: 'deal.contact_linked',
      subject_id: uuid('deal', deal.id),
      payload: { contactId, primary: true },
      records: [uuid('deal', deal.id), uuid('contact', contactId)].sort(),
    },
  ]);
  // Repeating it, with or without the primary flag, changes nothing and says nothing.
  expect(await link(s, { id: deal.id, contactId, primary: true })).toEqual(linked);
  expect(await link(s, { id: deal.id, contactId })).toEqual(linked);
  expect(await s.links()).toHaveLength(1);
  expect(await s.events()).toHaveLength(1);
});

it('keeps one primary contact per deal, and tells every record that changed', async () => {
  const s = await seeded();
  const maya = await s.contact('Maya');
  const omar = await s.contact('Omar');
  const deal = await s.deal('Wedding');
  await link(s, { id: deal.id, contactId: maya, primary: true });
  // A new link is not primary unless asked.
  expect(await link(s, { id: deal.id, contactId: omar })).toMatchObject({ isPrimary: false });
  expect(await link(s, { id: deal.id, contactId: omar, primary: true })).toMatchObject({
    isPrimary: true,
  });
  expect(await s.links()).toMatchObject([
    { contact: uuid('contact', maya), is_primary: false },
    { contact: uuid('contact', omar), is_primary: true },
  ]);
  const events = await s.events();
  expect(events.map((event) => event.type)).toEqual([
    'deal.contact_linked',
    'deal.contact_linked',
    'deal.contact_link_changed',
  ]);
  expect(events[2]?.records).toEqual(
    [uuid('deal', deal.id), uuid('contact', maya), uuid('contact', omar)].sort(),
  );
  expect(await link(s, { id: deal.id, contactId: omar, primary: false })).toMatchObject({
    isPrimary: false,
  });
  expect((await s.links()).filter((row) => row.is_primary)).toEqual([]);
});

it("reads a contact's deals newest first, by status and pipeline, without the trash", async () => {
  const s = await seeded();
  const maya = await s.contact('Maya');
  const omar = await s.contact('Omar');
  const first = await s.deal('First');
  const won = await s.deal('Won', { status: 'won' });
  const binned = await s.deal('Binned');
  const latest = await s.deal('Latest');
  const other = await s.deal("Omar's");
  for (const deal of [first, won, binned, latest])
    await link(s, { id: deal.id, contactId: maya, primary: true });
  await link(s, { id: other.id, contactId: omar });
  await database.as('postgres', (sql) =>
    sql.query('update crm.deals set deleted_at = now() where id = $1', [uuid('deal', binned.id)]),
  );
  const read = (query?: Parameters<typeof readContactDeals>[3], contactId = maya) =>
    withTenant(db, s.invocation.context, async (trx) =>
      (await readContactDeals(trx, s.invocation, contactId, query)).map((deal) => deal.name),
    );
  expect(await read()).toEqual(['Latest', 'Won', 'First']);
  expect(await read({ status: 'open' })).toEqual(['Latest', 'First']);
  expect(await read({ status: 'won' })).toEqual(['Won']);
  expect(await read({ status: 'open', limit: 1 })).toEqual(['Latest']);
  // Limits outside 1 to the most a read gives are brought inside it.
  expect(await read({ limit: 0 })).toEqual(['Latest']);
  expect(await read({ limit: CONTACT_DEALS_LIMIT + 1 })).toHaveLength(3);
  expect(await read({ pipelineId: s.pipelineId })).toHaveLength(3);
  expect(await read({ pipelineId: toPublicId('pipeline', uuid('deal', first.id)) })).toEqual([]);
  expect(await read({ pipelineId: 'not a pipeline' })).toEqual([]);
  expect(await read(undefined, omar)).toEqual(["Omar's"]);
  // Only a contact has deals this way: a deal's id, or a made-up one, finds nothing.
  await expect(read(undefined, first.id)).rejects.toBeInstanceOf(NotFoundError);
  await expect(read(undefined, 'con_missing')).rejects.toBeInstanceOf(NotFoundError);
});

it('refuses without the link type, with it archived, and for a contact in the trash', async () => {
  const bare = await unseeded();
  const contactId = await bare.contact('Maya');
  const deal = await bare.deal('Wedding');
  await expect(link(bare, { id: deal.id, contactId })).rejects.toBeInstanceOf(ConflictError);
  expect(await bare.links()).toEqual([]);

  const archived = await seeded();
  const theirs = await archived.contact('Maya');
  const theirDeal = await archived.deal('Wedding');
  await database.as('postgres', (sql) =>
    sql.query('update crm.link_types set archived_at = now() where business_id = $1', [
      archived.businessId,
    ]),
  );
  await expect(link(archived, { id: theirDeal.id, contactId: theirs })).rejects.toBeInstanceOf(
    ConflictError,
  );

  const trashed = await seeded();
  const gone = await trashed.contact('Maya');
  const open = await trashed.deal('Wedding');
  await database.as('postgres', (sql) =>
    sql.query('update crm.contacts set deleted_at = now() where id = $1', [uuid('contact', gone)]),
  );
  await expect(link(trashed, { id: open.id, contactId: gone })).rejects.toBeInstanceOf(
    ConflictError,
  );
  expect(await trashed.links()).toEqual([]);
  expect(await trashed.events()).toEqual([]);
});

it("never links across businesses, and needs the deals permission and each id's own kind", async () => {
  const mine = await seeded();
  const other = await seeded();
  const myContact = await mine.contact('Maya');
  const myDeal = await mine.deal('Wedding');
  const theirContact = await other.contact('Omar');
  const theirDeal = await other.deal('Reception');
  await expect(link(mine, { id: myDeal.id, contactId: theirContact })).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(link(mine, { id: theirDeal.id, contactId: myContact })).rejects.toBeInstanceOf(
    NotFoundError,
  );
  expect(await mine.links()).toEqual([]);
  expect(await other.links()).toEqual([]);
  await expect(
    withTenant(db, mine.invocation.context, (trx) =>
      readContactDeals(trx, mine.invocation, theirContact),
    ),
  ).rejects.toBeInstanceOf(NotFoundError);

  await expect(
    link(
      mine,
      { id: myDeal.id, contactId: myContact },
      { ...mine.invocation, permissions: new Set() },
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
  // A contact's id where the deal's goes, or the other way round, is not accepted.
  expect(dealContactLinkInput.safeParse({ id: myContact, contactId: myContact }).success).toBe(
    false,
  );
  expect(dealContactLinkInput.safeParse({ id: myDeal.id, contactId: myDeal.id }).success).toBe(
    false,
  );
  expect(await mine.links()).toEqual([]);
});

it('keeps a deal and its contact link together or not at all in one transaction', async () => {
  const s = await seeded();
  const contactId = await s.contact('Maya');
  // What an automation's deal.create step does: both handlers in the caller's transaction.
  const createForContact = defineCommand({
    name: 'test.deal_for_contact',
    permission: 'deals.manage',
    input: createDealInput,
    async handle(trx, input, command): Promise<string> {
      const deal = await createDealCommand.handle(trx, input, command);
      await linkDealContactCommand.handle(trx, { id: deal.id, contactId, primary: true }, command);
      return deal.id;
    },
  });
  const input = { name: 'Wedding', pipelineId: s.pipelineId, stageId: s.stageId, currency: 'KES' };
  const dealId = await runCommand(services, createForContact, input, s.invocation);
  expect(await s.links()).toMatchObject([{ deal: uuid('deal', dealId), is_primary: true }]);

  await database.as('postgres', (sql) =>
    sql.query('update crm.link_types set archived_at = now() where business_id = $1', [
      s.businessId,
    ]),
  );
  await expect(runCommand(services, createForContact, input, s.invocation)).rejects.toBeInstanceOf(
    ConflictError,
  );
  // The refused link took its deal with it: still the one deal from before.
  expect(
    await database.withTenant(s.invocation.context, (sql) =>
      sql.query<{ name: string }>('select name from crm.deals'),
    ),
  ).toHaveLength(1);
});
