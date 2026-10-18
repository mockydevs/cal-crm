// Which deal a deal.move or deal.close step acts on for a contact, and what it sends the
// CRM's update command. The rule is exact: one open deal, or the step fails.
import { expect, it } from 'vitest';

import { amountFromField, chooseDeal, dealUpdate, type DealValues } from './actions-deal-choice.js';

const BUDGET = 'contact.custom.budget';

it('takes the amount of a deal from the number its field holds, exact to four places', () => {
  expect(amountFromField(BUDGET, 1500)).toEqual({ amount: '1500' });
  expect(amountFromField(BUDGET, 0)).toEqual({ amount: '0' });
  expect(amountFromField(BUDGET, 100)).toEqual({ amount: '100' });
  expect(amountFromField(BUDGET, 1500.5)).toEqual({ amount: '1500.5' });
  expect(amountFromField(BUDGET, 12.34)).toEqual({ amount: '12.34' });
  expect(amountFromField(BUDGET, 0.123456)).toEqual({ amount: '0.1235' });
  // Text that is a plain amount, as a field that was once text may still hold.
  expect(amountFromField(BUDGET, ' 250.75 ')).toEqual({ amount: '250.75' });
});

it('gives no amount, and says so, for a field with nothing in it', () => {
  const empty = {
    amount: null,
    note: 'contact.custom.budget has nothing in it, so the deal has no amount.',
  };
  expect(amountFromField(BUDGET, undefined)).toEqual(empty);
  expect(amountFromField(BUDGET, null)).toEqual(empty);
  expect(amountFromField(BUDGET, '  ')).toEqual(empty);
});

it.each([
  ['about 2000', 'about 2000'],
  [-5, '-5'],
  [1e21, '1e+21'],
  [Number.NaN, 'NaN'],
  [true, 'true'],
  [['gold', 'silver'], 'gold, silver'],
])('gives no amount, and says so, for %j, which no deal can have as one', (value, held) => {
  expect(amountFromField(BUDGET, value)).toEqual({
    amount: null,
    note: `contact.custom.budget holds "${held}", which is not an amount a deal can have, so the deal has no amount.`,
  });
});

const SALES = 'pipe_sales';
const RENEWALS = 'pipe_renewals';

const deal = (
  name: string,
  patch: Partial<{ status: 'open' | 'won' | 'lost'; pipelineId: string; trashedAt: string | null }>,
) => ({ name, status: 'open' as const, pipelineId: SALES, trashedAt: null, ...patch });

it('chooses the one open deal', () => {
  const only = deal('Wedding', {});
  expect(chooseDeal([only])).toEqual({ ok: true, deal: only });
});

it('passes over closed deals and deals in the trash', () => {
  const open = deal('Wedding', {});
  expect(
    chooseDeal([
      deal('Won last year', { status: 'won' }),
      deal('Lost', { status: 'lost' }),
      deal('Binned', { trashedAt: '2026-10-01T00:00:00.000Z' }),
      open,
    ]),
  ).toEqual({ ok: true, deal: open });
});

it('fails with no open deal, and says where it looked', () => {
  expect(chooseDeal([])).toEqual({
    ok: false,
    code: 'no_open_deal',
    explanation: 'The contact has no open deal.',
  });
  expect(chooseDeal([deal('Won', { status: 'won' })])).toMatchObject({ code: 'no_open_deal' });
  expect(chooseDeal([deal('Renewal', { pipelineId: RENEWALS })], SALES)).toEqual({
    ok: false,
    code: 'no_open_deal',
    explanation: "The contact has no open deal in the step's pipeline.",
  });
});

it('fails rather than guess between several open deals', () => {
  expect(chooseDeal([deal('Wedding', {}), deal('Reception', {})])).toEqual({
    ok: false,
    code: 'several_open_deals',
    explanation: "The contact has more than one open deal, so the step can't tell which is meant.",
  });
  expect(chooseDeal([deal('Wedding', {}), deal('Reception', {})], SALES)).toMatchObject({
    ok: false,
    code: 'several_open_deals',
    explanation:
      "The contact has more than one open deal in the step's pipeline, so the step can't tell which is meant.",
  });
});

it("chooses the one open deal in the step's pipeline when other pipelines have open deals too", () => {
  const sale = deal('Wedding', {});
  const renewal = deal('Renewal', { pipelineId: RENEWALS });
  expect(chooseDeal([sale, renewal], SALES)).toEqual({ ok: true, deal: sale });
  expect(chooseDeal([sale, renewal], RENEWALS)).toEqual({ ok: true, deal: renewal });
  // With no pipeline to narrow by, two open deals are two candidates.
  expect(chooseDeal([sale, renewal])).toMatchObject({ ok: false, code: 'several_open_deals' });
});

const current: DealValues & { stageName: string; canManage: boolean } = {
  id: 'deal_1',
  revision: 'a'.repeat(64),
  name: 'Wedding',
  pipelineId: SALES,
  stageId: 'stage_new',
  amount: '1500.5000',
  currency: 'KES',
  expectedCloseDate: '2026-12-01',
  status: 'open',
  outcomeReason: null,
  stageName: 'New lead',
  canManage: true,
};

it('sends the CRM every value as read, with only the change, and nothing the command refuses', () => {
  expect(dealUpdate(current, { pipelineId: RENEWALS, stageId: 'stage_quoted' })).toEqual({
    id: 'deal_1',
    revision: 'a'.repeat(64),
    name: 'Wedding',
    pipelineId: RENEWALS,
    stageId: 'stage_quoted',
    amount: '1500.5000',
    currency: 'KES',
    expectedCloseDate: '2026-12-01',
    status: 'open',
    outcomeReason: null,
  });
  expect(dealUpdate(current, { status: 'lost', outcomeReason: 'Too expensive' })).toMatchObject({
    stageId: 'stage_new',
    status: 'lost',
    outcomeReason: 'Too expensive',
    revision: current.revision,
  });
});
