// What the opportunity dialog shows beside the form: the deal's audit log and timeline
// through the readers every record has, and a deal moved to another pipeline from the form.
// Against a migrated Postgres as crm_app under row-level security.
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { auditLog, deal, dealDetails, recordActivity, type Deal } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ForbiddenError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions } from '../../test/contact-details.js';
import { dealScene, type DealScene } from '../../test/deal-people.js';
import { activityRoutes } from '../activity/routes.js';
import { dealPeopleRoutes } from './people-routes.js';
import { createDealRoutes } from './routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const options = detailOptions();
const routes = [
  ...dealPeopleRoutes(options),
  ...createDealRoutes(options),
  ...activityRoutes({ actorNames: options.actorNames }),
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
const create = async (s: DealScene, invocation: Invocation, more: object = {}): Promise<Deal> =>
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
const failure = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );

describe("a deal's audit log and timeline", () => {
  it('list the commands that changed who it is with and whose it is, by who ran them, and give out no user id', async () => {
    const s = await dealScene(database);
    const dana = await s.member('Dana Brooks');
    const lee = await s.member('Lee Park');
    const maya = await s.contact('Maya');
    const made = await create(s, dana.as());
    const opened = dealDetails.parse(await call('getDealDetails', dana.as(), { id: made.id }));
    await call('setDealContacts', dana.as(), {
      id: made.id,
      body: {
        primaryContactId: maya,
        additionalContactIds: [],
        revision: opened.contactsRevision,
      },
    });
    await call('assignDealOwner', lee.as(), {
      id: made.id,
      body: { owner: 'me', revision: opened.ownerRevision },
    });
    await call('addDealFollowers', dana.as(), { id: made.id, body: { followers: ['me'] } });
    await call('removeDealFollowers', dana.as(), { id: made.id, body: { followers: ['me'] } });

    // The audit log id the dialog's footer shows is the deal's own id.
    const log = auditLog.parse(await call('listRecordAudit', dana.as(), { id: made.id }));
    expect(log.items.map((entry) => [entry.command, entry.actor.name, entry.outcome])).toEqual([
      ['deal.remove_followers', 'Dana Brooks', 'ok'],
      ['deal.add_followers', 'Dana Brooks', 'ok'],
      ['deal.assign_owner', 'Lee Park', 'ok'],
      ['deal.set_contacts', 'Dana Brooks', 'ok'],
      ['deal.create', 'Dana Brooks', 'ok'],
    ]);
    expect(log.items.map((entry) => entry.events.map((event) => event.type))).toEqual([
      ['deal.follower_removed'],
      ['deal.follower_added'],
      ['deal.owner_assigned'],
      ['deal.contact_linked'],
      ['deal.created'],
    ]);
    // Nothing of a command's input is shown for these.
    expect(log.items.map((entry) => entry.detail)).toEqual([{}, {}, {}, {}, {}]);
    // The link is a change to the contact too, and is in its log.
    const ofContact = auditLog.parse(await call('listRecordAudit', dana.as(), { id: maya }));
    expect(ofContact.items.map((entry) => entry.command)).toContain('deal.set_contacts');

    const timeline = recordActivity.parse(
      await call('listRecordActivity', dana.as(), { id: made.id }),
    );
    expect(timeline.items.map((entry) => [entry.type, entry.payload])).toEqual(
      expect.arrayContaining([
        ['deal.follower_removed', {}],
        ['deal.follower_added', {}],
        ['deal.owner_assigned', {}],
        ['deal.contact_linked', { contactId: maya, primary: true }],
      ]),
    );
    for (const text of [JSON.stringify(log), JSON.stringify(timeline)])
      for (const userId of [dana.userId, lee.userId]) expect(text).not.toContain(userId);
  });

  it('is read with audit.read only, as the details say', async () => {
    const s = await dealScene(database);
    const dana = await s.member();
    const made = await create(s, dana.as());
    const member = dana.as(new Set(['deals.manage']));
    expect(
      dealDetails.parse(await call('getDealDetails', member, { id: made.id })).canReadAudit,
    ).toBe(false);
    const refused = await failure(call('listRecordAudit', member, { id: made.id }));
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect((refused as ForbiddenError).permission).toBe('audit.read');
  });
});

