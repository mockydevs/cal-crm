import { describe, expect, it } from 'vitest';

import { foldRows, fromUnits, toUnits, totalsOf, type FoldInput, type RawRow } from './fold.js';

const row = (values: Partial<RawRow>): RawRow => ({
  bucket: null,
  keys: [],
  currency: null,
  n: 0,
  valued: 0,
  amount: '0',
  people: 0,
  ...values,
});

const input = (values: Partial<FoldInput>): FoldInput => ({
  reads: ['rows'],
  dimensions: 1,
  buckets: null,
  rows: [],
  orderBy: 0,
  direction: 'desc',
  limit: 50,
  rank: (keys) => keys.flatMap((key) => (key === null ? [1, ''] : [0, key])),
  ...values,
});

describe('decimals', () => {
  it.each([
    ['0', 0n, '0.0000'],
    ['12', 120000n, '12.0000'],
    ['125000.5', 1250005000n, '125000.5000'],
    ['0.0001', 1n, '0.0001'],
    ['-5.25', -52500n, '-5.2500'],
    ['.5', 5000n, '0.5000'],
  ])('%s is %s ten-thousandths', (text, units, back) => {
    expect(toUnits(text)).toBe(units);
    expect(fromUnits(units)).toBe(back);
  });

  it('keeps sums of any size exact', () => {
    expect(fromUnits(toUnits('9999999999999999999.9999') + toUnits('0.0001'))).toBe(
      '10000000000000000000.0000',
    );
  });
});

describe('totals', () => {
  it('count rows, people, and money for each currency', () => {
    const rows = [
      row({ currency: 'KES', n: 4, valued: 3, amount: '3600.5000' }),
      row({ currency: 'USD', n: 1, valued: 1, amount: '300' }),
      row({ currency: 'EUR', n: 2, valued: 0, amount: '0' }),
    ];
    expect(totalsOf(['rows', 'sum', 'average'], rows)).toEqual([
      7,
      [
        { currency: 'KES', amount: '3600.5000' },
        { currency: 'USD', amount: '300.0000' },
      ],
      // 3600.50 / 3 = 1200.16666…, rounded to the nearest ten-thousandth.
      [
        { currency: 'KES', amount: '1200.1667' },
        { currency: 'USD', amount: '300.0000' },
      ],
    ]);
    expect(totalsOf(['people'], [row({ n: 4, people: 3 })])).toEqual([3]);
    expect(totalsOf(['rows', 'sum', 'people'], [])).toEqual([0, [], 0]);
  });

  it('round an average half away from zero', () => {
    const average = (amount: string, valued: number) =>
      totalsOf(['average'], [row({ currency: 'KES', valued, amount })]);
    expect(average('0.0001', 2)).toEqual([[{ currency: 'KES', amount: '0.0001' }]]);
    expect(average('-0.0001', 2)).toEqual([[{ currency: 'KES', amount: '-0.0001' }]]);
    expect(average('1', 3)).toEqual([[{ currency: 'KES', amount: '0.3333' }]]);
    expect(average('2', 3)).toEqual([[{ currency: 'KES', amount: '0.6667' }]]);
  });
});

