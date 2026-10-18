import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { endpoints } from './api.js';
import {
  BULK_ACTION_PAGE_SIZE,
  bulkDealsInput,
  bulkDealsResult,
  DEAL_BULK_LIMIT,
  dealBulkActionList,
  dealBulkActionsQuery,
  dealBulkEndpoints,
} from './deal-bulk.js';

const uuid = (n: number) => `01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, '0')}`;
const deal = (n: number) => toPublicId('deal', uuid(n));
const ids = [deal(1), deal(2)];

describe('a bulk action on deals', () => {
  it('takes 1 to 100 deals, each once', () => {
    const many = Array.from({ length: DEAL_BULK_LIMIT + 1 }, (_, n) => deal(n));
    const trash = (named: string[]) => bulkDealsInput.safeParse({ action: 'trash', ids: named });
    expect(trash(many.slice(0, DEAL_BULK_LIMIT)).success).toBe(true);
    expect(trash(many).success).toBe(false);
    expect(trash([]).success).toBe(false);
    expect(trash([deal(1), deal(1)]).success).toBe(false);
    expect(trash([toPublicId('contact', uuid(1))]).success).toBe(false);
  });

  it('is one of four actions, each with what it needs and nothing else', () => {
    const pipelineId = toPublicId('pipeline', uuid(3));
    const stageId = toPublicId('stage', uuid(4));
    const membership = toPublicId('membership', uuid(5));
    for (const valid of [
      { action: 'assign_owner', ids, owner: membership },
      { action: 'assign_owner', ids, owner: 'me' },
      { action: 'assign_owner', ids, owner: null },
      { action: 'move', ids, pipelineId, stageId },
      { action: 'set_status', ids, status: 'open' },
      { action: 'set_status', ids, status: 'won' },
      { action: 'set_status', ids, status: 'won', outcomeReason: 'Signed.' },
      { action: 'set_status', ids, status: 'lost', outcomeReason: 'Budget.' },
      { action: 'trash', ids },
    ])
      expect(bulkDealsInput.safeParse(valid).success, JSON.stringify(valid)).toBe(true);
    for (const wrong of [
      { action: 'assign_owner', ids },
      { action: 'assign_owner', ids, owner: 'someone' },
      { action: 'move', ids, pipelineId },
      { action: 'move', ids, pipelineId: stageId, stageId },
      { action: 'set_status', ids, status: 'abandoned' },
      { action: 'set_status', ids, status: 'lost' },
      { action: 'set_status', ids, status: 'open', outcomeReason: 'Why' },
      { action: 'trash', ids, owner: 'me' },
      { action: 'delete', ids },
      { action: 'add_followers', ids, followers: ['me'] },
      { ids },
    ])
      expect(bulkDealsInput.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    expect(bulkDealsInput.parse({ action: 'set_status', ids, status: 'won' })).toMatchObject({
      outcomeReason: null,
    });
  });

  it('answers what became of each deal, and where the action is listed', () => {
    const answer = {
      action: 'trash',
      results: [
        { id: deal(1), outcome: 'done', reason: null },
        { id: deal(2), outcome: 'skipped', reason: { code: 'not_found', message: 'Not found.' } },
      ],
      done: 1,
      unchanged: 0,
      skipped: 1,
      bulkActionId: toPublicId('bulk_action', uuid(9)),
    };
    expect(bulkDealsResult.parse(answer).results).toHaveLength(2);
    expect(bulkDealsResult.parse({ ...answer, bulkActionId: null }).bulkActionId).toBeNull();
    expect(
      bulkDealsResult.safeParse({
        ...answer,
        results: [{ id: deal(1), outcome: 'failed', reason: null }],
      }).success,
    ).toBe(false);
  });

  it('is listed a page at a time, newest first, by action when asked', () => {
    expect(dealBulkActionsQuery.parse({})).toEqual({ limit: BULK_ACTION_PAGE_SIZE });
    expect(dealBulkActionsQuery.parse({ limit: '100', action: 'move' })).toEqual({
      limit: 100,
      action: 'move',
    });
    for (const wrong of [{ limit: 0 }, { limit: 101 }, { action: 'delete' }, { after: deal(1) }])
      expect(dealBulkActionsQuery.safeParse(wrong).success).toBe(false);
    const entry = {
      id: toPublicId('bulk_action', uuid(9)),
      action: 'set_status',
      requested: 3,
      done: 2,
      unchanged: 0,
      skipped: 1,
      actor: { kind: 'user', name: 'Dana Brooks', you: true },
      createdAt: '2026-10-11T00:00:00.000Z',
      completedAt: '2026-10-11T00:00:00.100Z',
    };
    expect(dealBulkActionList.parse({ items: [entry], next: null }).items).toHaveLength(1);
    expect(
      dealBulkActionList.safeParse({ items: [{ ...entry, requested: 0 }], next: null }).success,
    ).toBe(false);
  });

  it('is registered: two operations, each once', () => {
    const registered = endpoints.map((endpoint) => endpoint.operationId);
    for (const endpoint of dealBulkEndpoints)
      expect(registered.filter((id) => id === endpoint.operationId)).toHaveLength(1);
  });
});