describe('a deal moved to another pipeline from the form', () => {
  const twoPipelines = async () => {
    const s = await dealScene(database);
    const me = (await s.member()).as();
    const other = await database.withTenant(s.context, async (sql) => {
      const pipeline = await sql.one<{ id: string }>(
        "insert into crm.pipelines (business_id, name, position) values ($1, 'Support', 1) returning id",
        [s.businessId],
      );
      const stage = await sql.one<{ id: string }>(
        `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
         values ($1, $2, 'Open', 0) returning id`,
        [s.businessId, pipeline.id],
      );
      return { pipeline: pipeline.id, stage: stage.id };
    });
    return {
      s,
      me,
      pipelineId: toPublicId('pipeline', other.pipeline),
      stageId: toPublicId('stage', other.stage),
    };
  };
  const edit = (invocation: Invocation, current: Deal, more: object) =>
    call('updateDeal', invocation, {
      id: current.id,
      body: {
        name: current.name,
        pipelineId: current.pipelineId,
        stageId: current.stageId,
        currency: current.currency,
        revision: current.revision,
        ...more,
      },
    }).then((answer) => deal.parse(answer));

  it('takes the stage of that pipeline, closes its time in the old stage, and says where it came from', async () => {
    const { s, me, pipelineId, stageId } = await twoPipelines();
    const maya = await s.contact('Maya');
    const made = await create(s, me, { primaryContactId: maya, amount: '120' });
    const moved = await edit(me, made, { pipelineId, stageId, amount: '120' });
    expect(moved).toMatchObject({
      pipelineId,
      stageId,
      pipelineName: 'Support',
      stageName: 'Open',
      amount: '120.0000',
    });
    expect(Date.parse(moved.stageEnteredAt)).toBeGreaterThan(Date.parse(made.stageEnteredAt));
    const history = await database.as('crm_owner', (sql) =>
      sql.query<{ pipeline_id: string; open: boolean }>(
        `select pipeline_id, exited_at is null as open from crm.deal_stage_history
         where deal_id = $1 order by entered_at`,
        [parsePublicId('deal', made.id)],
      ),
    );
    expect(history).toEqual([
      { pipeline_id: parsePublicId('pipeline', s.pipelineId), open: false },
      { pipeline_id: parsePublicId('pipeline', pipelineId), open: true },
    ]);
    expect(await s.events('deal.stage_changed')).toEqual([
      {
        type: 'deal.stage_changed',
        payload: {
          fromPipelineId: s.pipelineId,
          fromStageId: s.stageId,
          pipelineId,
          stageId,
        },
      },
    ]);
    // Who it is with and whose it is go with it.
    const details = dealDetails.parse(await call('getDealDetails', me, { id: made.id }));
    expect(details.primaryContact?.id).toBe(maya);
  });

  it('is refused with a stage of another pipeline than the one named, and stays where it was', async () => {
    const { s, me, pipelineId, stageId } = await twoPipelines();
    const made = await create(s, me);
    for (const wrong of [
      { pipelineId, stageId: s.stageId },
      { pipelineId: s.pipelineId, stageId },
    ]) {
      const refused = await failure(edit(me, made, wrong));
      expect(refused).toBeInstanceOf(ValidationError);
      expect((refused as ValidationError).issues).toEqual([
        expect.objectContaining({ path: '/stageId', code: 'unavailable' }),
      ]);
    }
    const now = deal.parse(await call('getDeal', me, { id: made.id }));
    expect(now).toMatchObject({ pipelineId: s.pipelineId, stageId: s.stageId });
    expect(now.revision).toBe(made.revision);
    expect(await s.events('deal.stage_changed')).toEqual([]);
  });
});
