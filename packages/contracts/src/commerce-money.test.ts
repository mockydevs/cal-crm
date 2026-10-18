import { describe, expect, it } from 'vitest';

import {
  computeDocumentTotals,
  currencyDigits,
  fromUnits,
  roundHalfUp,
  smallestUnit,
  toUnits,
  type DocumentTotals,
  type TotalsInput,
  type TotalsIssue,
} from './commerce-money.js';

const totalsOf = (input: TotalsInput): DocumentTotals => {
  const result = computeDocumentTotals(input);
  if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.issues)}`);
  return result.totals;
};
const issuesOf = (input: TotalsInput): readonly TotalsIssue[] => {
  const result = computeDocumentTotals(input);
  if (result.ok) throw new Error('Nothing was refused.');
  return result.issues;
};
const line = (quantity: string, unitPrice: string, more: Record<string, unknown> = {}) => ({
  quantity,
  unitPrice,
  ...more,
});

describe('amounts as ten-thousandths', () => {
  it('reads a decimal of up to four places exactly, and writes it back with four', () => {
    expect(toUnits('0')).toBe(0n);
    expect(toUnits('1')).toBe(10_000n);
    expect(toUnits('0.3333')).toBe(3333n);
    expect(toUnits('1500.5')).toBe(15_005_000n);
    expect(toUnits('-2.25')).toBe(-22_500n);
    expect(toUnits('999999999999999.9999')).toBe(9_999_999_999_999_999_999n);
    expect(fromUnits(0n)).toBe('0.0000');
    expect(fromUnits(1n)).toBe('0.0001');
    expect(fromUnits(15_005_000n)).toBe('1500.5000');
    expect(fromUnits(-22_500n)).toBe('-2.2500');
    for (const text of ['0.0000', '12.3400', '-0.0001', '999999999999999.9999'])
      expect(fromUnits(toUnits(text))).toBe(text);
  });

  it("knows each currency's smallest unit, and never more than four places", () => {
    expect(currencyDigits('KES')).toBe(2);
    expect(currencyDigits('USD')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('KWD')).toBe(3);
    // Not a currency: the caller is refused elsewhere; here it gets the usual two places.
    expect(currencyDigits('ZZZ')).toBe(2);
    expect(smallestUnit('KES')).toBe(100n);
    expect(smallestUnit('JPY')).toBe(10_000n);
    expect(smallestUnit('KWD')).toBe(10n);
  });

  it('rounds to the nearest step, halves up', () => {
    // 0.9999 to cents is 1.00; 0.0049 is 0.00; 0.0050 is 0.01.
    expect(roundHalfUp(9999n, 1n, 100n)).toBe(10_000n);
    expect(roundHalfUp(49n, 1n, 100n)).toBe(0n);
    expect(roundHalfUp(50n, 1n, 100n)).toBe(100n);
    expect(roundHalfUp(51n, 1n, 100n)).toBe(100n);
    expect(roundHalfUp(149n, 1n, 100n)).toBe(100n);
    expect(roundHalfUp(150n, 1n, 100n)).toBe(200n);
    // A third of one, to cents.
    expect(roundHalfUp(10_000n, 3n, 100n)).toBe(3300n);
    expect(roundHalfUp(20_000n, 3n, 100n)).toBe(6700n);
    expect(roundHalfUp(0n, 7n, 100n)).toBe(0n);
  });
});

describe('what a document comes to', () => {
  it('rounds 3 x 0.3333 to the cent on the line, then taxes the rounded line', () => {
    const totals = totalsOf({
      currency: 'KES',
      lines: [line('3', '0.3333', { taxRate: '16' })],
    });
    // 0.9999 is 1.00 to the cent; 16% of 1.00 is 0.16.
    expect(totals).toEqual({
      lines: [
        {
          amount: '1.0000',
          discount: '0.0000',
          net: '1.0000',
          taxable: '1.0000',
          tax: '0.1600',
          total: '1.1600',
        },
      ],
      subtotal: '1.0000',
      lineDiscountTotal: '0.0000',
      documentDiscount: '0.0000',
      discountTotal: '0.0000',
      taxes: [{ rate: '16.0000', taxable: '1.0000', tax: '0.1600' }],
      taxTotal: '0.1600',
      total: '1.1600',
    });
  });

  it('rounds to whole units in a currency without cents', () => {
    const totals = totalsOf({
      currency: 'JPY',
      lines: [
        line('3', '0.3333'),
        line('1', '0.4'),
        line('1', '0.5'),
        line('7', '142.8', { taxRate: '10' }),
      ],
    });
    expect(totals.lines.map((each) => each.amount)).toEqual([
      '1.0000',
      '0.0000',
      '1.0000',
      // 999.6 is 1000.
      '1000.0000',
    ]);
    expect(totals.taxTotal).toBe('100.0000');
    expect(totals.total).toBe('1102.0000');
  });

  it('takes a line discount off before tax, as a percentage or an amount', () => {
    const totals = totalsOf({
      currency: 'USD',
      lines: [
        line('2', '49.99', { discount: { kind: 'percent', value: '12.5' }, taxRate: '8.25' }),
        line('1', '100', { discount: { kind: 'amount', value: '100' }, taxRate: '8.25' }),
      ],
    });
    // 99.98 less 12.5% (12.4975, 12.50 to the cent) is 87.48; 8.25% of it is 7.2171, 7.22.
    expect(totals.lines[0]).toEqual({
      amount: '99.9800',
      discount: '12.5000',
      net: '87.4800',
      taxable: '87.4800',
      tax: '7.2200',
      total: '94.7000',
    });
    // A line discounted to nothing is charged no tax.
    expect(totals.lines[1]).toMatchObject({ net: '0.0000', tax: '0.0000', total: '0.0000' });
    expect(totals).toMatchObject({
      subtotal: '199.9800',
      lineDiscountTotal: '112.5000',
      discountTotal: '112.5000',
      taxTotal: '7.2200',
      total: '94.7000',
    });
  });

  it('comes to nothing under a discount of 100 percent, on a line or on the document', () => {
    for (const input of [
      {
        currency: 'KES',
        lines: [line('4', '250', { discount: { kind: 'percent', value: '100' }, taxRate: '16' })],
      },
      {
        currency: 'KES',
        lines: [line('4', '250', { taxRate: '16' }), line('1', '0.01')],
        discount: { kind: 'percent', value: '100' },
      },
    ] satisfies TotalsInput[]) {
      const totals = totalsOf(input);
      expect(totals.total).toBe('0.0000');
      expect(totals.taxTotal).toBe('0.0000');
      expect(totals.discountTotal).toBe(totals.subtotal);
      expect(totals.lines.every((each) => each.total === '0.0000')).toBe(true);
    }
  });

  it('shares a document discount over lines with different tax rates, to the cent', () => {
    const totals = totalsOf({
      currency: 'KES',
      lines: [
        line('2', '1500', { discount: { kind: 'percent', value: '10' }, taxRate: '16' }),
        line('1', '999.99'),
        // 100.005 is 100.01 to the cent.
        line('3', '33.335', { taxRate: '8' }),
      ],
      discount: { kind: 'percent', value: '5' },
    });
    // The lines net 2700.00, 999.99 and 100.01: 3800.00, and 5% of it is 190.00. In
    // proportion that is 135.00, 49.9995 and 5.0005: 135.00, 49.99 and 5.00 leave one cent,
    // which goes to the line that lost the most, the second.
    expect(totals.lines.map((each) => each.taxable)).toEqual(['2565.0000', '949.9900', '95.0100']);
    expect(totals.lines.map((each) => each.tax)).toEqual(['410.4000', '0.0000', '7.6000']);
    expect(totals.lines.map((each) => each.total)).toEqual(['2975.4000', '949.9900', '102.6100']);
    expect(totals).toMatchObject({
      subtotal: '4100.0000',
      lineDiscountTotal: '300.0000',
      documentDiscount: '190.0000',
      discountTotal: '490.0000',
      taxes: [
        { rate: '0.0000', taxable: '949.9900', tax: '0.0000' },
        { rate: '8.0000', taxable: '95.0100', tax: '7.6000' },
        { rate: '16.0000', taxable: '2565.0000', tax: '410.4000' },
      ],
      taxTotal: '418.0000',
      total: '4028.0000',
    });
  });

  it('adds the lines of one rate into one tax entry, and takes an amount off the document', () => {
    const totals = totalsOf({
      currency: 'KES',
      lines: [
        line('1', '100', { taxRate: '16' }),
        line('1', '50', { taxRate: '16.0' }),
        line('1', '50'),
      ],
      discount: { kind: 'amount', value: '20' },
    });
    // 20 off 200 in proportion: 10, 5 and 5.
    expect(totals.taxes).toEqual([
      { rate: '0.0000', taxable: '45.0000', tax: '0.0000' },
      { rate: '16.0000', taxable: '135.0000', tax: '21.6000' },
    ]);
    expect(totals.total).toBe('201.6000');
  });

  it('gives what division leaves over to the earlier line when two lost the same', () => {
    const totals = totalsOf({
      currency: 'KES',
      lines: [line('1', '0.01'), line('1', '0.01'), line('1', '0.01')],
      discount: { kind: 'amount', value: '0.02' },
    });
    expect(totals.lines.map((each) => each.taxable)).toEqual(['0.0000', '0.0000', '0.0100']);
    expect(totals.total).toBe('0.0100');
  });

  it('comes to zero with no lines, and takes no discount off nothing', () => {
    expect(totalsOf({ currency: 'KES', lines: [] })).toEqual({
      lines: [],
      subtotal: '0.0000',
      lineDiscountTotal: '0.0000',
      documentDiscount: '0.0000',
      discountTotal: '0.0000',
      taxes: [],
      taxTotal: '0.0000',
      total: '0.0000',
    });
    expect(
      totalsOf({ currency: 'KES', lines: [], discount: { kind: 'percent', value: '10' } }).total,
    ).toBe('0.0000');
    // A free line: a price of zero is a price.
    expect(totalsOf({ currency: 'KES', lines: [line('1', '0', { taxRate: '16' })] }).total).toBe(
      '0.0000',
    );
  });

  it('refuses a quantity of zero, a negative price and numbers that are not decimals', () => {
    expect(issuesOf({ currency: 'KES', lines: [line('0', '10')] })).toEqual([
      {
        path: ['lines', 0, 'quantity'],
        code: 'invalid_quantity',
        message: 'Enter a quantity above zero, with at most four decimal places.',
      },
    ]);
    expect(issuesOf({ currency: 'KES', lines: [line('0.0000', '10')] })[0]?.code).toBe(
      'invalid_quantity',
    );
    expect(issuesOf({ currency: 'KES', lines: [line('-1', '10')] })[0]?.code).toBe(
      'invalid_quantity',
    );
    expect(issuesOf({ currency: 'KES', lines: [line('1', '-10')] })).toEqual([
      {
        path: ['lines', 0, 'unitPrice'],
        code: 'invalid_price',
        message: 'Enter a price of zero or more, with at most four decimal places.',
      },
    ]);
    // Every line's problems come back together, each at its own place.
    expect(
      issuesOf({
        currency: 'KES',
        lines: [line('1', '10'), line('1.00001', '1e3', { taxRate: '101' }), line('x', '10')],
      }).map((issue) => `${issue.path.join('/')}:${issue.code}`),
    ).toEqual([
      'lines/1/quantity:invalid_quantity',
      'lines/1/unitPrice:invalid_price',
      'lines/1/taxRate:invalid_tax_rate',
      'lines/2/quantity:invalid_quantity',
    ]);
    expect(
      issuesOf({ currency: 'KES', lines: [line('1', '10', { taxRate: '-1' })] })[0]?.code,
    ).toBe('invalid_tax_rate');
  });

  it('refuses a discount larger than what it comes off', () => {
    expect(
      issuesOf({
        currency: 'KES',
        lines: [line('2', '10', { discount: { kind: 'amount', value: '20.01' } })],
      }),
    ).toEqual([
      {
        path: ['lines', 0, 'discount', 'value'],
        code: 'discount_too_large',
        message: 'The discount is larger than the line it comes off.',
      },
    ]);
    expect(
      issuesOf({
        currency: 'KES',
        lines: [line('2', '10', { discount: { kind: 'percent', value: '100.0001' } })],
      })[0],
    ).toMatchObject({ code: 'discount_too_large', message: 'A discount is at most 100 percent.' });
    // The document's discount comes off what the lines net, not their amounts.
    expect(
      issuesOf({
        currency: 'KES',
        lines: [line('2', '10', { discount: { kind: 'amount', value: '5' } })],
        discount: { kind: 'amount', value: '15.01' },
      }),
    ).toEqual([
      {
        path: ['discount', 'value'],
        code: 'discount_too_large',
        message: 'The discount is larger than the document it comes off.',
      },
    ]);
    expect(
      totalsOf({
        currency: 'KES',
        lines: [line('2', '10', { discount: { kind: 'amount', value: '5' } })],
        discount: { kind: 'amount', value: '15' },
      }).total,
    ).toBe('0.0000');
  });

  it('refuses a discount that is no decimal, or an amount finer than the currency', () => {
    expect(
      issuesOf({
        currency: 'KES',
        lines: [line('1', '10', { discount: { kind: 'amount', value: '-1' } })],
      })[0],
    ).toMatchObject({ path: ['lines', 0, 'discount', 'value'], code: 'invalid_discount' });
    expect(
      issuesOf({
        currency: 'KES',
        lines: [line('1', '10', { discount: { kind: 'amount', value: '0.005' } })],
      })[0]?.code,
    ).toBe('amount_precision');
    expect(
      issuesOf({
        currency: 'JPY',
        lines: [line('1', '10')],
        discount: { kind: 'amount', value: '0.5' },
      })[0],
    ).toMatchObject({ path: ['discount', 'value'], code: 'amount_precision' });
  });

  it('refuses a currency that is not one, and a document too large to store', () => {
    expect(issuesOf({ currency: 'kes', lines: [] })).toEqual([
      {
        path: ['currency'],
        code: 'invalid_currency',
        message: 'Enter a currency code, such as KES.',
      },
    ]);
    expect(
      issuesOf({
        currency: 'KES',
        lines: [line('999999999999999', '999999999999999')],
      })[0]?.code,
    ).toBe('too_large');
    // Just inside: the largest amount there is.
    expect(totalsOf({ currency: 'KES', lines: [line('1', '999999999999999.99')] }).total).toBe(
      '999999999999999.9900',
    );
  });

  it('always adds up, whatever the lines', () => {
    // A fixed sequence of documents: the same ones every run.
    let seed = 20261012;
    const next = (below: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % below;
    };
    for (const currency of ['KES', 'JPY', 'KWD']) {
      const step = smallestUnit(currency);
      for (let run = 0; run < 300; run += 1) {
        const lines = Array.from({ length: 1 + next(6) }, () => ({
          quantity: fromUnits(BigInt(1 + next(500_000))),
          unitPrice: fromUnits(BigInt(next(90_000_000))),
          discount:
            next(3) === 0
              ? { kind: 'percent' as const, value: fromUnits(BigInt(next(1_000_001))) }
              : null,
          taxRate: [null, '0', '8', '16', '17.5'][next(5)] ?? null,
        }));
        const totals = totalsOf({
          currency,
          lines,
          discount:
            next(2) === 0 ? { kind: 'percent', value: fromUnits(BigInt(next(1_000_001))) } : null,
        });
        const sum = (values: readonly string[]): bigint =>
          values.reduce((all, one) => all + toUnits(one), 0n);
        const each = totals.lines;
        expect(sum(each.map((one) => one.amount))).toBe(toUnits(totals.subtotal));
        expect(sum(each.map((one) => one.discount))).toBe(toUnits(totals.lineDiscountTotal));
        expect(sum(each.map((one) => one.tax))).toBe(toUnits(totals.taxTotal));
        expect(sum(each.map((one) => one.total))).toBe(toUnits(totals.total));
        expect(sum(totals.taxes.map((one) => one.tax))).toBe(toUnits(totals.taxTotal));
        // The lines' shares of the document's discount are the whole of it.
        expect(sum(each.map((one) => one.net)) - sum(each.map((one) => one.taxable))).toBe(
          toUnits(totals.documentDiscount),
        );
        expect(toUnits(totals.total)).toBe(
          toUnits(totals.subtotal) - toUnits(totals.discountTotal) + toUnits(totals.taxTotal),
        );
        for (const one of each)
          for (const amount of [
            one.amount,
            one.discount,
            one.net,
            one.taxable,
            one.tax,
            one.total,
          ]) {
            expect(toUnits(amount) % step).toBe(0n);
            expect(toUnits(amount) >= 0n).toBe(true);
          }
      }
    }
  });
});
