// The Dashboard's opportunity widgets, worked out by hand for a small pipeline and held
// against the rules. No database: report.int.test.ts counts real deals.
import { describe, expect, it } from 'vitest';

import { opportunityWidgets, tally, type DealGroup, type ReportStage } from './report-rules.js';

const NEW: ReportStage = { id: 'new', name: 'New', archived: false };
const QUOTED: ReportStage = { id: 'quoted', name: 'Quoted', archived: false };
const BOOKED: ReportStage = { id: 'booked', name: 'Booked', archived: false };
const stages = [NEW, QUOTED, BOOKED];
const group = (
  stageId: string,
  status: DealGroup['status'],
  count: number,
  amount: string,
  currency = 'KES',
): DealGroup => ({ stageId, status, currency, count, amount });

describe('adding deals up', () => {
  it('adds amounts exactly, to four places, and never across currencies', () => {
    expect(
      tally([
        group('new', 'open', 2, '0.0001'),
        group('new', 'won', 1, '0.0002'),
        group('new', 'open', 1, '123456789012345.1234'),
        group('new', 'open', 3, '10', 'USD'),
        // Fewer places than four, as a whole number or a short fraction is written.
        group('new', 'lost', 1, '2500.5', 'USD'),
      ]),
    ).toEqual({
      count: 8,
      totals: [
        { currency: 'KES', amount: '123456789012345.1237' },
        { currency: 'USD', amount: '2510.5000' },
      ],
    });
  });

  it('has no total where there is no deal, and a zero total where no deal has an amount', () => {
    expect(tally([])).toEqual({ count: 0, totals: [] });
    expect(tally([group('new', 'open', 3, '0.0000')])).toEqual({
      count: 3,
      totals: [{ currency: 'KES', amount: '0.0000' }],
    });
  });
});

