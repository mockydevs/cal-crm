// One change applied to many deals at once, and the list of the bulk actions run. Against a
// migrated Postgres as crm_app under row-level security, through the routes the server
// registers.
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  bulkDealsInput,
  bulkDealsResult,
  contactDetails,
  deal,
  dealBulkActionList,
  dealDetails,
  DEAL_BULK_LIMIT,
  opportunitySettings,
  pipelineConfiguration,
  type BulkDealsResult,
  type Deal,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ForbiddenError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions, waitingForLock, type Gate } from '../../test/contact-details.js';
import { dealScene, type DealScene } from '../../test/deal-people.js';
import { contactDetailRoutes } from '../contacts/detail-routes.js';
import { pipelineRoutes } from '../pipelines/routes.js';
import { trashRoutes } from '../trash/routes.js';
import { dealPeopleRoutes } from './people-routes.js';
import { createDealRoutes } from './routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const gate: Gate = { whenResolving: () => Promise.resolve() };
const options = detailOptions(gate);
const routes = [
  ...dealPeopleRoutes(options),
  ...createDealRoutes(options),
  ...contactDetailRoutes(options),
  ...pipelineRoutes,
  ...trashRoutes,
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
  request: { id?: string; body?: unknown; query?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return route.run(
    {
      invocation,
      params: request.id === undefined ? {} : { id: request.id },
      body: request.body,
      query: request.query ?? {},
    },
    services,
  );
}
const make = async (s: DealScene, invocation: Invocation, name: string, more: object = {}) =>
  deal.parse(
    await call('createDeal', invocation, {
      body: { name, pipelineId: s.pipelineId, stageId: s.stageId, currency: 'KES', ...more },
    }),
  );
const bulk = async (invocation: Invocation, body: object): Promise<BulkDealsResult> =>
  bulkDealsResult.parse(await call('bulkUpdateDeals', invocation, { body }));
const readDeal = async (invocation: Invocation, id: string): Promise<Deal> =>
  deal.parse(await call('getDeal', invocation, { id }));
const ownerOf = async (invocation: Invocation, id: string) =>
  dealDetails.parse(await call('getDealDetails', invocation, { id })).owner?.name ?? null;
const history = async (invocation: Invocation) =>
  dealBulkActionList.parse(await call('listDealBulkActions', invocation)).items;
const failure = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );
const outcomes = (result: BulkDealsResult) => result.results.map((each) => each.outcome);

