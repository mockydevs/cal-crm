import { describe, expect, it } from 'vitest';
import {
  amountsOf,
  axisText,
  bucketText,
  cellLines,
  cellOrder,
  changeOf,
  changeSign,
  changeSize,
  comparedOf,
  countText,
  dateOfDay,
  momentText,
  rangeText,
  weekdayText,
} from './format';

const en = 'en-GB';

describe('numbers', () => {
  it('writes counts whole, grouped in thousands', () => {
    expect(countText(1234567, en)).toBe('1,234,567');
    expect(countText(0, en)).toBe('0');
  });

  it('writes an axis value short', () => {
    expect(axisText(1500, 'en')).toBe('1.5K');
    expect(axisText(40, en)).toBe('40');
    expect(axisText(2_000_000, 'en')).toBe('2M');
  });
});

describe('cells', () => {
  it('has one amount for a count', () => {
    expect(amountsOf(12, en)).toEqual([{ currency: null, value: 12, text: '12' }]);
  });

  it('has one amount for each currency, never added together, in the order of their codes', () => {
    expect(
      amountsOf(
        [
          { currency: 'USD', amount: '99.5000' },
          { currency: 'KES', amount: '125000.0000' },
        ],
        en,
      ),
    ).toEqual([
      { currency: 'KES', value: 125000, text: 'KES 125,000' },
      { currency: 'USD', value: 99.5, text: 'USD 99.50' },
    ]);
  });

  it('has none where there is no value', () => {
    expect(amountsOf(null, en)).toEqual([]);
    expect(amountsOf(undefined, en)).toEqual([]);
    expect(amountsOf([], en)).toEqual([]);
  });

  it('writes a cell as lines, a dash for nothing', () => {
    expect(cellLines(3, en)).toEqual(['3']);
    expect(cellLines(null, en)).toEqual(['—']);
    expect(cellLines([], en)).toEqual(['—']);
    expect(
      cellLines(
        [
          { currency: 'KES', amount: '10.0000' },
          { currency: 'EUR', amount: '2.2500' },
        ],
        en,
      ),
    ).toEqual(['EUR 2.25', 'KES 10']);
  });

  it('orders a cell by its count, or by its largest amount; nothing comes first', () => {
    expect(cellOrder(7)).toBe(7);
    expect(cellOrder(null)).toBe(-1);
    expect(cellOrder(undefined)).toBe(-1);
    expect(cellOrder([])).toBe(-1);
    expect(
      cellOrder([
        { currency: 'KES', amount: '10.0000' },
        { currency: 'USD', amount: '25.0000' },
      ]),
    ).toBe(25);
  });
});

describe('dates', () => {
  it('reads a calendar day as itself, whatever the reader’s time zone', () => {
    expect(dateOfDay('2026-10-05').toISOString()).toBe('2026-10-05T12:00:00.000Z');
    expect(Number.isNaN(dateOfDay('nonsense').getTime())).toBe(true);
  });

  it('names a bucket by its grain', () => {
    expect(bucketText('2026-10-05', 'day', en)).toBe('5 Oct');
    expect(bucketText('2026-10-05', 'week', en)).toBe('5 Oct');
    expect(bucketText('2026-10-01', 'month', en)).toBe('Oct 2026');
    expect(bucketText('2026-10-05', 'day', en, 'long')).toBe('5 Oct 2026');
    expect(bucketText('2026-10-01', 'month', en, 'long')).toBe('October 2026');
    expect(bucketText('soon', 'day', en)).toBe('soon');
  });

  it('writes a range by its first and last day, and one day as one', () => {
    expect(rangeText({ from: '2026-09-13', to: '2026-10-12' }, en)).toBe(
      '13 Sept 2026 – 12 Oct 2026',
    );
    expect(rangeText({ from: '2026-10-12', to: '2026-10-12' }, en)).toBe('12 Oct 2026');
  });

  it('names the days of the week from Monday', () => {
    expect(weekdayText(1, en)).toBe('Monday');
    expect(weekdayText(7, en)).toBe('Sunday');
    expect(weekdayText(3, en, 'short')).toBe('Wed');
  });

  it('writes a moment in the business’s time zone', () => {
    expect(momentText('2026-10-12T21:30:00.000Z', 'Africa/Nairobi', en)).toBe('13 Oct 2026, 00:30');
    expect(momentText('2026-10-12T21:30:00.000Z', 'UTC', en)).toBe('12 Oct 2026, 21:30');
    expect(momentText('never', 'UTC', en)).toBe('never');
  });

  it('falls back to the reader’s zone for a zone it does not know', () => {
    expect(momentText('2026-10-12T21:30:00.000Z', 'Not/AZone', en)).toMatch(/Oct 2026/);
  });
});

describe('comparison', () => {
  it('says which way a number moved, and by how much of the one before', () => {
    expect(changeOf(15, 12)).toEqual({ direction: 'up', percent: 0.25, difference: 3 });
    expect(changeOf(9, 12)).toEqual({ direction: 'down', percent: 0.25, difference: -3 });
    expect(changeOf(12, 12)).toEqual({ direction: 'same', percent: 0, difference: 0 });
  });

  it('has no share of nothing', () => {
    expect(changeOf(4, 0)).toEqual({ direction: 'up', percent: null, difference: 4 });
    expect(changeOf(0, 0)).toEqual({ direction: 'same', percent: null, difference: 0 });
  });

  it('writes the size as a percentage, or as the difference when there is no share', () => {
    expect(changeSize(changeOf(15, 12), en)).toBe('25%');
    expect(changeSize(changeOf(1, 3), en)).toBe('66.7%');
    expect(changeSize(changeOf(4, 0), en)).toBe('4');
    expect(changeSize(changeOf(0, 0), en)).toBe('0');
  });

  it('signs a change for eyes', () => {
    expect(changeSign(changeOf(2, 1))).toBe('+');
    expect(changeSign(changeOf(1, 2))).toBe('−');
    expect(changeSign(changeOf(1, 1))).toBe('');
  });

  it('compares a count with the count before', () => {
    expect(comparedOf(15, 12, en)).toEqual([
      {
        currency: null,
        value: 15,
        text: '15',
        before: { currency: null, value: 12, text: '12' },
        change: { direction: 'up', percent: 0.25, difference: 3 },
      },
    ]);
  });

  it('compares money only with the same currency', () => {
    const compared = comparedOf(
      [
        { currency: 'KES', amount: '200.0000' },
        { currency: 'USD', amount: '50.0000' },
      ],
      [
        { currency: 'KES', amount: '100.0000' },
        { currency: 'EUR', amount: '30.0000' },
      ],
      en,
    );
    expect(compared.map((each) => [each.currency, each.text, each.before?.text])).toEqual([
      ['KES', 'KES 200', 'KES 100'],
      // New this period: nothing to compare it with.
      ['USD', 'USD 50', undefined],
      // Only the earlier period had it: nothing now.
      ['EUR', 'EUR 0', 'EUR 30'],
    ]);
    expect(compared[0]?.change).toEqual({ direction: 'up', percent: 1, difference: 100 });
    expect(compared[1]?.change).toBeUndefined();
    expect(compared[2]?.change).toEqual({ direction: 'down', percent: 1, difference: -30 });
  });

  it('has nothing to compare without a period before, and nothing where there is no value', () => {
    expect(comparedOf(4, undefined, en)).toEqual([
      { currency: null, value: 4, text: '4', before: undefined, change: undefined },
    ]);
    expect(comparedOf(null, 4, en)).toEqual([]);
    expect(comparedOf(null, null, en)).toEqual([]);
  });
});
