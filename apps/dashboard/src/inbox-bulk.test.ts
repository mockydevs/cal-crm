import {
  bulkConversationsInput,
  CONVERSATION_BULK_LIMIT,
  type BulkConversationsResult,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { conversationId, conversationOf, messageId } from '../e2e/inbox-fixtures';
import { bulkPlanOf, bulkTallyOf } from './inbox-bulk';

const last = conversationOf().lastMessage;
if (last === null) throw new Error('The fixture has a last message.');
const withMessage = (id: string, message: string) =>
  conversationOf({ id: conversationId(id), lastMessage: { ...last, id: messageId(message) } });

describe('bulkPlanOf', () => {
  it('names each conversation for star, unstar and mark unread', () => {
    const chosen = [withMessage('1', '1'), withMessage('2', '2')];
    for (const action of ['star', 'unstar', 'mark_unread'] as const) {
      const plan = bulkPlanOf(action, chosen);
      expect(plan).toEqual({
        bodies: [{ action, ids: [conversationId('1'), conversationId('2')] }],
        left: 0,
      });
      expect(bulkConversationsInput.safeParse(plan.bodies[0]).success).toBe(true);
    }
  });

  it('marks read up to the newest message each row showed', () => {
    const plan = bulkPlanOf('mark_read', [withMessage('1', '5'), withMessage('2', '6')]);
    expect(plan).toEqual({
      bodies: [
        {
          action: 'mark_read',
          items: [
            { id: conversationId('1'), through: messageId('5') },
            { id: conversationId('2'), through: messageId('6') },
          ],
        },
      ],
      left: 0,
    });
    expect(bulkConversationsInput.safeParse(plan.bodies[0]).success).toBe(true);
  });

  it('leaves out of mark read a conversation with no message to read up to', () => {
    const plan = bulkPlanOf('mark_read', [
      conversationOf({ id: conversationId('1'), lastMessage: null }),
      // An older server names no message on the row.
      conversationOf({ id: conversationId('2') }),
      withMessage('3', '7'),
    ]);
    expect(plan.left).toBe(2);
    expect(plan.bodies).toEqual([
      { action: 'mark_read', items: [{ id: conversationId('3'), through: messageId('7') }] },
    ]);
    expect(bulkPlanOf('mark_read', [conversationOf({ lastMessage: null })])).toEqual({
      bodies: [],
      left: 1,
    });
  });

  it('asks in requests of at most what the server takes at once', () => {
    const digits = '0123456789abcdefghjkmnpqrstvwxyz';
    const many = Array.from({ length: CONVERSATION_BULK_LIMIT + 5 }, (_, index) =>
      conversationOf({
        id: `cvn_01k8e2wzr0e0080000000000${digits.charAt(Math.floor(index / 32))}${digits.charAt(index % 32)}`,
      }),
    );
    const plan = bulkPlanOf('star', many);
    expect(plan.bodies).toHaveLength(2);
    expect(plan.bodies.map((body) => ('ids' in body ? body.ids.length : 0))).toEqual([
      CONVERSATION_BULK_LIMIT,
      5,
    ]);
    for (const body of plan.bodies)
      expect(bulkConversationsInput.safeParse(body).success).toBe(true);
  });
});

describe('bulkTallyOf', () => {
  const answer = (
    results: BulkConversationsResult['results'],
    action: BulkConversationsResult['action'] = 'mark_unread',
  ): BulkConversationsResult => ({
    action,
    results,
    done: results.filter((each) => each.outcome === 'done').length,
    unchanged: results.filter((each) => each.outcome === 'unchanged').length,
    skipped: results.filter((each) => each.outcome === 'skipped').length,
  });

  it('counts what is now as asked, and what was skipped with why the first one was', () => {
    const tally = bulkTallyOf(
      [
        answer([
          { id: conversationId('1'), outcome: 'done', reason: null },
          { id: conversationId('2'), outcome: 'unchanged', reason: null },
        ]),
        answer([
          {
            id: conversationId('3'),
            outcome: 'skipped',
            reason: {
              code: 'nothing_to_mark_unread',
              message: 'The contact has not written in this conversation.',
            },
          },
        ]),
      ],
      0,
    );
    expect(tally).toEqual({ changed: 2, skipped: 1, reason: 'nothing_to_mark_unread' });
  });

  it('counts what was never asked as skipped, with no reason of the server', () => {
    expect(bulkTallyOf([], 2)).toEqual({ changed: 0, skipped: 2, reason: null });
    expect(
      bulkTallyOf([answer([{ id: conversationId('1'), outcome: 'done', reason: null }])], 1),
    ).toEqual({ changed: 1, skipped: 1, reason: null });
  });
});
