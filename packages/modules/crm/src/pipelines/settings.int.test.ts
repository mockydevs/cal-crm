// The settings of a pipeline and its stages, one pipeline moved, copied or deleted, and the
// opportunity settings with the two follower rules. Against a migrated Postgres as crm_app
// under row-level security, through the routes the server registers.
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  contactDetails,
  deal,
  dealDetails,
  MAX_CONTACT_FOLLOWERS,
  opportunitySettings,
  pipelineConfiguration,
  type OpportunitySettings,
  type PipelineConfiguration,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions, waitingForLock, type Gate } from '../../test/contact-details.js';
import { dealScene, type DealScene } from '../../test/deal-people.js';
import { contactDetailRoutes } from '../contacts/detail-routes.js';
import { contactRoutes } from '../contacts/routes.js';
import { dealPeopleRoutes } from '../deals/people-routes.js';
import { createDealRoutes } from '../deals/routes.js';
import { pipelineRoutes } from './routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const gate: Gate = { whenResolving: () => Promise.resolve() };
const options = detailOptions(gate);
const routes = [
  ...pipelineRoutes,
  ...createDealRoutes(options),
  ...dealPeopleRoutes(options),
  ...contactDetailRoutes(options),
  ...contactRoutes,
];

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
  request: { id?: string; body?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return route.run(
    {
      invocation,
      params: request.id === undefined ? {} : { id: request.id },
      body: request.body,
      query: {},
    },
    services,
  );
}
const pipelines = async (
  operationId: string,
  invocation: Invocation,
  id?: string,
  body?: unknown,
) =>
  pipelineConfiguration.parse(
    await call(operationId, invocation, { ...(id === undefined ? {} : { id }), body }),
  );
const read = (invocation: Invocation) => pipelines('getPipelines', invocation);
const save = (invocation: Invocation, current: PipelineConfiguration, items: unknown) =>
  pipelines('savePipelines', invocation, undefined, { revision: current.revision, items });
const failure = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );
const names = (configuration: PipelineConfiguration) =>
  configuration.items.map((item) => item.name);

/** A business with a member who may do everything, and its one seeded pipeline. */
async function world(): Promise<{ s: DealScene; me: Invocation }> {
  const s = await dealScene(database);
  return { s, me: (await s.member('Dana Brooks')).as() };
}
/** When each pipeline's row and stages were last written, by name, as the database has it. */
const writtenAt = (s: DealScene) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ name: string; at: string }>(
      `select p.name, greatest(p.updated_at, coalesce(max(s.updated_at), p.updated_at))::text as at
       from crm.pipelines p left join crm.pipeline_stages s on s.pipeline_id = p.id
       where p.business_id = $1 group by p.id, p.name, p.updated_at order by p.name`,
      [s.businessId],
    ),
  );

