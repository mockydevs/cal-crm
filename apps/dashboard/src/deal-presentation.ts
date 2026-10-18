import type { Deal, Pipeline } from '@repo/contracts';

type Priced = Pick<Deal, 'amount' | 'currency'>;

/** How a stage's colour is drawn: as a dot before its name, or as a tint behind it. */
export interface StageMark {
  readonly dot?: string;
  readonly tint?: string;
}

const NO_MARK: StageMark = {};

/**
 * What the pipeline says to draw for one of its stages: nothing when the pipeline draws no
 * colours or the stage has none; else the stage's colour as a dot, or mixed thin enough to
 * sit behind text as a tint.
 */
export function stageMarkOf(
  pipeline: Pick<Pipeline, 'colorStyle' | 'stages'> | undefined,
  stageId: string,
): StageMark {
  const style = pipeline?.colorStyle ?? 'none';
  const color = pipeline?.stages.find((stage) => stage.id === stageId)?.color;
  if (style === 'none' || color === undefined || color === null) return NO_MARK;
  return style === 'dot'
    ? { dot: color }
    : { tint: ['color-mix(in', 'srgb,', color, '16%,', 'transparent)'].join(' ') };
}

/**
 * The chance of winning an opportunity shows, in percent: its own where the pipeline says
 * opportunities carry theirs, else its stage's. Undefined when none is set.
 */
export function probabilityOf(
  pipeline: Pick<Pipeline, 'dealProbability' | 'stages'>,
  deal: Pick<Deal, 'stageId' | 'probability'>,
): number | undefined {
  const own = pipeline.dealProbability === true;
  const stage = pipeline.stages.find((each) => each.id === deal.stageId);
  return (own ? deal.probability : stage?.probability) ?? undefined;
}

// Preserve all four decimal places without converting money to a floating-point number.
export function amountOf(deal: Priced): string {
  if (deal.amount === null) return '—';
  const [whole = '0', fraction] = deal.amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return [deal.currency, fraction === undefined ? grouped : [grouped, fraction].join('.')].join(
    ' ',
  );
}

/** The most decimal places an amount has (the contract's limit). */
const PLACES = 4;

/**
 * What the opportunities of a stage are worth together: one total for each currency, in the
 * order of their codes, written as amountOf writes a value. Added as whole ten-thousandths,
 * so no decimal place is lost; an opportunity with no value adds nothing.
 */
export function stageTotals(deals: readonly Priced[]): string[] {
  const sums = new Map<string, { units: bigint; places: number }>();
  for (const { amount, currency } of deals) {
    if (amount === null) continue;
    const [whole = '0', fraction = ''] = amount.split('.');
    const sum = sums.get(currency) ?? { units: 0n, places: 0 };
    sums.set(currency, {
      units: sum.units + BigInt(`${whole}${fraction.padEnd(PLACES, '0')}`),
      places: Math.max(sum.places, fraction.length),
    });
  }
  return [...sums]
    .toSorted(([one], [other]) => one.localeCompare(other))
    .map(([currency, { units, places }]) => {
      const digits = units.toString().padStart(PLACES + 1, '0');
      const whole = digits.slice(0, -PLACES);
      const fraction = digits.slice(-PLACES).slice(0, places);
      return amountOf({ currency, amount: places === 0 ? whole : `${whole}.${fraction}` });
    });
}