describe('the widgets', () => {
  // Six open or won deals and two lost ones, counted by hand in the comments.
  const groups = [
    group('new', 'open', 1, '100.0000'),
    group('new', 'open', 1, '50.0000', 'USD'),
    group('quoted', 'open', 1, '200.0000'),
    group('booked', 'open', 1, '0.0000'),
    group('booked', 'won', 1, '1000.0000'),
    group('quoted', 'won', 1, '300.0000'),
    group('new', 'lost', 1, '400.0000'),
    group('quoted', 'lost', 1, '70.0000', 'USD'),
  ];
  const widgets = opportunityWidgets(stages, groups);

  it('count and total each status: Opportunity status and Opportunity value', () => {
    expect(widgets.count).toBe(8);
    expect(widgets.statuses).toEqual([
      {
        status: 'open',
        count: 4,
        totals: [
          { currency: 'KES', amount: '300.0000' },
          { currency: 'USD', amount: '50.0000' },
        ],
      },
      { status: 'won', count: 2, totals: [{ currency: 'KES', amount: '1300.0000' }] },
      {
        status: 'lost',
        count: 2,
        totals: [
          { currency: 'KES', amount: '400.0000' },
          { currency: 'USD', amount: '70.0000' },
        ],
      },
    ]);
  });

  it('give the share of deals won, with what they brought in: Conversion rate', () => {
    expect(widgets.conversion).toEqual({
      won: 2,
      total: 8,
      rate: 0.25,
      wonTotals: [{ currency: 'KES', amount: '1300.0000' }],
    });
  });

  it('count each section from its stage to the last, won deals included and lost ones not: Funnel', () => {
    expect(widgets.funnel).toEqual([
      {
        // All six open and won deals are in New or later.
        stageId: 'new',
        name: 'New',
        count: 6,
        totals: [
          { currency: 'KES', amount: '1600.0000' },
          { currency: 'USD', amount: '50.0000' },
        ],
        cumulativeRate: 1,
        nextStepRate: null,
      },
      {
        // Quoted or Booked: two open and two won.
        stageId: 'quoted',
        name: 'Quoted',
        count: 4,
        totals: [{ currency: 'KES', amount: '1500.0000' }],
        cumulativeRate: 4 / 6,
        nextStepRate: 4 / 6,
      },
      {
        stageId: 'booked',
        name: 'Booked',
        count: 2,
        totals: [{ currency: 'KES', amount: '1000.0000' }],
        cumulativeRate: 2 / 6,
        nextStepRate: 2 / 4,
      },
    ]);
    // No section is larger than the one before it.
    const counts = widgets.funnel.map((section) => section.count);
    expect(counts).toEqual([...counts].sort((left, right) => right - left));
  });

  it('show the open deals of each stage, and every active stage: Stages distribution', () => {
    expect(widgets.stages).toEqual([
      {
        stageId: 'new',
        name: 'New',
        archived: false,
        count: 2,
        totals: [
          { currency: 'KES', amount: '100.0000' },
          { currency: 'USD', amount: '50.0000' },
        ],
      },
      {
        stageId: 'quoted',
        name: 'Quoted',
        archived: false,
        count: 1,
        totals: [{ currency: 'KES', amount: '200.0000' }],
      },
      {
        stageId: 'booked',
        name: 'Booked',
        archived: false,
        count: 1,
        totals: [{ currency: 'KES', amount: '0.0000' }],
      },
    ]);
  });

  it('say nothing can be worked out where there is nothing to divide by', () => {
    const empty = opportunityWidgets(stages, []);
    expect(empty.count).toBe(0);
    expect(empty.conversion).toEqual({ won: 0, total: 0, rate: null, wonTotals: [] });
    expect(empty.statuses.map((status) => status.count)).toEqual([0, 0, 0]);
    expect(empty.funnel.map((section) => [section.cumulativeRate, section.nextStepRate])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    expect(empty.stages.map((stage) => [stage.name, stage.count, stage.totals])).toEqual([
      ['New', 0, []],
      ['Quoted', 0, []],
      ['Booked', 0, []],
    ]);
    // Deals only in the last stage: the sections before it hold them too.
    const late = opportunityWidgets(stages, [group('booked', 'open', 3, '30.0000')]);
    expect(
      late.funnel.map((section) => [section.count, section.cumulativeRate, section.nextStepRate]),
    ).toEqual([
      [3, 1, null],
      [3, 1, 1],
      [3, 1, 1],
    ]);
    // Only lost deals: a rate of nought, not of nothing, and an empty funnel.
    const lost = opportunityWidgets(stages, [group('new', 'lost', 2, '5.0000')]);
    expect(lost.conversion).toMatchObject({ won: 0, total: 2, rate: 0 });
    expect(lost.funnel.map((section) => section.count)).toEqual([0, 0, 0]);
    // A pipeline with no stage at all has no sections and no rates.
    expect(opportunityWidgets([], [group('gone', 'won', 1, '5.0000')])).toMatchObject({
      count: 1,
      funnel: [],
      stages: [],
      conversion: { won: 1, total: 1, rate: 1 },
    });
  });

  it('count a deal in an archived stage where it is, without giving that stage a section', () => {
    const withOld: ReportStage[] = [
      NEW,
      { id: 'old', name: 'Old', archived: true },
      { id: 'gone', name: 'Gone', archived: true },
      BOOKED,
    ];
    const held = opportunityWidgets(withOld, [
      group('new', 'open', 1, '10.0000'),
      group('old', 'open', 2, '20.0000'),
      group('old', 'won', 1, '40.0000'),
      group('booked', 'open', 1, '80.0000'),
      // A stage the pipeline no longer has at all is in no section.
      group('removed', 'open', 5, '1.0000'),
    ]);
    expect(held.funnel.map((section) => [section.name, section.count])).toEqual([
      // New and everything after it: 1 + 2 + 1 + 1.
      ['New', 5],
      ['Booked', 1],
    ]);
    expect(held.funnel[1]).toMatchObject({ cumulativeRate: 1 / 5, nextStepRate: 1 / 5 });
    expect(held.stages.map((stage) => [stage.name, stage.archived, stage.count])).toEqual([
      ['New', false, 1],
      ['Old', true, 2],
      ['Booked', false, 1],
    ]);
  });
});