describe('the settings of a pipeline and its stages', () => {
  it('start as stage probabilities, no colours and shown in both charts, and are answered with when the pipeline last changed', async () => {
    const { me } = await world();
    const [sales] = (await read(me)).items;
    expect(sales).toMatchObject({
      name: 'Sales',
      dealProbability: false,
      colorStyle: 'none',
      showInFunnel: true,
      showInPie: true,
      stages: [
        { name: 'New lead', probability: null, color: null, showInFunnel: true, showInPie: true },
        { name: 'Proposal', probability: null, color: null, showInFunnel: true, showInPie: true },
      ],
    });
    expect(Number.isNaN(Date.parse(sales?.updatedAt ?? ''))).toBe(false);
  });

  it('are saved with the pipeline, stay through a save that leaves them out, and are refused when wrong', async () => {
    const { me } = await world();
    const opened = await read(me);
    const [sales] = opened.items;
    if (sales === undefined) throw new Error('Missing the pipeline.');
    const [lead, proposal] = sales.stages;
    const saved = await save(me, opened, [
      {
        ...sales,
        dealProbability: true,
        colorStyle: 'tint',
        showInPie: false,
        stages: [
          { ...lead, probability: 20, color: '#12b76a', showInFunnel: false },
          { ...proposal, probability: 100 },
          {
            name: 'Closed',
            description: '',
            archived: false,
            probability: 0,
            color: '#f04438',
          },
        ],
      },
    ]);
    expect(saved.items[0]).toMatchObject({
      dealProbability: true,
      colorStyle: 'tint',
      showInFunnel: true,
      showInPie: false,
      stages: [
        { probability: 20, color: '#12b76a', showInFunnel: false, showInPie: true },
        { probability: 100, color: null },
        { name: 'Closed', probability: 0, color: '#f04438', showInFunnel: true, showInPie: true },
      ],
    });
    // A screen that knows none of the settings sends what the first version of this API
    // took, and erases nothing.
    const bare = saved.items.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      archived: item.archived,
      stages: item.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        description: stage.description,
        archived: stage.archived,
      })),
    }));
    const kept = await save(me, saved, bare);
    expect(kept.items).toEqual(saved.items);
    // Null clears a probability and a colour.
    const [first] = kept.items;
    const cleared = await save(me, kept, [
      {
        ...first,
        stages: first?.stages.map((stage) => ({ ...stage, probability: null, color: null })),
      },
    ]);
    expect(cleared.items[0]?.stages.map((stage) => [stage.probability, stage.color])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    for (const wrong of [
      { colorStyle: 'rainbow' },
      { dealProbability: 'yes' },
      { stages: [{ ...lead, probability: 101 }] },
      { stages: [{ ...lead, probability: 12.5 }] },
      { stages: [{ ...lead, color: '#12B76A' }] },
      { stages: [{ ...lead, color: 'green' }] },
    ])
      expect(await failure(save(me, cleared, [{ ...sales, ...wrong }]))).toBeInstanceOf(
        ValidationError,
      );
    expect((await read(me)).revision).toBe(cleared.revision);
  });

  it('leave a pipeline that a save does not change unwritten, so its date stays', async () => {
    const { s, me } = await world();
    const opened = await read(me);
    const [sales] = opened.items;
    const added = await save(me, opened, [
      sales,
      { name: 'Support', description: '', archived: false, stages: [] },
    ]);
    const before = await writtenAt(s);
    // What was read is sent back with one stage of the second pipeline added.
    const [first, second] = added.items;
    const saved = await save(me, added, [
      first,
      { ...second, stages: [{ name: 'Open', description: '', archived: false }] },
    ]);
    const after = await writtenAt(s);
    expect(after.find((row) => row.name === 'Sales')).toEqual(
      before.find((row) => row.name === 'Sales'),
    );
    expect(after.find((row) => row.name === 'Support')?.at).not.toBe(
      before.find((row) => row.name === 'Support')?.at,
    );
    expect(saved.items[0]?.updatedAt).toBe(added.items[0]?.updatedAt);
    expect(Date.parse(saved.items[1]?.updatedAt ?? '')).toBeGreaterThan(
      Date.parse(added.items[1]?.updatedAt ?? ''),
    );
    // Two pipelines can still trade names in one save.
    const swapped = await save(me, saved, [
      { ...saved.items[0], name: 'Support' },
      { ...saved.items[1], name: 'Sales' },
    ]);
    expect(names(swapped)).toEqual(['Support', 'Sales']);
  });
});

