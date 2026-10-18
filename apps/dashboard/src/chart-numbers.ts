// How a report's numbers are written and measured, for the Dashboard's widgets and for
// Reporting's charts alike: a rate as a percentage, a sum with its currency, and the share
// of a track a bar fills. Apart from the Dashboard's other rules (dashboard-report-rules.ts,
// which gives these out again) so Reporting's pages bring only this much with them.

/** A rate from 0 to 1 as a percentage. A dash when the report has none. */
export function percentText(rate: number | null, places = 2): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(places)}%`;
}

/**
 * A sum with its currency, exact: the digits are the server's, grouped in thousands, with
 * the empty decimal places dropped (and two kept when any is used).
 */
export function moneyText({
  currency,
  amount,
}: {
  readonly currency: string;
  readonly amount: string;
}): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const used = fraction.replace(/0+$/, '');
  return `${currency} ${used === '' ? grouped : `${grouped}.${used.padEnd(2, '0')}`}`;
}

/** How much of the track a bar fills, from 0 to 100, to two places. */
export function barShare(value: number, longest: number): number {
  if (!(longest > 0) || !(value > 0)) return 0;
  return Math.round(Math.min(value / longest, 1) * 10_000) / 100;
}
