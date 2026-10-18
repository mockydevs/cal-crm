import type { ReportResult } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  chartModel,
  isEmptyResult,
  nextSort,
  sortedRows,
  statLines,
  tableModel,
  type ModelWords,
} from './result-model';

const en = 'en-GB';
const words: ModelWords = {
  other: 'Other',
  none: 'Not set',
  total: 'Total',
  previous: (label) => `${label}, before`,
  weekOf: (day) => `Week of ${day}`,
};

const range = {
  preset: 'last_30_days' as const,
  from: '2026-09-13',
  to: '2026-10-12',
  fromInstant: '2026-09-12T21:00:00.000Z',
  toInstant: '2026-10-12T21:00:00.000Z',
};

function resultOf(parts: Partial<ReportResult>): ReportResult {
  return {
    source: 'contacts',
    range,
    timeZone: 'Africa/Nairobi',
    dateProperty: 'created',
    attribution: 'first',
    columns: [],
    rows: [],
    totals: [],
    truncated: { other: false, incomplete: false, limit: 50 },
    ...parts,
  };
}

const count = { key: 'count', role: 'measure' as const, label: 'Contacts', kind: 'count' as const };
const value = { key: 'value', role: 'measure' as const, label: 'Value', kind: 'money' as const };
const source = {
  key: 'sessionSource',
  role: 'group' as const,
  label: 'Session source',
  kind: 'choice' as const,
};
const day = { key: 'day', role: 'time' as const, label: 'Day', kind: 'day' as const };
const kes = (amount: string) => ({ currency: 'KES', amount });
const usd = (amount: string) => ({ currency: 'USD', amount });