describe('one pipeline', () => {
  const three = async () => {
    const { s, me } = await world();
    const opened = await read(me);
    const made = await save(me, opened, [
      ...opened.items,
      { name: 'Support', description: '', archived: false, stages: [] },
      { name: 'Renewals', description: '', archived: false, stages: [] },
    ]);
    return { s, me, made };
  };
  const idOf = (configuration: PipelineConfiguration, name: string) =>
    configuration.items.find((item) => item.name === name)?.id ?? '';

  it('moves to a position counted from 1, past the end to the end, and only what moved is written', async () => {
    const { s, me, made } = await three();
    expect(names(made)).toEqual(['Sales', 'Support', 'Renewals']);
    const first = await pipelines('movePipeline', me, idOf(made, 'Renewals'), {
      position: 1,
      revision: made.revision,
    });
    expect(names(first)).toEqual(['Renewals', 'Sales', 'Support']);
    expect(first.revision).not.toBe(made.revision);
    const last = await pipelines('movePipeline', me, idOf(first, 'Renewals'), {
      position: 99,
      revision: first.revision,
    });
    expect(names(last)).toEqual(['Sales', 'Support', 'Renewals']);
    // Where it already is: nothing is written and nothing reported.
    const same = await pipelines('movePipeline', me, idOf(last, 'Support'), {
      position: 2,
      revision: last.revision,
    });
    expect(same.revision).toBe(last.revision);
    // Renewals changes places with Support: Sales stays first, and is not written.
    const before = await writtenAt(s);
    const middle = await pipelines('movePipeline', me, idOf(last, 'Renewals'), {
      position: 2,
      revision: last.revision,
    });
    expect(names(middle)).toEqual(['Sales', 'Renewals', 'Support']);
    const after = await writtenAt(s);
    expect(after.find((row) => row.name === 'Sales')).toEqual(
      before.find((row) => row.name === 'Sales'),
    );
    expect(await s.events('pipeline.moved')).toEqual([
      {
        type: 'pipeline.moved',
        payload: { pipelineId: idOf(made, 'Renewals'), from: 3, to: 1 },
      },
      {
        type: 'pipeline.moved',
        payload: { pipelineId: idOf(made, 'Renewals'), from: 1, to: 3 },
      },
      {
        type: 'pipeline.moved',
        payload: { pipelineId: idOf(made, 'Renewals'), from: 3, to: 2 },
      },
    ]);
    for (const position of [0, 101, 1.5])
      expect(
        await failure(
          pipelines('movePipeline', me, idOf(middle, 'Sales'), {
            position,
            revision: middle.revision,
          }),
        ),
      ).toBeInstanceOf(ValidationError);
  });

  it('is copied with its stages in use and its settings, after the original, under a free name, with no deals', async () => {
    const { s, me } = await world();
    const opened = await read(me);
    const [sales] = opened.items;
    if (sales === undefined) throw new Error('Missing the pipeline.');
    const [lead, proposal] = sales.stages;
    const set = await save(me, opened, [
      {
        ...sales,
        dealProbability: true,
        colorStyle: 'dot',
        showInFunnel: false,
        stages: [
          { ...lead, probability: 25, color: '#12b76a', showInPie: false },
          { ...proposal, archived: true },
          { name: 'Won over', description: 'Agreed', archived: false, probability: 90 },
        ],
      },
      { name: 'Support', description: '', archived: false, stages: [] },
    ]);
    await call('createDeal', me, {
      body: { name: 'A deal', pipelineId: sales.id, stageId: lead?.id, currency: 'KES' },
    });

    const copied = await pipelines('duplicatePipeline', me, sales.id, { revision: set.revision });
    expect(names(copied)).toEqual(['Sales', 'Sales (copy)', 'Support']);
    const copy = copied.items[1];
    expect(copy).toMatchObject({
      archived: false,
      dealProbability: true,
      colorStyle: 'dot',
      showInFunnel: false,
      showInPie: true,
      stages: [
        { name: 'New lead', probability: 25, color: '#12b76a', showInPie: false },
        { name: 'Won over', description: 'Agreed', probability: 90, color: null },
      ],
    });
    // New ids throughout, and none of the original's deals.
    expect(copy?.id).not.toBe(sales.id);
    expect(copy?.stages.map((stage) => stage.id)).not.toContain(lead?.id);
    const deals = await database.as('crm_owner', (sql) =>
      sql.query('select 1 from crm.deals where pipeline_id = $1', [
        parsePublicId('pipeline', copy?.id ?? ''),
      ]),
    );
    expect(deals).toEqual([]);
    // Again: the next free name. A name of the caller's own is used as given, unless taken.
    const again = await pipelines('duplicatePipeline', me, sales.id, {
      revision: copied.revision,
    });
    expect(names(again)).toEqual(['Sales', 'Sales (copy 2)', 'Sales (copy)', 'Support']);
    const named = await pipelines('duplicatePipeline', me, sales.id, {
      revision: again.revision,
      name: 'Enterprise sales',
    });
    expect(names(named)[1]).toBe('Enterprise sales');
    expect(
      await failure(
        pipelines('duplicatePipeline', me, sales.id, { revision: named.revision, name: 'support' }),
      ),
    ).toBeInstanceOf(ValidationError);
    expect((await read(me)).revision).toBe(named.revision);
    expect((await s.events('pipeline.duplicated')).map((event) => event.payload)).toMatchObject([
      { fromPipelineId: sales.id, stageCount: 2 },
      { fromPipelineId: sales.id, stageCount: 2 },
      { fromPipelineId: sales.id, stageCount: 2 },
    ]);
  });

  it('keeps a copy of a long name inside the longest a name may be', async () => {
    const { me } = await world();
    const opened = await read(me);
    const long = 'N'.repeat(80);
    const renamed = await save(me, opened, [{ ...opened.items[0], name: long }]);
    const copied = await pipelines('duplicatePipeline', me, renamed.items[0]?.id, {
      revision: renamed.revision,
    });
    expect(copied.items[1]?.name).toBe(`${'N'.repeat(73)} (copy)`);
  });

  it('is deleted with its stages when it holds no deal and never held one, and refused otherwise', async () => {
    const { s, me, made } = await three();
    const sales = made.items[0];
    await call('createDeal', me, {
      body: {
        name: 'A deal',
        pipelineId: sales?.id,
        stageId: sales?.stages[0]?.id,
        currency: 'KES',
      },
    });
    // Holding a deal: refused, and the pipeline is still there.
    expect(
      await failure(pipelines('deletePipeline', me, sales?.id, { revision: made.revision })),
    ).toBeInstanceOf(ConflictError);
    expect(names(await read(me))).toEqual(['Sales', 'Support', 'Renewals']);

    const gone = await pipelines('deletePipeline', me, idOf(made, 'Support'), {
      revision: made.revision,
    });
    expect(names(gone)).toEqual(['Sales', 'Renewals']);
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string; position: number }>(
        'select name, position from crm.pipelines where business_id = $1 order by position',
        [s.businessId],
      ),
    );
    expect(rows).toEqual([
      { name: 'Sales', position: 0 },
      { name: 'Renewals', position: 1 },
    ]);
    expect(await s.events('pipeline.deleted')).toEqual([
      { type: 'pipeline.deleted', payload: { pipelineId: idOf(made, 'Support') } },
    ]);
  });

  it('is not deleted while a deal that moved on once passed through it, or a deal names it without any history', async () => {
    const { s, me, made } = await three();
    const sales = made.items[0];
    const withStage = await save(me, made, [
      made.items[0],
      {
        ...made.items[1],
        stages: [{ name: 'Open', description: '', archived: false }],
      },
      made.items[2],
    ]);
    const support = withStage.items[1];
    const created = deal.parse(
      await call('createDeal', me, {
        body: {
          name: 'Passing through',
          pipelineId: support?.id,
          stageId: support?.stages[0]?.id,
          currency: 'KES',
        },
      }),
    );
    // Moved to another pipeline: Support holds no deal now, but its history names it.
    await call('updateDeal', me, {
      id: created.id,
      body: {
        name: created.name,
        pipelineId: sales?.id,
        stageId: sales?.stages[0]?.id,
        currency: 'KES',
        revision: created.revision,
      },
    });
    expect(
      await failure(pipelines('deletePipeline', me, support?.id, { revision: withStage.revision })),
    ).toBeInstanceOf(ConflictError);
    expect(names(await read(me))).toContain('Support');
    // A deal that names the pipeline with no history of its own (written by something
    // other than the deal commands) keeps it too.
    const renewals = withStage.items[2];
    const opened = await save(me, withStage, [
      withStage.items[0],
      withStage.items[1],
      { ...renewals, stages: [{ name: 'Due', description: '', archived: false }] },
    ]);
    const due = opened.items[2];
    await database.withTenant(s.context, async (sql) => {
      const record = await sql.one<{ id: string }>(
        `insert into crm.records (business_id, kind, object_type_id)
         select $1, 'deal', id from crm.object_types where business_id = $1 and kind = 'deal'
         returning id`,
        [s.businessId],
      );
      await sql.query(
        `insert into crm.deals (business_id, id, name, pipeline_id, stage_id, currency, created_by_kind)
         values ($1, $2, 'Written directly', $3, $4, 'KES', 'import')`,
        [
          s.businessId,
          record.id,
          parsePublicId('pipeline', due?.id ?? ''),
          parsePublicId('stage', due?.stages[0]?.id ?? ''),
        ],
      );
    });
    expect(
      await failure(pipelines('deletePipeline', me, due?.id, { revision: opened.revision })),
    ).toBeInstanceOf(ConflictError);
    expect(names(await read(me))).toContain('Renewals');
  });

  it('is changed only from the configuration as it is now, by someone who manages pipelines, in their own business', async () => {
    const { me, made } = await three();
    const other = await world();
    const theirs = (await read(other.me)).items[0]?.id ?? '';
    const support = idOf(made, 'Support');
    const moved = await pipelines('movePipeline', me, support, {
      position: 1,
      revision: made.revision,
    });
    const attempts = (invocation: Invocation, id: string, revision: string) => [
      pipelines('movePipeline', invocation, id, { position: 2, revision }),
      pipelines('duplicatePipeline', invocation, id, { revision }),
      pipelines('deletePipeline', invocation, id, { revision }),
    ];
    // From the configuration before the move: refused.
    for (const refused of await Promise.all(attempts(me, support, made.revision).map(failure)))
      expect(refused).toBeInstanceOf(ConflictError);
    // Another business's pipeline, and an id that names none: not found.
    const missing = toPublicId('pipeline', parsePublicId('contact', await other.s.contact()) ?? '');
    for (const id of [theirs, missing])
      for (const refused of await Promise.all(attempts(me, id, moved.revision).map(failure)))
        expect(refused).toBeInstanceOf(NotFoundError);
    // Without pipelines.manage: refused for the permission.
    const viewer = { ...me, permissions: new Set<never>() };
    for (const refused of await Promise.all(
      attempts(viewer, support, moved.revision).map(failure),
    )) {
      expect(refused).toBeInstanceOf(ForbiddenError);
      expect((refused as ForbiddenError).permission).toBe('pipelines.manage');
    }
    expect((await read(me)).revision).toBe(moved.revision);
    expect(names(await read(other.me))).toEqual(['Sales']);
  });

  it('goes to one of two people who change the configuration at once; the other is refused', async () => {
    const { s, me, made } = await three();
    // Someone else holds the configuration's lock; both changes are seen waiting for it,
    // then let go together. Each was made from the same revision.
    const outcomes = await database
      .as('crm_owner', async (sql) => {
        await sql.query('select 1 from tenancy.businesses where id = $1 for update', [
          s.businessId,
        ]);
        const settled = Promise.allSettled([
          pipelines('movePipeline', me, idOf(made, 'Support'), {
            position: 1,
            revision: made.revision,
          }),
          pipelines('movePipeline', me, idOf(made, 'Renewals'), {
            position: 1,
            revision: made.revision,
          }),
        ]);
        await waitingForLock(database, 2);
        return [settled] as const;
      })
      .then(([settled]) => settled);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const lost = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(lost?.status === 'rejected' && lost.reason).toBeInstanceOf(ConflictError);
    // Whichever won, the configuration is one of the two whole results, never a mix.
    expect([
      ['Support', 'Sales', 'Renewals'],
      ['Renewals', 'Sales', 'Support'],
    ]).toContainEqual(names(await read(me)));
    expect(await s.events('pipeline.moved')).toHaveLength(1);
  });
});

