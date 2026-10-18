// What the Dashboard's email and booking widgets work out apart from the screen.

/** The height of each day's bar, out of 40, with the tallest day full and an empty day a sliver. */
export function dayBars(values: readonly number[]): number[] {
  const most = Math.max(0, ...values);
  if (most === 0) return [];
  return values.map((value) => (value === 0 ? 1 : Math.max(2, Math.round((value / most) * 40))));
}

/** The first rows as they came, and the rest added up under one name. */
export function topRows(
  rows: readonly { readonly name: string; readonly count: number }[],
  most: number,
  rest: string,
): { name: string; count: number }[] {
  if (rows.length <= most) return rows.map((row) => ({ ...row }));
  const others = rows.slice(most - 1).reduce((sum, row) => sum + row.count, 0);
  return [...rows.slice(0, most - 1).map((row) => ({ ...row })), { name: rest, count: others }];
}

/** A reason this install has no words for yet, readable: delivery_rejected as "delivery rejected". */
export function reasonKey(reason: string): string {
  return reason.replace(/[._]/g, ' ');
}