describe('chartModel', () => {
  it('draws groups as categories and each measure as a series', () => {
    const model = chartModel(
      resultOf({
        columns: [source, count],
        rows: [
          { group: [{ key: 'others', label: 'Others' }], other: false, values: [2] },
          { group: [{ key: 'crm_ui', label: 'CRM UI' }], other: false, values: [1] },
          { group: [{ key: null, label: '' }], other: false, values: [3] },
          { group: [{ key: null, label: '' }], other: true, values: [9] },
        ],
        totals: [15],
      }),
      en,
      words,
    );
    expect(model.grain).toBeNull();
    expect(model.categories.map((each) => [each.label, each.other])).toEqual([
      ['Others', false],
      ['CRM UI', false],
      ['Not set', false],
      ['Other', true],
    ]);
    expect(model.panels).toEqual([
      {
        unit: null,
        series: [
          expect.objectContaining({
            label: 'Contacts',
            values: [2, 1, 3, 9],
            texts: ['2', '1', '3', '9'],
            compare: false,
          }),
        ],
      },
    ]);
  });

  it('draws buckets of time as categories, named by their grain', () => {
    const model = chartModel(
      resultOf({
        columns: [day, count],
        rows: [
          { group: [{ key: '2026-10-05', label: '' }], other: false, values: [4] },
          { group: [{ key: '2026-10-06', label: '' }], other: false, values: [0] },
        ],
        totals: [4],
      }),
      en,
      words,
    );
    expect(model.grain).toBe('day');
    expect(model.categories.map((each) => [each.key, each.label, each.long])).toEqual([
      ['2026-10-05', '5 Oct', '5 Oct 2026'],
      ['2026-10-06', '6 Oct', '6 Oct 2026'],
    ]);
  });

  it('reads a week as the week of its first day', () => {
    const model = chartModel(
      resultOf({
        columns: [{ ...day, key: 'week', kind: 'week', label: 'Week' }, count],
        rows: [{ group: [{ key: '2026-10-05', label: '' }], other: false, values: [4] }],
        totals: [4],
      }),
      en,
      words,
    );
    expect(model.categories[0]).toMatchObject({ label: '5 Oct', long: 'Week of 5 Oct 2026' });
    expect(model.grain).toBe('week');
  });

  it('makes one series for each group over time, with zeros where a group has no row', () => {
    const model = chartModel(
      resultOf({
        columns: [day, source, count],
        rows: [
          {
            group: [
              { key: '2026-10-05', label: '' },
              { key: 'direct', label: 'Direct' },
            ],
            other: false,
            values: [2],
          },
          {
            group: [
              { key: '2026-10-06', label: '' },
              { key: 'referral', label: 'Referral' },
            ],
            other: false,
            values: [5],
          },
          {
            group: [
              { key: '2026-10-06', label: '' },
              { key: null, label: '' },
            ],
            other: true,
            values: [1],
          },
        ],
        totals: [8],
      }),
      en,
      words,
    );
    expect(model.categories.map((each) => each.key)).toEqual(['2026-10-05', '2026-10-06']);
    // The bucket of an "Other" row keeps its day: only its group is "Other".
    expect(model.categories.every((each) => !each.other)).toBe(true);
    expect(model.panels[0]?.series.map((each) => [each.label, each.values, each.texts])).toEqual([
      ['Direct', [2, 0], ['2', '0']],
      ['Referral', [0, 5], ['0', '5']],
      ['Other', [0, 1], ['0', '1']],
    ]);
  });

  it('names a series by its group and its measure when there are several measures', () => {
    const model = chartModel(
      resultOf({
        columns: [
          source,
          { key: 'status', role: 'group', label: 'Status', kind: 'choice' },
          count,
          value,
        ],
        rows: [
          {
            group: [
              { key: 'direct', label: 'Direct' },
              { key: 'won', label: 'Won' },
            ],
            other: false,
            values: [2, [kes('100.0000')]],
          },
        ],
        totals: [2, [kes('100.0000')]],
      }),
      en,
      words,
    );
    expect(model.categories.map((each) => each.label)).toEqual(['Direct']);
    expect(model.panels.map((panel) => [panel.unit, panel.series.map((s) => s.label)])).toEqual([
      [null, ['Won · Contacts']],
      ['KES', ['Won · Value']],
    ]);
  });

  it('keeps each currency in a panel of its own, and never adds them', () => {
    const model = chartModel(
      resultOf({
        columns: [source, value],
        rows: [
          {
            group: [{ key: 'direct', label: 'Direct' }],
            other: false,
            values: [[usd('40.0000'), kes('1000.0000')]],
          },
          {
            group: [{ key: 'referral', label: 'Referral' }],
            other: false,
            values: [[kes('250.5000')]],
          },
          { group: [{ key: 'others', label: 'Others' }], other: false, values: [null] },
        ],
        totals: [[kes('1250.5000'), usd('40.0000')]],
      }),
      en,
      words,
    );
    expect(model.panels.map((panel) => panel.unit)).toEqual(['KES', 'USD']);
    expect(model.panels[0]?.series[0]).toMatchObject({
      values: [1000, 250.5, 0],
      texts: ['KES 1,000', 'KES 250.50', 'KES 0'],
    });
    expect(model.panels[1]?.series[0]).toMatchObject({
      values: [40, 0, 0],
      texts: ['USD 40', 'USD 0', 'USD 0'],
    });
  });

  it('pairs each series with the same measure over the comparison period', () => {
    const model = chartModel(
      resultOf({
        columns: [day, count],
        rows: [
          { group: [{ key: '2026-10-05', label: '' }], other: false, values: [4], compare: [2] },
          { group: [{ key: '2026-10-06', label: '' }], other: false, values: [1], compare: [3] },
        ],
        totals: [5],
        compare: { mode: 'previous_period', range, totals: [5] },
      }),
      en,
      words,
    );
    expect(model.panels[0]?.series.map((each) => [each.label, each.compare, each.values])).toEqual([
      ['Contacts', false, [4, 1]],
      ['Contacts, before', true, [2, 3]],
    ]);
  });

  it('does not draw the comparison when the series are groups', () => {
    const model = chartModel(
      resultOf({
        columns: [day, source, count],
        rows: [
          {
            group: [
              { key: '2026-10-05', label: '' },
              { key: 'direct', label: 'Direct' },
            ],
            other: false,
            values: [4],
            compare: [2],
          },
        ],
        totals: [4],
        compare: { mode: 'previous_period', range, totals: [2] },
      }),
      en,
      words,
    );
    expect(model.panels[0]?.series.map((each) => each.compare)).toEqual([false]);
  });

  it('draws an answer without groups as one category, from the totals', () => {
    const model = chartModel(
      resultOf({
        columns: [count],
        rows: [{ group: [], other: false, values: [7] }],
        totals: [7],
        compare: { mode: 'previous_year', range, totals: [5] },
      }),
      en,
      words,
    );
    expect(model.categories).toEqual([
      { key: 'total', label: 'Total', long: 'Total', other: false },
    ]);
    expect(model.panels[0]?.series.map((each) => [each.label, each.values])).toEqual([
      ['Contacts', [7]],
      ['Contacts, before', [5]],
    ]);
    expect(
      chartModel(resultOf({ columns: [count], rows: [], totals: [7] }), en, words).panels[0]
        ?.series,
    ).toHaveLength(1);
  });

  it('names a weekday the server left unnamed, and shows a key it has no name for', () => {
    const model = chartModel(
      resultOf({
        columns: [{ key: 'weekday', role: 'group', label: 'Day', kind: 'weekday' }, count],
        rows: [
          { group: [{ key: '1', label: '' }], other: false, values: [1] },
          { group: [{ key: '9', label: '' }], other: false, values: [1] },
          { group: [{ key: '2', label: 'Tuesday' }], other: false, values: [1] },
          { group: [], other: false, values: [1] },
        ],
        totals: [4],
      }),
      en,
      words,
    );
    expect(model.categories.map((each) => [each.label, each.long])).toEqual([
      ['Mon', 'Monday'],
      ['9', '9'],
      ['Tuesday', 'Tuesday'],
      ['Not set', 'Not set'],
    ]);
  });

  it('has no panels for an answer with nothing in it', () => {
    expect(chartModel(resultOf({ columns: [source, count] }), en, words)).toEqual({
      categories: [],
      panels: [],
      grain: null,
    });
  });
});

