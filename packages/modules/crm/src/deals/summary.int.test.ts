// A deal's source, one column of the board paged by itself, and the count and total each
// column's header shows, against a migrated Postgres as crm_app under row-level security.
import type { Invocation } from '@repo/commands';
import {
  deal,
  dealList,
  dealStageSummary,
  type Deal,
  type DealStageSummary,
} from '@repo/contracts';
import { ConflictError, parsePublicId, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { lists, type World } from '../../test/lists-boards.js';

let world: World;
beforeAll(async () => {
  world = await lists(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

interface Board {
  readonly me: Invocation;
  readonly pipelineId: string;
  readonly stageIds: readonly string[];
}
async function board(stages: readonly string[] = ['New', 'Quoted', 'Booked']): Promise<Board> {
  const me = await world.inBusiness();
  return { me, ...(await world.pipeline(me, stages)) };
}
const create = async ({ me, pipelineId, stageIds }: Board, values: object = {}) =>
  deal.parse(
    await world.call('createDeal', me, {
      body: { name: 'Roof repair', pipelineId, stageId: stageIds[0], currency: 'KES', ...values },
    }),
  );
const update = async (me: Invocation, current: Deal, changes: object) =>
  deal.parse(
    await world.call('updateDeal', me, {
      params: { id: current.id },
      body: {
        name: current.name,
        pipelineId: current.pipelineId,
        stageId: current.stageId,
        status: current.status,
        amount: current.amount,
        currency: current.currency,
        expectedCloseDate: current.expectedCloseDate,
        outcomeReason: current.outcomeReason,
        revision: current.revision,
        ...changes,
      },
    }),
  );
const summary = async (me: Invocation, query: Record<string, string>) =>
  dealStageSummary.parse(await world.call('getDealStageSummary', me, { query }));
/** Every card of a list, paged a few at a time, following next. */
async function everyCard(me: Invocation, query: Record<string, string>): Promise<Deal[]> {
  const cards: Deal[] = [];
  let after: string | null = null;
  do {
    const page = dealList.parse(
      await world.call('getDeals', me, {
        query: { ...query, limit: '2', ...(after === null ? {} : { after }) },
      }),
    );
    cards.push(...page.items);
    after = page.next;
  } while (after !== null);
  return cards;
}
/** Amounts added exactly, as ten-thousandths, and shown as the summary shows a total. */
function totalsOf(cards: readonly Deal[]): DealStageSummary['totals'] {
  const sums = new Map<string, bigint>();
  for (const card of cards) {
    const [whole = '0', part = ''] = (card.amount ?? '0').split('.');
    sums.set(
      card.currency,
      (sums.get(card.currency) ?? 0n) + BigInt(whole) * 10_000n + BigInt(part.padEnd(4, '0')),
    );
  }
  return [...sums]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, sum]) => ({
      currency,
      amount: `${String(sum / 10_000n)}.${String(sum % 10_000n).padStart(4, '0')}`,
    }));
}

describe("a deal's source", () => {
  it('is empty unless given, is trimmed, and stays through an edit that leaves it out', async () => {
    const place = await board();
    const plain = await create(place);
    expect(plain.source).toBeNull();
    const fromForm = await create(place, { source: '  Website form ' });
    expect(fromForm.source).toBe('Website form');

    // A screen that does not show the source saves the deal without it: it stays.
    const renamed = await update(place.me, fromForm, { name: 'Roof replacement' });
    expect(renamed).toMatchObject({ name: 'Roof replacement', source: 'Website form' });
    const changed = await update(place.me, renamed, { source: 'Referral' });
    expect(changed.source).toBe('Referral');
    expect(changed.revision).not.toBe(renamed.revision);
    const cleared = await update(place.me, changed, { source: null });
    expect(cleared.source).toBeNull();
    expect(
      deal.parse(await world.call('getDeal', place.me, { params: { id: cleared.id } })),
    ).toEqual(cleared);
    // The event says what the edit set, for automations and the timeline.
    const [event] = await world.database.as('crm_owner', (sql) =>
      sql.query<{ source: string | null }>(
        `select payload->>'source' as source from events.events
         where subject_id = $1 and type = 'deal.updated' and payload ? 'source'
         order by id limit 1`,
        [parsePublicId('deal', changed.id)],
      ),
    );
    expect(event).toEqual({ source: 'Referral' });
  });

  it.each([[''], ['   '], ['x'.repeat(201)], [7]])('refuses %j', async (source) => {
    const place = await board();
    await expect(create(place, { source })).rejects.toBeInstanceOf(ValidationError);
    const saved = await create(place, { source: 'Event' });
    await expect(update(place.me, saved, { source })).rejects.toBeInstanceOf(ValidationError);
  });

  it('holds 200 characters, and a stale edit of it is refused like any other', async () => {
    const place = await board();
    const saved = await create(place, { source: 'x'.repeat(200) });
    expect(saved.source).toHaveLength(200);
    const first = await update(place.me, saved, { source: 'Referral' });
    await expect(update(place.me, saved, { source: 'Event' })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(deal.parse(await world.call('getDeal', place.me, { params: { id: saved.id } }))).toEqual(
      first,
    );
  });
});

describe("the board's column headers", () => {
  it('count each stage and add its amounts by currency, exactly, leaving out the trash', async () => {
    const place = await board(['New', 'Quoted', 'Booked']);
    const [first, second] = place.stageIds;
    await create(place, { amount: '0.0001' });
    await create(place, { amount: '0.0002' });
    await create(place, { amount: '123456789012345.1234' });
    await create(place, { amount: '10', currency: 'USD' });
    // No amount: counted, and adds nothing.
    await create(place, { amount: null });
    await create(place, { stageId: second, amount: '2500.5' });
    const trashed = await create(place, { stageId: second, amount: '999' });
    await world.call('trashDeal', place.me, { params: { id: trashed.id } });
    // Another pipeline's deals are another board's.
    const elsewhere = await world.pipeline(place.me, ['Other']);
    await create({ ...place, ...elsewhere }, { amount: '777' });

    expect(await summary(place.me, { pipelineId: place.pipelineId })).toEqual({
      pipelineId: place.pipelineId,
      count: 6,
      totals: [
        { currency: 'KES', amount: '123456789014845.6237' },
        { currency: 'USD', amount: '10.0000' },
      ],
      stages: [
        {
          stageId: first,
          name: 'New',
          archived: false,
          count: 5,
          totals: [
            { currency: 'KES', amount: '123456789012345.1237' },
            { currency: 'USD', amount: '10.0000' },
          ],
        },
        {
          stageId: second,
          name: 'Quoted',
          archived: false,
          count: 1,
          totals: [{ currency: 'KES', amount: '2500.5000' }],
        },
        // An empty stage is still a column, with nothing in it.
        { stageId: place.stageIds[2], name: 'Booked', archived: false, count: 0, totals: [] },
      ],
    });
  });

  it('show open deals unless told otherwise, as the board does', async () => {
    const place = await board(['New', 'Quoted']);
    await create(place, { amount: '100' });
    await create(place, { amount: '200', status: 'won' });
    await create(place, { amount: '400', status: 'lost', outcomeReason: 'Price' });
    const counts = async (status?: string) => {
      const answer = await summary(place.me, {
        pipelineId: place.pipelineId,
        ...(status === undefined ? {} : { status }),
      });
      return [answer.count, answer.totals[0]?.amount];
    };
    expect(await counts()).toEqual([1, '100.0000']);
    expect(await counts('open')).toEqual([1, '100.0000']);
    expect(await counts('won')).toEqual([1, '200.0000']);
    expect(await counts('lost')).toEqual([1, '400.0000']);
    expect(await counts('all')).toEqual([3, '700.0000']);
  });

  it('list an archived stage only while a deal the filters keep is still in it', async () => {
    const place = await board(['New', 'Old', 'Gone']);
    const stuck = await create(place, { stageId: place.stageIds[1], amount: '50' });
    await world.database.withTenant(place.me.context, (sql) =>
      sql.query(`update crm.pipeline_stages set archived_at = now() where name in ('Old', 'Gone')`),
    );
    const names = async (status: string) =>
      (await summary(place.me, { pipelineId: place.pipelineId, status })).stages.map(
        (stage) => [stage.name, stage.archived, stage.count] as const,
      );
    expect(await names('open')).toEqual([
      ['New', false, 0],
      ['Old', true, 1],
    ]);
    // Won, the deal is out of the open board, and so is its archived column.
    await update(place.me, stuck, { status: 'won' });
    expect(await names('open')).toEqual([['New', false, 0]]);
    expect(await names('won')).toEqual([
      ['New', false, 0],
      ['Old', true, 1],
    ]);
  });

  it("agree with every column's own pages, whatever the filters", async () => {
    const place = await board(['New', 'Quoted', 'Booked']);
    const field = (await world.call('createField', place.me, {
      body: {
        objectKey: 'deal',
        key: 'guests',
        label: 'Guests',
        description: 'How many people are expected.',
        valueType: 'number',
        currency: null,
        options: [],
        aiFillSources: [],
        aiOverwrite: 'ask',
        archived: false,
      },
    })) as { id: string };
    // Fifteen deals over three stages, three statuses and two currencies; some have guests.
    for (let index = 0; index < 15; index += 1) {
      const status = (['open', 'open', 'won', 'lost'] as const)[index % 4] ?? 'open';
      const made = await create(place, {
        stageId: place.stageIds[index % 3],
        amount: index % 5 === 0 ? null : `${String(index * 37)}.${String(index).padStart(2, '0')}`,
        currency: index % 4 === 0 ? 'USD' : 'KES',
        status,
        outcomeReason: status === 'lost' ? 'Price' : null,
      });
      if (index % 2 === 0)
        await world.database.withTenant(place.me.context, (sql) =>
          sql.query(
            `insert into crm.field_values
               (business_id, record_id, field_id, value_type, value_number, source_kind)
             values (app.business_id(), $1, $2, 'number', $3, 'user')`,
            [parsePublicId('deal', made.id), parsePublicId('field', field.id), index * 10],
          ),
        );
    }
    const trashed = (await everyCard(place.me, { pipelineId: place.pipelineId }))[0];
    await world.call('trashDeal', place.me, { params: { id: trashed?.id ?? '' } });

    let cardsSeen = 0;
    for (const filters of [
      {},
      { status: 'all' },
      { status: 'won' },
      { status: 'lost' },
      { status: 'all', fieldId: field.id, fieldOperator: 'is_set' },
      { status: 'all', fieldId: field.id, fieldOperator: 'gte', fieldValue: '60' },
      { status: 'open', fieldId: field.id, fieldOperator: 'is_unset' },
    ] as Record<string, string>[]) {
      const query = { pipelineId: place.pipelineId, ...filters };
      const headers = await summary(place.me, query);
      const whole: Deal[] = [];
      for (const header of headers.stages) {
        const cards = await everyCard(place.me, { ...query, stageId: header.stageId });
        expect([header.count, header.totals], JSON.stringify(filters)).toEqual([
          cards.length,
          totalsOf(cards),
        ]);
        whole.push(...cards);
      }
      expect([headers.count, headers.totals]).toEqual([whole.length, totalsOf(whole)]);
      // The columns together are the pipeline's list under the same filters, card for card.
      expect(whole.map((card) => card.id).sort()).toEqual(
        (await everyCard(place.me, query)).map((card) => card.id).sort(),
      );
      cardsSeen += whole.length;
    }
    // The agreement above is about real cards, not about empty boards.
    expect(cardsSeen).toBeGreaterThan(30);
  });

  it("refuse another business's pipeline, and page nothing from another business's stage", async () => {
    const mine = await board();
    const theirs = await board();
    await create(theirs, { amount: '5000' });
    const refusal = world.call('getDealStageSummary', mine.me, {
      query: { pipelineId: theirs.pipelineId },
    });
    await expect(refusal).rejects.toBeInstanceOf(ValidationError);
    await expect(refusal).rejects.toMatchObject({
      issues: [{ path: '/pipelineId', code: 'unknown_pipeline' }],
    });
    expect(
      await everyCard(mine.me, {
        pipelineId: theirs.pipelineId,
        stageId: theirs.stageIds[0] ?? '',
      }),
    ).toEqual([]);
    // A stage of another pipeline of the same business is not this pipeline's column.
    const other = await world.pipeline(mine.me, ['Elsewhere']);
    await create({ ...mine, ...other });
    expect(
      await everyCard(mine.me, { pipelineId: mine.pipelineId, stageId: other.stageIds[0] ?? '' }),
    ).toEqual([]);
  });

  it('need a pipeline, and are open to someone who may only look', async () => {
    const place = await board();
    await create(place, { amount: '100' });
    await expect(world.call('getDealStageSummary', place.me, { query: {} })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      summary(place.me, { pipelineId: place.pipelineId, limit: '5' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const viewer: Invocation = { ...place.me, permissions: new Set() };
    expect((await summary(viewer, { pipelineId: place.pipelineId })).count).toBe(1);
  });
});
