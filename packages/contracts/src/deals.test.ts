import { describe, expect, it } from 'vitest';
import { toPublicId } from '@repo/kernel';
import { createDealInput, updateDealInput, dealListQuery } from './deals.js';

const id = '01890a5d-ac96-774b-bcce-b302099a8057';
const input = {
  name: 'Wedding reception',
  pipelineId: toPublicId('pipeline', id),
  stageId: toPublicId('stage', id),
  amount: '12500.1234',
  currency: 'KES',
  expectedCloseDate: '2026-12-01',
  status: 'open',
  outcomeReason: null,
};
describe('deal inputs', () => {
  it('keeps money as a decimal string and defaults an outcome to open', () => {
    expect(createDealInput.parse(input)).toEqual(input);
    expect(createDealInput.parse({ ...input, status: undefined }).status).toBe('open');
  });
  it.each([12500, '-1', '0.00001', '1000000000000000', '1e3', 'Infinity'])(
    'refuses an invalid amount: %s',
    (amount) => {
      expect(createDealInput.safeParse({ ...input, amount }).success).toBe(false);
    },
  );
  it('requires a reason for lost deals and allows a reason for won deals', () => {
    expect(createDealInput.safeParse({ ...input, status: 'lost' }).success).toBe(false);
    expect(
      createDealInput.parse({ ...input, status: 'lost', outcomeReason: 'Budget reduced.' })
        .outcomeReason,
    ).toBe('Budget reduced.');
    expect(
      createDealInput.parse({ ...input, status: 'won', outcomeReason: 'Signed contract.' }).status,
    ).toBe('won');
    expect(createDealInput.safeParse({ ...input, outcomeReason: 'Still open.' }).success).toBe(
      false,
    );
  });
  it('refuses an invalid currency, calendar date, ID kind or unexpected field', () => {
    for (const changes of [
      { currency: 'ZZZ' },
      { expectedCloseDate: '2026-02-30' },
      { stageId: toPublicId('contact', id) },
      { closedAt: '2026-10-01' },
    ])
      expect(createDealInput.safeParse({ ...input, ...changes }).success).toBe(false);
  });
  it('requires the stored revision when editing', () => {
    expect(updateDealInput.safeParse(input).success).toBe(false);
    expect(updateDealInput.parse({ ...input, revision: 'a'.repeat(64) }).revision).toHaveLength(64);
  });
  it('bounds list pages and validates cursors', () => {
    expect(dealListQuery.parse({})).toMatchObject({ status: 'open', limit: 100 });
    expect(dealListQuery.safeParse({ limit: '201' }).success).toBe(false);
    expect(dealListQuery.safeParse({ after: toPublicId('contact', id) }).success).toBe(false);
  });
});