describe('a bulk action on deals', () => {
  it('reassigns the owner of each deal that has another, once, and reports each change as its own', async () => {
    const s = await dealScene(database);
    const dana = await s.member('Dana Brooks');
    const lee = await s.member('Lee Park');
    const one = await make(s, dana.as(), 'One');
    const two = await make(s, dana.as(), 'Two');
    const three = await make(s, dana.as(), 'Three');
    await bulk(dana.as(), { action: 'assign_owner', ids: [three.id], owner: lee.membershipId });

    const result = await bulk(dana.as(), {
      action: 'assign_owner',
      ids: [one.id, two.id, three.id],
      owner: lee.membershipId,
    });
    expect(result).toMatchObject({ action: 'assign_owner', done: 2, unchanged: 1, skipped: 0 });
    expect(result.results).toEqual([
      { id: one.id, outcome: 'done', reason: null },
      { id: two.id, outcome: 'done', reason: null },
      { id: three.id, outcome: 'unchanged', reason: null },
    ]);
    for (const each of [one, two, three])
      expect(await ownerOf(dana.as(), each.id)).toBe('Lee Park');
    // The same request again changes nothing, writes no event and is not listed.
    const again = await bulk(dana.as(), {
      action: 'assign_owner',
      ids: [one.id, two.id, three.id],
      owner: lee.membershipId,
    });
    expect(again).toMatchObject({ done: 0, unchanged: 3, skipped: 0, bulkActionId: null });
    expect(await s.events('deal.owner')).toEqual([
      { type: 'deal.owner_assigned', payload: { assignedUserId: lee.userId } },
      { type: 'deal.owner_assigned', payload: { assignedUserId: lee.userId } },
      { type: 'deal.owner_assigned', payload: { assignedUserId: lee.userId } },
    ]);
    // To nobody, and to "me".
    const none = await bulk(dana.as(), { action: 'assign_owner', ids: [one.id], owner: null });
    expect(outcomes(none)).toEqual(['done']);
    expect(await ownerOf(dana.as(), one.id)).toBeNull();
    await bulk(dana.as(), { action: 'assign_owner', ids: [one.id], owner: 'me' });
    expect(await ownerOf(dana.as(), one.id)).toBe('Dana Brooks');
    // Someone who is not on the team refuses the whole request.
    const outsider = await (await dealScene(database)).member();
    const refused = await failure(
      bulk(dana.as(), { action: 'assign_owner', ids: [two.id], owner: outsider.membershipId }),
    );
    expect((refused as ValidationError).issues).toEqual([
      expect.objectContaining({ path: '/owner', code: 'unavailable_member' }),
    ]);
    expect(await ownerOf(dana.as(), two.id)).toBe('Lee Park');
  });

  it('moves deals to a stage, of another pipeline too, with their stage history, and leaves the ones already there', async () => {
    const s = await dealScene(database);
    const me = (await s.member()).as();
    const one = await make(s, me, 'One');
    const there = await make(s, me, 'There', { stageId: s.secondStageId });
    const moved = await bulk(me, {
      action: 'move',
      ids: [one.id, there.id],
      pipelineId: s.pipelineId,
      stageId: s.secondStageId,
    });
    expect(outcomes(moved)).toEqual(['done', 'unchanged']);
    const now = await readDeal(me, one.id);
    expect(now).toMatchObject({ stageId: s.secondStageId, stageName: 'Proposal' });
    expect(Date.parse(now.stageEnteredAt)).toBeGreaterThan(Date.parse(one.stageEnteredAt));
    const stages = await database.as('crm_owner', (sql) =>
      sql.query<{ stage_id: string; open: boolean }>(
        `select stage_id, exited_at is null as open from crm.deal_stage_history
         where deal_id = $1 order by entered_at`,
        [parsePublicId('deal', one.id)],
      ),
    );
    expect(stages).toEqual([
      { stage_id: parsePublicId('stage', s.stageId), open: false },
      { stage_id: parsePublicId('stage', s.secondStageId), open: true },
    ]);
    expect(await s.events('deal.stage_changed')).toEqual([
      {
        type: 'deal.stage_changed',
        payload: {
          fromPipelineId: s.pipelineId,
          fromStageId: s.stageId,
          pipelineId: s.pipelineId,
          stageId: s.secondStageId,
        },
      },
    ]);
    // A stage that is not of the pipeline named, an archived one and another business's
    // refuse the whole request, and nothing moves.
    const elsewhere = await dealScene(database);
    for (const wrong of [
      { pipelineId: elsewhere.pipelineId, stageId: s.stageId },
      { pipelineId: elsewhere.pipelineId, stageId: elsewhere.stageId },
    ]) {
      const refused = await failure(bulk(me, { action: 'move', ids: [one.id], ...wrong }));
      expect((refused as ValidationError).issues).toEqual([
        expect.objectContaining({ path: '/stageId', code: 'unavailable' }),
      ]);
    }
    expect((await readDeal(me, one.id)).stageId).toBe(s.secondStageId);
    // An archived stage takes no deal either.
    const configuration = pipelineConfiguration.parse(await call('getPipelines', me));
    await call('savePipelines', me, {
      body: {
        revision: configuration.revision,
        items: configuration.items.map((item) => ({
          ...item,
          stages: item.stages.map((stage) => ({ ...stage, archived: stage.id === s.stageId })),
        })),
      },
    });
    const archived = await failure(
      bulk(me, { action: 'move', ids: [one.id], pipelineId: s.pipelineId, stageId: s.stageId }),
    );
    expect((archived as ValidationError).issues).toEqual([
      expect.objectContaining({ path: '/stageId', code: 'unavailable' }),
    ]);
    expect((await readDeal(me, one.id)).stageId).toBe(s.secondStageId);
  });

  it('sets the status with its reason, closes and reopens, and leaves the deals already in it', async () => {
    const s = await dealScene(database);
    const me = (await s.member()).as();
    const one = await make(s, me, 'One');
    const won = await make(s, me, 'Won', { status: 'won', outcomeReason: 'Signed in May.' });
    const lost = await bulk(me, {
      action: 'set_status',
      ids: [one.id, won.id],
      status: 'lost',
      outcomeReason: 'Chose another supplier.',
    });
    expect(outcomes(lost)).toEqual(['done', 'done']);
    for (const id of [one.id, won.id])
      expect(await readDeal(me, id)).toMatchObject({
        status: 'lost',
        outcomeReason: 'Chose another supplier.',
      });
    expect((await readDeal(me, one.id)).closedAt).not.toBeNull();
    // Already lost: unchanged, and the reason each has stays.
    const again = await bulk(me, {
      action: 'set_status',
      ids: [one.id],
      status: 'lost',
      outcomeReason: 'Another reason.',
    });
    expect(outcomes(again)).toEqual(['unchanged']);
    expect((await readDeal(me, one.id)).outcomeReason).toBe('Chose another supplier.');
    const reopened = await bulk(me, { action: 'set_status', ids: [one.id], status: 'open' });
    expect(outcomes(reopened)).toEqual(['done']);
    expect(await readDeal(me, one.id)).toMatchObject({
      status: 'open',
      outcomeReason: null,
      closedAt: null,
    });
    expect(
      (await s.events('deal.'))
        .map((event) => event.type)
        .filter((type) => type !== 'deal.created'),
    ).toEqual(['deal.lost', 'deal.lost', 'deal.reopened']);
    // Lost needs a reason, and open takes none.
    expect(
      bulkDealsInput.safeParse({ action: 'set_status', ids: [one.id], status: 'lost' }).success,
    ).toBe(false);
    expect(
      bulkDealsInput.safeParse({
        action: 'set_status',
        ids: [one.id],
        status: 'open',
        outcomeReason: 'Why',
      }).success,
    ).toBe(false);
  });

  it('moves deals to the trash, where they can be restored one by one, and takes no other change of a deal there', async () => {
    const s = await dealScene(database);
    const me = (await s.member()).as();
    const one = await make(s, me, 'One');
    const two = await make(s, me, 'Two');
    const trashed = await bulk(me, { action: 'trash', ids: [one.id, two.id] });
    expect(outcomes(trashed)).toEqual(['done', 'done']);
    expect((await readDeal(me, one.id)).trashedAt).not.toBeNull();
    expect(outcomes(await bulk(me, { action: 'trash', ids: [one.id] }))).toEqual(['unchanged']);
    // Every other action skips a deal in the trash, with the reason, and changes the rest.
    const three = await make(s, me, 'Three');
    const result = await bulk(me, {
      action: 'set_status',
      ids: [one.id, three.id],
      status: 'won',
    });
    expect(result.results).toEqual([
      {
        id: one.id,
        outcome: 'skipped',
        reason: expect.objectContaining({ code: 'in_trash' }) as unknown,
      },
      { id: three.id, outcome: 'done', reason: null },
    ]);
    expect((await readDeal(me, one.id)).status).toBe('open');
    await call('restoreDeal', me, { id: one.id });
    expect((await readDeal(me, one.id)).trashedAt).toBeNull();
    expect((await s.events('deal.trashed')).length).toBe(2);
  });

  it('skips a deal of another business, or one that does not exist, tells nothing of it, and changes the rest', async () => {
    const s = await dealScene(database);
    const elsewhere = await dealScene(database);
    const me = (await s.member()).as();
    const them = (await elsewhere.member()).as();
    const mine = await make(s, me, 'Mine');
    const theirs = await make(elsewhere, them, 'Their secret deal');
    const missing = toPublicId('deal', parsePublicId('pipeline', s.pipelineId) ?? '');
    const notFound = expect.objectContaining({ code: 'not_found' }) as unknown;
    for (const body of [
      { action: 'trash' },
      { action: 'set_status', status: 'won' },
      { action: 'assign_owner', owner: 'me' },
      { action: 'move', pipelineId: s.pipelineId, stageId: s.secondStageId },
    ]) {
      const fresh = await make(s, me, 'Fresh');
      const result = await bulk(me, { ...body, ids: [theirs.id, fresh.id, missing] });
      expect(result.results).toEqual([
        { id: theirs.id, outcome: 'skipped', reason: notFound },
        { id: fresh.id, outcome: 'done', reason: null },
        { id: missing, outcome: 'skipped', reason: notFound },
      ]);
      // Word for word what an id that names nothing is answered with.
      expect(result.results[0]?.reason).toEqual(result.results[2]?.reason);
      expect(JSON.stringify(result)).not.toContain('secret');
    }
    expect(await readDeal(them, theirs.id)).toMatchObject({
      status: 'open',
      trashedAt: null,
      stageId: elsewhere.stageId,
      revision: theirs.revision,
    });
    expect(await ownerOf(them, theirs.id)).toBeNull();
    expect(await elsewhere.events('deal.')).toHaveLength(1);
    expect(await history(them)).toEqual([]);
    expect((await readDeal(me, mine.id)).status).toBe('open');
  });

  it('takes 1 to 100 deals, each once, and only the four actions', () => {
    const id = (n: number) =>
      toPublicId('deal', `01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, '0')}`);
    const many = Array.from({ length: DEAL_BULK_LIMIT + 1 }, (_, n) => id(n));
    const trash = (ids: string[]) => bulkDealsInput.safeParse({ action: 'trash', ids });
    expect(trash(many.slice(0, DEAL_BULK_LIMIT)).success).toBe(true);
    expect(trash(many).success).toBe(false);
    expect(trash([]).success).toBe(false);
    expect(trash([id(1), id(1)]).success).toBe(false);
    for (const action of ['delete', 'add_followers', 'set_value', 'restore'])
      expect(bulkDealsInput.safeParse({ action, ids: [id(1)] }).success).toBe(false);
    expect(bulkDealsInput.safeParse({ action: 'trash', ids: [id(1)], status: 'won' }).success).toBe(
      false,
    );
  });

  it('takes deals.manage: a viewer is refused, the refusal is audited, and nothing changes', async () => {
    const s = await dealScene(database);
    const dana = await s.member();
    const one = await make(s, dana.as(), 'One');
    const viewer = dana.as(new Set());
    for (const body of [
      { action: 'trash' },
      { action: 'set_status', status: 'won' },
      { action: 'assign_owner', owner: 'me' },
      { action: 'move', pipelineId: s.pipelineId, stageId: s.secondStageId },
    ]) {
      const refused = await failure(bulk(viewer, { ...body, ids: [one.id] }));
      expect(refused).toBeInstanceOf(ForbiddenError);
      expect((refused as ForbiddenError).permission).toBe('deals.manage');
    }
    expect(await readDeal(dana.as(), one.id)).toMatchObject({
      status: 'open',
      trashedAt: null,
      stageId: s.stageId,
      revision: one.revision,
    });
    // The list of bulk actions is read by anyone who can open the business, as deals are.
    expect(await history(viewer)).toEqual([]);
  });

  it('writes one audit row with the action and the ids and no reason, and one entry in the list of bulk actions', async () => {
    const s = await dealScene(database);
    const dana = await s.member('Dana Brooks');
    const lee = await s.member('Lee Park');
    const one = await make(s, dana.as(), 'One');
    const two = await make(s, dana.as(), 'Two');
    const missing = toPublicId('deal', parsePublicId('pipeline', s.pipelineId) ?? '');
    const first = await bulk(dana.as(), {
      action: 'set_status',
      ids: [one.id, two.id, missing],
      status: 'lost',
      outcomeReason: 'A private reason nobody else should read.',
    });
    const second = await bulk(lee.as(), { action: 'trash', ids: [one.id] });
    const audit = await database.as('crm_owner', (sql) =>
      sql.query<{ input: unknown; outcome: string }>(
        `select input, outcome from audit.commands
         where business_id = $1 and command = 'deal.bulk' order by recorded_at, id`,
        [s.businessId],
      ),
    );
    expect(audit).toEqual([
      { input: { action: 'set_status', ids: [one.id, two.id, missing] }, outcome: 'ok' },
      { input: { action: 'trash', ids: [one.id] }, outcome: 'ok' },
    ]);

    const listed = await history(dana.as());
    expect(listed).toMatchObject([
      {
        id: second.bulkActionId,
        action: 'trash',
        requested: 1,
        done: 1,
        unchanged: 0,
        skipped: 0,
        actor: { kind: 'user', name: 'Lee Park', you: false },
      },
      {
        id: first.bulkActionId,
        action: 'set_status',
        requested: 3,
        done: 2,
        unchanged: 0,
        skipped: 1,
        actor: { kind: 'user', name: 'Dana Brooks', you: true },
      },
    ]);
    for (const entry of listed)
      expect(Date.parse(entry.completedAt)).toBeGreaterThanOrEqual(Date.parse(entry.createdAt));
    // By action, and a page at a time.
    const page = dealBulkActionList.parse(
      await call('listDealBulkActions', dana.as(), { query: { limit: 1 } }),
    );
    expect(page.items.map((entry) => entry.id)).toEqual([second.bulkActionId]);
    expect(page.next).toBe(second.bulkActionId);
    const rest = dealBulkActionList.parse(
      await call('listDealBulkActions', dana.as(), { query: { limit: 1, after: page.next } }),
    );
    expect(rest.items.map((entry) => entry.id)).toEqual([first.bulkActionId]);
    expect(rest.next).toBeNull();
    const trashes = dealBulkActionList.parse(
      await call('listDealBulkActions', dana.as(), { query: { action: 'trash' } }),
    );
    expect(trashes.items.map((entry) => entry.id)).toEqual([second.bulkActionId]);
    // Another business lists none of them.
    const other = await dealScene(database);
    expect(await history((await other.member()).as())).toEqual([]);
  });

  it('makes each new owner a follower of the primary contact while that rule is on', async () => {
    const s = await dealScene(database);
    const dana = await s.member('Dana Brooks');
    const lee = await s.member('Lee Park');
    const maya = await s.contact('Maya');
    const one = await make(s, dana.as(), 'One', { primaryContactId: maya });
    const two = await make(s, dana.as(), 'Two', { primaryContactId: maya });
    const current = opportunitySettings.parse(await call('getOpportunitySettings', dana.as()));
    await call('updateOpportunitySettings', dana.as(), {
      body: {
        allowDifferentOwners: true,
        opportunityOwnerFollowsContact: true,
        contactOwnerFollowsOpportunity: false,
        revision: current.revision,
      },
    });
    await bulk(dana.as(), {
      action: 'assign_owner',
      ids: [one.id, two.id],
      owner: lee.membershipId,
    });
    const followers = contactDetails.parse(
      await call('getContactDetails', dana.as(), { id: maya }),
    ).followers;
    // Once, though two of the contact's deals changed hands.
    expect(followers.map((each) => each.name)).toEqual(['Lee Park']);
    expect(await s.events('contact.follower_added')).toHaveLength(1);
  });
});

