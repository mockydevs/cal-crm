import { OPPORTUNITY_REPORT_MAX_DAYS, opportunityReportQuery } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  barShare,
  dashboardSearchOf,
  MAX_RANGE_DAYS,
  moneyText,
  percentText,
  pipelineChoices,
  rangeOf,
  ringOf,
  valueGroups,
  widgetEmpty,
  withCustomRange,
  withPreset,
  type ReportNumbers,
} from './dashboard-report-rules';

// Noon on Sunday 11 October 2026, where the reader is.
const now = new Date(2026, 9, 11, 12, 30);
const localIso = (year: number, month: number, day: number): string =>
  new Date(year, month - 1, day).toISOString();

describe('the search in the address', () => {
  it('keeps a known preset, and nothing for the default', () => {
    expect(dashboardSearchOf({ range: 'last_7_days' })).toEqual({ range: 'last_7_days' });
    expect(dashboardSearchOf({ range: 'last_30_days' })).toEqual({});
    expect(dashboardSearchOf({ range: 'forever', other: 1 })).toEqual({});
  });

  it('keeps the days of a custom range only when they are days', () => {
    expect(dashboardSearchOf({ range: 'custom', from: '2026-09-01', to: '2026-09-30' })).toEqual({
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(dashboardSearchOf({ range: 'custom', from: 'soon', to: 20260930 })).toEqual({
      range: 'custom',
    });
    expect(dashboardSearchOf({ range: 'today', from: '2026-09-01' })).toEqual({ range: 'today' });
  });
});

describe('the range of dates', () => {
  it('is the last 30 days up to the end of today by default', () => {
    expect(rangeOf({}, now)).toEqual({
      ok: true,
      from: localIso(2026, 9, 12),
      to: localIso(2026, 10, 12),
      first: '2026-09-12',
      last: '2026-10-11',
    });
  });

  it.each([
    ['today', '2026-10-11', '2026-10-11'],
    ['last_7_days', '2026-10-05', '2026-10-11'],
    ['last_90_days', '2026-07-14', '2026-10-11'],
    ['this_month', '2026-10-01', '2026-10-31'],
    ['last_month', '2026-09-01', '2026-09-30'],
    ['this_year', '2026-01-01', '2026-12-31'],
  ] as const)('covers %s from %s to %s', (range, first, last) => {
    const result = rangeOf({ range }, now);
    expect(result).toMatchObject({ ok: true, first, last });
  });

  it('ends a custom range after its last day, where the reader is', () => {
    expect(rangeOf({ range: 'custom', from: '2026-09-01', to: '2026-09-30' }, now)).toEqual({
      ok: true,
      from: localIso(2026, 9, 1),
      to: localIso(2026, 10, 1),
      first: '2026-09-01',
      last: '2026-09-30',
    });
    expect(rangeOf({ range: 'custom', from: '2026-09-30', to: '2026-09-30' }, now)).toMatchObject({
      ok: true,
    });
  });

  it('refuses a custom range that is unfinished, backwards or too long', () => {
    expect(rangeOf({ range: 'custom', from: '2026-09-01' }, now)).toEqual({
      ok: false,
      reason: 'incomplete',
      first: '2026-09-01',
      last: '',
    });
    expect(rangeOf({ range: 'custom', from: '2026-02-31', to: '2026-03-02' }, now)).toMatchObject({
      ok: false,
      reason: 'incomplete',
    });
    expect(rangeOf({ range: 'custom', from: '2026-10-02', to: '2026-10-01' }, now)).toMatchObject({
      ok: false,
      reason: 'order',
    });
    expect(rangeOf({ range: 'custom', from: '2023-01-01', to: '2026-10-01' }, now)).toMatchObject({
      ok: false,
      reason: 'too_long',
    });
  });

  it('asks for at most what the contract allows, and every range it gives is accepted', () => {
    expect(MAX_RANGE_DAYS).toBe(OPPORTUNITY_REPORT_MAX_DAYS);
    const pipelineId = 'pipe_01k8e2wzr0e008000000000001';
    for (const search of [
      {},
      { range: 'today' },
      { range: 'this_year' },
      { range: 'custom', from: '2023-10-12', to: '2026-10-11' },
    ] as const) {
      const range = rangeOf(search, now);
      if (!range.ok) throw new Error('expected a range');
      expect(
        opportunityReportQuery.safeParse({ pipelineId, from: range.from, to: range.to }).success,
      ).toBe(true);
    }
    expect(rangeOf({ range: 'custom', from: '2023-10-10', to: '2026-10-11' }, now).ok).toBe(false);
  });

  it('moves between a preset and a custom range that starts as what was shown', () => {
    expect(withPreset('last_7_days')).toEqual({ range: 'last_7_days' });
    expect(withPreset('last_30_days')).toEqual({});
    expect(withPreset('custom', rangeOf({}, now))).toEqual({
      range: 'custom',
      from: '2026-09-12',
      to: '2026-10-11',
    });
    expect(withCustomRange('2026-09-01', '')).toEqual({ range: 'custom', from: '2026-09-01' });
  });
});

describe('what the numbers read as', () => {
  it('writes a rate as a percentage, and a dash when there is none', () => {
    expect(percentText(0.4286)).toBe('42.86%');
    expect(percentText(1)).toBe('100.00%');
    expect(percentText(0)).toBe('0.00%');
    expect(percentText(0.4286, 0)).toBe('43%');
    expect(percentText(null)).toBe('—');
  });

  it('writes money with its currency, exactly, without empty decimal places', () => {
    expect(moneyText({ currency: 'KES', amount: '125000.0000' })).toBe('KES 125,000');
    expect(moneyText({ currency: 'USD', amount: '1280.5000' })).toBe('USD 1,280.50');
    expect(moneyText({ currency: 'USD', amount: '0.1234' })).toBe('USD 0.1234');
    expect(moneyText({ currency: 'USD', amount: '99999999999999999999.0100' })).toBe(
      'USD 99,999,999,999,999,999,999.01',
    );
    expect(moneyText({ currency: 'KES', amount: '7' })).toBe('KES 7');
  });
});

describe('chart geometry', () => {
  it('gives a bar its share of the longest, from 0 to 100', () => {
    expect(barShare(3, 4)).toBe(75);
    expect(barShare(1, 3)).toBe(33.33);
    expect(barShare(0, 4)).toBe(0);
    expect(barShare(4, 0)).toBe(0);
    expect(barShare(9, 4)).toBe(100);
    expect(barShare(-1, 4)).toBe(0);
  });

  it('draws the ring as a filled arc and the rest of the circle', () => {
    const half = ringOf(0.5, 50);
    expect(half.circumference).toBeCloseTo(314.159, 3);
    expect(half.filled).toBeCloseTo(157.08, 2);
    expect(half.dash).toBe('157.08 157.08');
    expect(ringOf(null, 50).dash).toBe('0 314.16');
    expect(ringOf(1, 50).dash).toBe('314.16 0');
    expect(ringOf(1.4, 50).dash).toBe('314.16 0');
  });

  it('groups the value of each status by currency, never adding two currencies', () => {
    const statuses: ReportNumbers['statuses'] = [
      {
        status: 'open',
        count: 4,
        totals: [
          { currency: 'USD', amount: '300.0000' },
          { currency: 'KES', amount: '1000.0000' },
        ],
      },
      { status: 'won', count: 3, totals: [{ currency: 'KES', amount: '250.0000' }] },
      { status: 'lost', count: 0, totals: [] },
    ];
    expect(valueGroups(statuses)).toEqual([
      {
        currency: 'KES',
        rows: [
          { status: 'open', text: 'KES 1,000', share: 100 },
          { status: 'won', text: 'KES 250', share: 25 },
          { status: 'lost', text: 'KES 0', share: 0 },
        ],
      },
      {
        currency: 'USD',
        rows: [
          { status: 'open', text: 'USD 300', share: 100 },
          { status: 'won', text: 'USD 0', share: 0 },
          { status: 'lost', text: 'USD 0', share: 0 },
        ],
      },
    ]);
    expect(valueGroups([{ status: 'open', count: 2, totals: [] }])).toEqual([]);
  });
});

describe('a widget with nothing to show', () => {
  const none: ReportNumbers = {
    count: 0,
    statuses: [
      { status: 'open', count: 0, totals: [] },
      { status: 'won', count: 0, totals: [] },
      { status: 'lost', count: 0, totals: [] },
    ],
    conversion: { won: 0, total: 0, rate: null, wonTotals: [] },
    funnel: [
      {
        stageId: 's1',
        name: 'New',
        count: 0,
        totals: [],
        cumulativeRate: null,
        nextStepRate: null,
      },
    ],
    stages: [{ stageId: 's1', name: 'New', archived: false, count: 0, totals: [] }],
  };

  it('is every widget of an empty range', () => {
    for (const widget of ['status', 'value', 'conversion', 'funnel', 'stages'] as const)
      expect(widgetEmpty(widget, none)).toBe(true);
  });

  it('is told for each widget from its own numbers', () => {
    const lostOnly: ReportNumbers = {
      ...none,
      count: 1,
      statuses: [
        { status: 'open', count: 0, totals: [] },
        { status: 'won', count: 0, totals: [] },
        { status: 'lost', count: 1, totals: [] },
      ],
      conversion: { won: 0, total: 1, rate: 0, wonTotals: [] },
    };
    expect(widgetEmpty('status', lostOnly)).toBe(false);
    expect(widgetEmpty('conversion', lostOnly)).toBe(false);
    // No amounts, no open or won deal in a stage.
    expect(widgetEmpty('value', lostOnly)).toBe(true);
    expect(widgetEmpty('funnel', lostOnly)).toBe(true);
    expect(widgetEmpty('stages', lostOnly)).toBe(true);
  });
});

describe('the pipelines on offer', () => {
  it('are the ones in use, or all of them when every one is archived', () => {
    const a = { id: 'a', name: 'Sales', archived: false };
    const b = { id: 'b', name: 'Old', archived: true };
    expect(pipelineChoices([b, a])).toEqual([a]);
    expect(pipelineChoices([b])).toEqual([b]);
    expect(pipelineChoices([])).toEqual([]);
  });
});