describe('rows', () => {
  it('are none for a total with no grouping and no grain', () => {
    expect(foldRows(input({ dimensions: 0, rows: [row({ n: 3 })] }))).toEqual({
      rows: [],
      other: false,
      kept: 0,
    });
  });

  it('are the groups, largest first, ties in their own order', () => {
    const folded = foldRows(
      input({
        rows: [
          row({ keys: ['b'], n: 2 }),
          row({ keys: ['a'], n: 2 }),
          row({ keys: [null], n: 2 }),
          row({ keys: ['c'], n: 5 }),
        ],
      }),
    );
    expect(folded.rows.map((each) => [each.keys, each.values])).toEqual([
      [['c'], [5]],
      [['a'], [2]],
      [['b'], [2]],
      [[null], [2]],
    ]);
    expect(folded).toMatchObject({ other: false, kept: 4 });
  });

  it('can be smallest first, or in the groups’ own order either way', () => {
    const rows = [
      row({ keys: ['b'], n: 1 }),
      row({ keys: ['a'], n: 3 }),
      row({ keys: ['c'], n: 2 }),
    ];
    const keys = (values: Partial<FoldInput>) =>
      foldRows(input({ rows, ...values })).rows.map((each) => each.keys?.[0]);
    expect(keys({ direction: 'asc' })).toEqual(['b', 'c', 'a']);
    expect(keys({ orderBy: 'group', direction: 'asc' })).toEqual(['a', 'b', 'c']);
    expect(keys({ orderBy: 'group', direction: 'desc' })).toEqual(['c', 'b', 'a']);
    // A place that is no measure of the query weighs rows.
    expect(keys({ orderBy: 7 })).toEqual(['a', 'c', 'b']);
  });

  it('orders by people, by a sum and by an average', () => {
    const rows = [
      row({ keys: ['a'], currency: 'KES', n: 9, valued: 2, amount: '100', people: 1 }),
      row({ keys: ['b'], currency: 'KES', n: 1, valued: 1, amount: '80', people: 5 }),
      row({ keys: ['b'], currency: 'USD', n: 1, valued: 0, amount: '0', people: 0 }),
    ];
    const first = (reads: FoldInput['reads']) =>
      foldRows(input({ rows, reads })).rows[0]?.keys?.[0];
    expect(first(['rows'])).toBe('a');
    expect(first(['sum'])).toBe('a');
    expect(first(['average'])).toBe('b');
    // People of rows added together are not known, and weigh nothing: ties by name.
    expect(first(['people'])).toBe('a');
  });

  it('keeps so many groups and adds the rest up as Other, without a count of people', () => {
    const folded = foldRows(
      input({
        reads: ['rows', 'people', 'sum'],
        limit: 1,
        rows: [
          row({ keys: ['a'], currency: 'KES', n: 5, people: 4, valued: 1, amount: '10' }),
          row({ keys: ['b'], currency: 'KES', n: 2, people: 2, valued: 1, amount: '1.5' }),
          row({ keys: ['c'], currency: 'USD', n: 1, people: 1, valued: 1, amount: '7' }),
        ],
      }),
    );
    expect(folded.rows).toEqual([
      { bucket: null, keys: ['a'], values: [5, 4, [{ currency: 'KES', amount: '10.0000' }]] },
      {
        bucket: null,
        keys: null,
        values: [
          3,
          null,
          [
            { currency: 'KES', amount: '1.5000' },
            { currency: 'USD', amount: '7.0000' },
          ],
        ],
      },
    ]);
    expect(folded).toMatchObject({ other: true, kept: 1 });
  });

  it('are one a bucket with zeros where nothing happened', () => {
    const folded = foldRows(
      input({
        dimensions: 0,
        reads: ['rows', 'sum'],
        buckets: ['2026-09-01', '2026-09-02', '2026-09-03'],
        rows: [
          row({ bucket: '2026-09-01', currency: 'KES', n: 2, valued: 2, amount: '30' }),
          row({ bucket: '2026-09-03', currency: 'KES', n: 1, valued: 0, amount: '0' }),
        ],
      }),
    );
    expect(folded.rows).toEqual([
      { bucket: '2026-09-01', keys: [], values: [2, [{ currency: 'KES', amount: '30.0000' }]] },
      { bucket: '2026-09-02', keys: [], values: [0, []] },
      { bucket: '2026-09-03', keys: [], values: [1, []] },
    ]);
  });

  it('are the kept groups in every bucket, ranked over the whole range, with Other', () => {
    const folded = foldRows(
      input({
        buckets: ['2026-09-01', '2026-09-02'],
        limit: 1,
        rows: [
          row({ bucket: '2026-09-01', keys: ['a'], n: 1 }),
          row({ bucket: '2026-09-02', keys: ['a'], n: 4 }),
          row({ bucket: '2026-09-01', keys: ['b'], n: 3 }),
        ],
      }),
    );
    expect(folded.rows.map((each) => [each.bucket, each.keys, each.values])).toEqual([
      ['2026-09-01', ['a'], [1]],
      ['2026-09-01', null, [3]],
      ['2026-09-02', ['a'], [4]],
      ['2026-09-02', null, [0]],
    ]);
  });

  it('puts a comparison beside the same group', () => {
    const folded = foldRows(
      input({
        limit: 1,
        rows: [row({ keys: ['a'], n: 5 }), row({ keys: ['b'], n: 1 })],
        compare: {
          buckets: null,
          rows: [
            row({ keys: ['a'], n: 2 }),
            row({ keys: ['b'], n: 7 }),
            row({ keys: ['z'], n: 9 }),
          ],
        },
      }),
    );
    expect(folded.rows).toEqual([
      { bucket: null, keys: ['a'], values: [5], compare: [2] },
      { bucket: null, keys: null, values: [1], compare: [7] },
    ]);
  });

  it('puts a comparison beside the bucket in the same place, and zeros where it has none', () => {
    const folded = foldRows(
      input({
        dimensions: 0,
        buckets: ['2026-09-01', '2026-09-02', '2026-09-03'],
        rows: [row({ bucket: '2026-09-02', n: 4 })],
        compare: {
          buckets: ['2026-08-30', '2026-08-31'],
          rows: [row({ bucket: '2026-08-30', n: 1 }), row({ bucket: '2026-08-31', n: 6 })],
        },
      }),
    );
    expect(folded.rows.map((each) => [each.values, each.compare])).toEqual([
      [[0], [1]],
      [[4], [6]],
      // The comparison period has no third bucket.
      [[0], [0]],
    ]);
  });
});