describe('a bulk action at the same moment as another change', () => {
  /** Holds the first command that resolves a member inside its transaction until released. */
  function holdFirst(): { reached: Promise<void>; release: () => void } {
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
    return { reached: atResolve, release };
  }
  const letThrough = () => {
    gate.whenResolving = () => Promise.resolve();
  };

  it('changes each deal once when two people send the same bulk action together', async () => {
    const s = await dealScene(database);
    const dana = await s.member('Dana Brooks');
    const lee = await s.member('Lee Park');
    const deals = [];
    for (const name of ['One', 'Two', 'Three']) deals.push(await make(s, dana.as(), name));
    const body = {
      action: 'assign_owner',
      ids: deals.map((each) => each.id),
      owner: lee.membershipId,
    };
    const hold = holdFirst();
    let first: BulkDealsResult;
    let second: BulkDealsResult;
    try {
      // The first holds every deal while it resolves the member; the second, naming the
      // same deals in another order, is seen waiting for them.
      const one = bulk(dana.as(), body);
      await hold.reached;
      const two = bulk(lee.as(), { ...body, ids: [...body.ids].reverse() });
      await waitingForLock(database);
      hold.release();
      [first, second] = await Promise.all([one, two]);
    } finally {
      hold.release();
      letThrough();
    }
    expect(first).toMatchObject({ done: 3, unchanged: 0 });
    expect(second).toMatchObject({ done: 0, unchanged: 3, bulkActionId: null });
    expect(await s.events('deal.owner')).toHaveLength(3);
    expect(await history(dana.as())).toHaveLength(1);
  });

  it('comes after a single change that holds one of its deals, and both are kept in that order', async () => {
    const s = await dealScene(database);
    const dana = await s.member('Dana Brooks');
    const lee = await s.member('Lee Park');
    const one = await make(s, dana.as(), 'One');
    const two = await make(s, dana.as(), 'Two');
    const { ownerRevision } = dealDetails.parse(
      await call('getDealDetails', dana.as(), { id: one.id }),
    );
    const hold = holdFirst();
    let result: BulkDealsResult;
    try {
      // Dana gives the first deal to herself; her change holds its row.
      const single = call('assignDealOwner', dana.as(), {
        id: one.id,
        body: { owner: 'me', revision: ownerRevision },
      });
      await hold.reached;
      // The bulk action trashes both deals: it is seen waiting for the first.
      const many = bulk(lee.as(), { action: 'trash', ids: [one.id, two.id] });
      await waitingForLock(database);
      hold.release();
      await single;
      result = await many;
    } finally {
      hold.release();
      letThrough();
    }
    expect(outcomes(result)).toEqual(['done', 'done']);
    // Both happened, the single change first: the deal is Dana's, and in the trash.
    expect(await ownerOf(dana.as(), one.id)).toBe('Dana Brooks');
    expect((await readDeal(dana.as(), one.id)).trashedAt).not.toBeNull();
    const order = (await s.events('deal.'))
      .map((event) => event.type)
      .filter((type) => type !== 'deal.created');
    expect(order).toEqual(['deal.owner_assigned', 'deal.trashed', 'deal.trashed']);
  });
});