describe('statLines', () => {
  it('lists each measure over the whole range, with the period before', () => {
    const lines = statLines(
      resultOf({
        columns: [source, count, value],
        totals: [4, [kes('125000.0000')]],
        compare: { mode: 'previous_period', range, totals: [2, [kes('100000.0000')]] },
      }),
      en,
    );
    expect(lines.map((line) => [line.key, line.label])).toEqual([
      ['count', 'Contacts'],
      ['value', 'Value'],
    ]);
    expect(lines[0]?.amounts[0]).toMatchObject({ text: '4', change: { direction: 'up' } });
    expect(lines[1]?.amounts[0]).toMatchObject({
      text: 'KES 125,000',
      before: { text: 'KES 100,000' },
      change: { percent: 0.25 },
    });
  });

  it('has no amounts for money without a value, and no change without a comparison', () => {
    const lines = statLines(resultOf({ columns: [count, value], totals: [4, []] }), en);
    expect(lines[0]?.amounts).toEqual([
      { currency: null, value: 4, text: '4', before: undefined, change: undefined },
    ]);
    expect(lines[1]?.amounts).toEqual([]);
  });
});

describe('isEmptyResult', () => {
  it('is empty when nothing was counted', () => {
    expect(isEmptyResult(resultOf({ columns: [count], totals: [0] }))).toBe(true);
    expect(isEmptyResult(resultOf({ columns: [value], totals: [[]] }))).toBe(true);
    expect(isEmptyResult(resultOf({ columns: [value], totals: [null] }))).toBe(true);
    expect(isEmptyResult(resultOf({ columns: [value], totals: [[kes('0.0000')]] }))).toBe(true);
    expect(
      isEmptyResult(
        resultOf({
          columns: [day, count],
          totals: [0],
          rows: [{ group: [{ key: '2026-10-05', label: '' }], other: false, values: [0] }],
        }),
      ),
    ).toBe(true);
  });

  it('is not empty with a count, an amount, or a row that has one', () => {
    expect(isEmptyResult(resultOf({ columns: [count], totals: [1] }))).toBe(false);
    expect(isEmptyResult(resultOf({ columns: [value], totals: [[kes('5.0000')]] }))).toBe(false);
    expect(
      isEmptyResult(
        resultOf({
          columns: [source, count],
          totals: [0],
          rows: [{ group: [{ key: 'direct', label: 'Direct' }], other: false, values: [2] }],
        }),
      ),
    ).toBe(false);
  });
});