describe('the opportunity settings', () => {
  const settings = async (operationId: string, invocation: Invocation, body?: unknown) =>
    opportunitySettings.parse(await call(operationId, invocation, { body }));
  const set = async (invocation: Invocation, values: Partial<OpportunitySettings>) => {
    const current = await settings('getOpportunitySettings', invocation);
    return settings('updateOpportunitySettings', invocation, {
      allowDifferentOwners: current.allowDifferentOwners,
      opportunityOwnerFollowsContact: current.opportunityOwnerFollowsContact,
      contactOwnerFollowsOpportunity: current.contactOwnerFollowsOpportunity,
      revision: current.revision,
      ...values,
    });
  };
  const makeDeal = async (s: DealScene, invocation: Invocation, more: object = {}) =>
    deal.parse(
      await call('createDeal', invocation, {
        body: {
          name: 'Garden fence',
          pipelineId: s.pipelineId,
          stageId: s.stageId,
          currency: 'KES',
          ...more,
        },
      }),
    );
  const dealOf = async (invocation: Invocation, id: string) =>
    dealDetails.parse(await call('getDealDetails', invocation, { id }));
  const contactOf = async (invocation: Invocation, id: string) =>
    contactDetails.parse(await call('getContactDetails', invocation, { id }));
  const ownDeal = async (invocation: Invocation, id: string, owner: string | null) =>
    dealDetails.parse(
      await call('assignDealOwner', invocation, {
        id,
        body: { owner, revision: (await dealOf(invocation, id)).ownerRevision },
      }),
    );
  const ownContact = async (invocation: Invocation, id: string, owner: string | null) =>
    contactDetails.parse(
      await call('assignContactOwner', invocation, {
        id,
        body: { owner, revision: (await contactOf(invocation, id)).ownerRevision },
      }),
    );

  it('start with owners apart and nobody made a follower, and are saved under a revision by someone who manages pipelines', async () => {
    const { s, me } = await world();
    const start = await settings('getOpportunitySettings', me);
    expect(start).toMatchObject({
      allowDifferentOwners: true,
      opportunityOwnerFollowsContact: false,
      contactOwnerFollowsOpportunity: false,
      canManage: true,
    });
    const saved = await set(me, {
      allowDifferentOwners: false,
      contactOwnerFollowsOpportunity: true,
    });
    expect(saved).toMatchObject({
      allowDifferentOwners: false,
      opportunityOwnerFollowsContact: false,
      contactOwnerFollowsOpportunity: true,
    });
    expect(saved.revision).not.toBe(start.revision);
    expect(await settings('getOpportunitySettings', me)).toEqual(saved);
    // The same again reports nothing; a stale save and a viewer's are refused.
    await set(me, {});
    expect(await s.events('opportunity_settings')).toHaveLength(1);
    expect(
      await failure(
        settings('updateOpportunitySettings', me, {
          allowDifferentOwners: true,
          opportunityOwnerFollowsContact: true,
          contactOwnerFollowsOpportunity: true,
          revision: start.revision,
        }),
      ),
    ).toBeInstanceOf(ConflictError);
    const viewer = { ...me, permissions: new Set<never>() };
    expect((await settings('getOpportunitySettings', viewer)).canManage).toBe(false);
    const refused = await failure(set(viewer, { allowDifferentOwners: true }));
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect((refused as ForbiddenError).permission).toBe('pipelines.manage');
    expect(await settings('getOpportunitySettings', me)).toEqual(saved);
    // Another business has its own.
    const other = await world();
    expect((await settings('getOpportunitySettings', other.me)).allowDifferentOwners).toBe(true);
  });

  it("make a deal's new owner a follower of its primary contact only while that rule is on", async () => {
    const { s, me } = await world();
    const lee = await s.member('Lee Park');
    const kim = await s.member('Kim Osei');
    const maya = await s.contact('Maya');
    const other = await s.contact('Other');
    const made = await makeDeal(s, me, { primaryContactId: maya, additionalContactIds: [other] });

    // Off: an owner follows nothing.
    await ownDeal(me, made.id, lee.membershipId);
    expect((await contactOf(me, maya)).followers).toEqual([]);

    await set(me, { opportunityOwnerFollowsContact: true });
    await ownDeal(me, made.id, kim.membershipId);
    expect((await contactOf(me, maya)).followers.map((each) => each.name)).toEqual(['Kim Osei']);
    // Only the primary contact; and the owner before is not made one, nor removed.
    expect((await contactOf(me, other)).followers).toEqual([]);
    await ownDeal(me, made.id, lee.membershipId);
    expect((await contactOf(me, maya)).followers.map((each) => each.name).sort()).toEqual([
      'Kim Osei',
      'Lee Park',
    ]);
    // Back to someone who already follows, and to nobody: nothing more is written.
    await ownDeal(me, made.id, kim.membershipId);
    await ownDeal(me, made.id, null);
    expect(await s.events('contact.follower')).toEqual([
      { type: 'contact.follower_added', payload: { followerUserId: kim.userId } },
      { type: 'contact.follower_added', payload: { followerUserId: lee.userId } },
    ]);
  });

  it("leave the contact alone when it is the new owner's own, in the trash, full of followers, or absent", async () => {
    const { s, me } = await world();
    const lee = await s.member('Lee Park');
    await set(me, { opportunityOwnerFollowsContact: true });
    // The contact's own owner needs no follower's place on it.
    const owned = await s.contact('Owned');
    await ownContact(me, owned, lee.membershipId);
    const first = await makeDeal(s, me, { primaryContactId: owned });
    await ownDeal(me, first.id, null);
    await ownDeal(me, first.id, lee.membershipId);
    expect((await contactOf(me, owned)).followers).toEqual([]);
    // A contact with ten followers takes no eleventh, and the owner change still happens.
    const full = await s.contact('Full');
    const ten = [];
    for (let n = 0; n < MAX_CONTACT_FOLLOWERS; n += 1) ten.push((await s.member()).membershipId);
    await call('addContactFollowers', me, { id: full, body: { followers: ten } });
    const second = await makeDeal(s, me, { primaryContactId: full });
    expect((await ownDeal(me, second.id, lee.membershipId)).owner?.name).toBe('Lee Park');
    expect((await contactOf(me, full)).followers).toHaveLength(MAX_CONTACT_FOLLOWERS);
    // A contact in the trash is left as it is.
    const binned = await s.contact('Binned');
    const fourth = await makeDeal(s, me, { primaryContactId: binned });
    await call('trashContact', me, { id: binned });
    expect((await ownDeal(me, fourth.id, lee.membershipId)).owner?.name).toBe('Lee Park');
    expect((await contactOf(me, binned)).followers).toEqual([]);
    // No contact at all.
    const third = await makeDeal(s, me);
    expect((await ownDeal(me, third.id, lee.membershipId)).owner?.name).toBe('Lee Park');
    expect(await s.events('contact.follower_added')).toHaveLength(MAX_CONTACT_FOLLOWERS);
  });

  it("make a contact's new owner a follower of the open deals it is the primary contact of only while that rule is on", async () => {
    const { s, me } = await world();
    const lee = await s.member('Lee Park');
    const kim = await s.member('Kim Osei');
    const maya = await s.contact('Maya');
    const omar = await s.contact('Omar');
    const open = await makeDeal(s, me, { name: 'Open', primaryContactId: maya });
    const second = await makeDeal(s, me, { name: 'Second', primaryContactId: maya });
    const won = await makeDeal(s, me, { name: 'Won', primaryContactId: maya, status: 'won' });
    const additional = await makeDeal(s, me, {
      name: 'Additional',
      primaryContactId: omar,
      additionalContactIds: [maya],
    });
    const theirs = await makeDeal(s, me, { name: 'Kim owns it', primaryContactId: maya });
    await ownDeal(me, theirs.id, kim.membershipId);

    // Off: nothing follows.
    await ownContact(me, maya, lee.membershipId);
    for (const each of [open, second, won, additional, theirs])
      expect((await dealOf(me, each.id)).followers).toEqual([]);

    await set(me, { contactOwnerFollowsOpportunity: true });
    await ownContact(me, maya, kim.membershipId);
    const followers = async (id: string) =>
      (await dealOf(me, id)).followers.map((each) => each.name);
    expect(await followers(open.id)).toEqual(['Kim Osei']);
    expect(await followers(second.id)).toEqual(['Kim Osei']);
    // Not a closed deal, not one the contact is only an additional contact of, and not
    // one that is the new owner's already.
    expect(await followers(won.id)).toEqual([]);
    expect(await followers(additional.id)).toEqual([]);
    expect(await followers(theirs.id)).toEqual([]);
    // Again for the same owner changes nothing; for nobody, nothing either.
    await ownContact(me, maya, null);
    await ownContact(me, maya, kim.membershipId);
    expect(await s.events('deal.follower')).toEqual([
      { type: 'deal.follower_added', payload: { followerUserId: kim.userId } },
      { type: 'deal.follower_added', payload: { followerUserId: kim.userId } },
    ]);
  });

  it('let an owner change of a deal and one of its contact made at once both finish, with both rules on', async () => {
    const { s, me } = await world();
    const lee = await s.member('Lee Park');
    const kim = await s.member('Kim Osei');
    const maya = await s.contact('Maya');
    const made = await makeDeal(s, me, { primaryContactId: maya });
    await set(me, { opportunityOwnerFollowsContact: true, contactOwnerFollowsOpportunity: true });
    const dealRevision = (await dealOf(me, made.id)).ownerRevision;
    const contactRevision = (await contactOf(me, maya)).ownerRevision;

    // The deal's change holds its row and its turn while it resolves the member.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const atResolve = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let calls = 0;
    gate.whenResolving = async () => {
      calls += 1;
      if (calls === 1) {
        reached();
        await held;
      }
    };
    try {
      const first = call('assignDealOwner', me, {
        id: made.id,
        body: { owner: lee.membershipId, revision: dealRevision },
      });
      await atResolve;
      // The contact's change waits for its turn before it takes the contact's row: without
      // the turn it would hold the contact while the deal's change waits for it.
      const second = call('assignContactOwner', me, {
        id: maya,
        body: { owner: kim.membershipId, revision: contactRevision },
      });
      await waitingForLock(database);
      release();
      await Promise.all([first, second]);
    } finally {
      release();
      gate.whenResolving = () => Promise.resolve();
    }
    expect((await dealOf(me, made.id)).owner?.name).toBe('Lee Park');
    expect((await contactOf(me, maya)).owner?.name).toBe('Kim Osei');
    // Each new owner follows the other record.
    expect((await contactOf(me, maya)).followers.map((each) => each.name)).toEqual(['Lee Park']);
    expect((await dealOf(me, made.id)).followers.map((each) => each.name)).toEqual(['Kim Osei']);
  });
});

