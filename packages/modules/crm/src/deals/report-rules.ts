// The Dashboard's opportunity widgets, worked out from one count of a pipeline's deals by
// stage, status and currency. Pure: no clock, no database.
//
// The funnel follows GoHighLevel's published formula: "Opportunities in a Funnel section =
// opportunities from the current visible stage through the final visible stage, including
// applicable Won opportunities", with "Cumulative Conversion" relative to the first section
// and "Next-Step Conversion" relative to the one before. Its help does not say which won
// deals apply or where lost ones go: here a section counts the open and won deals that are
// in its stage or a later one, and lost deals are in no section.
import type { OpportunityReport } from '@repo/contracts';

/** How many deals share a stage, a status and a currency, and what they add up to. */
export interface DealGroup {
  readonly stageId: string;
  readonly status: 'open' | 'won' | 'lost';
  readonly currency: string;
  readonly count: number;
  /** A decimal with at most four places, as PostgreSQL writes a numeric. */
  readonly amount: string;
}

/** A stage of the pipeline, in the pipeline's order. */
export interface ReportStage {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
}

type Totals = OpportunityReport['statuses'][number]['totals'];

const SCALE = 10_000n;

/** A decimal amount as ten-thousandths, exactly. */
function toUnits(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0').slice(0, 4));
}

/** Ten-thousandths as a decimal with four places, as the API shows a total. */
function fromUnits(units: bigint): string {
  return `${String(units / SCALE)}.${String(units % SCALE).padStart(4, '0')}`;
}

/** The groups' deals counted, and their amounts added by currency, in the order of the codes. */
export function tally(groups: readonly DealGroup[]): { count: number; totals: Totals } {
  const sums = new Map<string, bigint>();
  for (const group of groups)
    sums.set(group.currency, (sums.get(group.currency) ?? 0n) + toUnits(group.amount));
  return {
    count: groups.reduce((total, group) => total + group.count, 0),
    totals: [...sums]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, units]) => ({ currency, amount: fromUnits(units) })),
  };
}

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

type Widgets = Pick<OpportunityReport, 'count' | 'statuses' | 'conversion' | 'funnel' | 'stages'>;

/**
 * Every widget's numbers. `stages` is the whole pipeline in order, archived stages
 * included: a deal still in one is counted where it is.
 */
export function opportunityWidgets(
  stages: readonly ReportStage[],
  groups: readonly DealGroup[],
): Widgets {
  const position = new Map(stages.map((stage, index) => [stage.id, index]));
  const of = (status: DealGroup['status']) => groups.filter((group) => group.status === status);
  const won = tally(of('won'));
  const all = tally(groups);

  // A deal is in a section when its stage is that section's or a later one.
  const inFunnel = groups.filter((group) => group.status !== 'lost');
  const sections = stages
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => !stage.archived)
    .map(({ stage, index }) => ({
      stage,
      ...tally(inFunnel.filter((group) => (position.get(group.stageId) ?? -1) >= index)),
    }));
  const first = sections[0]?.count ?? 0;

  const open = of('open');
  return {
    count: all.count,
    statuses: (['open', 'won', 'lost'] as const).map((status) => ({
      status,
      ...tally(of(status)),
    })),
    conversion: {
      won: won.count,
      total: all.count,
      rate: ratio(won.count, all.count),
      wonTotals: won.totals,
    },
    funnel: sections.map((section, index) => ({
      stageId: section.stage.id,
      name: section.stage.name,
      count: section.count,
      totals: section.totals,
      cumulativeRate: ratio(section.count, first),
      nextStepRate: index === 0 ? null : ratio(section.count, sections[index - 1]?.count ?? 0),
    })),
    stages: stages.flatMap((stage) => {
      const held = open.filter((group) => group.stageId === stage.id);
      // An archived stage is listed only while an open deal is still in it.
      if (stage.archived && held.length === 0) return [];
      return [{ stageId: stage.id, name: stage.name, archived: stage.archived, ...tally(held) }];
    }),
  };
}