describe('tableModel', () => {
  const result = resultOf({
    columns: [day, source, count, value],
    rows: [
      {
        group: [
          { key: '2026-10-06', label: '' },
          { key: 'direct', label: 'Direct' },
        ],
        other: false,
        values: [2, [usd('5.0000'), kes('100.0000')]],
        compare: [1, null],
      },
      {
        group: [
          { key: '2026-10-05', label: '' },
          { key: null, label: '' },
        ],
        other: true,
        values: [9, []],
      },
    ],
    totals: [11, [kes('100.0000'), usd('5.0000')]],
    compare: { mode: 'previous_period', range, totals: [1, []] },
  });

  it('has the group columns, then each measure with the period before', () => {
    const model = tableModel(result, en, words);
    expect(model.columns).toEqual([
      { key: 'day', label: 'Day', numeric: false },
      { key: 'sessionSource', label: 'Session source', numeric: false },
      { key: 'count', label: 'Contacts', numeric: true },
      { key: 'count:before', label: 'Contacts, before', numeric: true },
      { key: 'value', label: 'Value', numeric: true },
      { key: 'value:before', label: 'Value, before', numeric: true },
    ]);
    expect(model.rows.map((row) => row.cells)).toEqual([
      [['6 Oct 2026'], ['Direct'], ['2'], ['1'], ['KES 100', 'USD 5'], ['—']],
      [['5 Oct 2026'], ['Other'], ['9'], ['—'], ['—'], ['—']],
    ]);
    expect(model.rows.map((row) => row.other)).toEqual([false, true]);
    expect(model.rows[0]?.order).toEqual(['2026-10-06', 'direct', 2, 1, 100, -1]);
  });

  it('has no comparison columns without a comparison', () => {
    const model = tableModel(
      resultOf({
        columns: [source, count],
        rows: [{ group: [{ key: null, label: '' }], other: false, values: [3] }],
        totals: [3],
      }),
      en,
      words,
    );
    expect(model.columns.map((column) => column.key)).toEqual(['sessionSource', 'count']);
    expect(model.rows[0]?.cells).toEqual([['Not set'], ['3']]);
    expect(model.rows[0]?.order).toEqual(['not set', 3]);
  });
});

describe('sorting', () => {
  const rows = [
    { name: 'b', other: false, order: ['beta', 2] },
    { name: 'rest', other: true, order: ['other', 50] },
    { name: 'a', other: false, order: ['alpha', 10] },
    { name: 'c', other: false, order: ['gamma', 2] },
  ];
  const names = (sorted: readonly { name: string }[]): string[] => sorted.map((row) => row.name);

  it('leaves the rows as they came without a sort', () => {
    expect(names(sortedRows(rows, undefined))).toEqual(['b', 'rest', 'a', 'c']);
  });

  it('orders by a column either way, and keeps "Other" last', () => {
    expect(names(sortedRows(rows, { column: 1, direction: 'desc' }))).toEqual([
      'a',
      'b',
      'c',
      'rest',
    ]);
    expect(names(sortedRows(rows, { column: 1, direction: 'asc' }))).toEqual([
      'b',
      'c',
      'a',
      'rest',
    ]);
    expect(names(sortedRows(rows, { column: 0, direction: 'asc' }))).toEqual([
      'a',
      'b',
      'c',
      'rest',
    ]);
    expect(names(sortedRows(rows, { column: 0, direction: 'desc' }))).toEqual([
      'c',
      'b',
      'a',
      'rest',
    ]);
  });

  it('orders a column the rows do not have as equal', () => {
    expect(names(sortedRows(rows, { column: 5, direction: 'asc' }))).toEqual([
      'b',
      'a',
      'c',
      'rest',
    ]);
  });

  it('starts numbers largest first and names from A, and turns round on a second press', () => {
    expect(nextSort(undefined, 2, true)).toEqual({ column: 2, direction: 'desc' });
    expect(nextSort(undefined, 0, false)).toEqual({ column: 0, direction: 'asc' });
    expect(nextSort({ column: 2, direction: 'desc' }, 2, true)).toEqual({
      column: 2,
      direction: 'asc',
    });
    expect(nextSort({ column: 2, direction: 'asc' }, 2, true)).toEqual({
      column: 2,
      direction: 'desc',
    });
    expect(nextSort({ column: 2, direction: 'asc' }, 0, false)).toEqual({
      column: 0,
      direction: 'asc',
    });
  });
});