describe("a deal's own probability", () => {
  it('is a whole percent or nothing, stays through an edit that leaves it out, and does not change the revision of a deal without one', async () => {
    const { s, me } = await world();
    const body = { name: 'Fence', pipelineId: s.pipelineId, stageId: s.stageId, currency: 'KES' };
    const plain = deal.parse(await call('createDeal', me, { body }));
    expect(plain.probability).toBeNull();
    const made = deal.parse(await call('createDeal', me, { body: { ...body, probability: 35 } }));
    expect(made.probability).toBe(35);
    const edit = (current: { id: string; revision: string }, more: object) =>
      call('updateDeal', me, {
        id: current.id,
        body: { ...body, revision: current.revision, ...more },
      }).then((answer) => deal.parse(answer));
    const kept = await edit(made, { name: 'Fence, renamed' });
    expect(kept.probability).toBe(35);
    const full = await edit(kept, { probability: 100 });
    expect(full.probability).toBe(100);
    const none = await edit(full, { probability: 0 });
    expect(none.probability).toBe(0);
    const cleared = await edit(none, { probability: null });
    expect(cleared.probability).toBeNull();
    for (const wrong of [-1, 101, 12.5, '40'])
      expect(await failure(edit(cleared, { probability: wrong }))).toBeInstanceOf(ValidationError);
    // A stale edit of it is refused like any other.
    expect(await failure(edit(made, { probability: 5 }))).toBeInstanceOf(ConflictError);
  });
});
