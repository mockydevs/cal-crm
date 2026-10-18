// A test run of the steps that find, create and change a deal: which deal each would act
// on is said, and the deal the run has in hand is kept in the run's own values, so later
// conditions and merge fields read it as they would in a real run. Nothing is read from
// the database here: what each deal.find step would find now is handed in (test-runs.ts).
import type { AutomationStep, ConditionValue, ConditionValues } from '@repo/contracts';

import {
  amountFromField,
  arrivalSource,
  createdDealSource,
  type DealSourceSetting,
} from './actions-deal-choice.js';
import { mergedText } from './actions-text.js';
import { searchWords } from './deal-find.js';

/** A deal as a test run knows it: its id, real or made up, and its values by path. */
export interface SimulatedDeal {
  readonly id: string;
  readonly values: Readonly<Record<string, ConditionValue>>;
}

/** What a test run is told about the business's deals before it starts. */
export interface SimulatedDeals {
  /**
   * What each deal.find step would find for the contact as things are now, by the step's
   * key: the deal, or null when none passes. A step left out finds nothing.
   */
  readonly found: Readonly<Record<string, SimulatedDeal | null>>;
  /** The names of the business's pipelines and stages, by id. */
  readonly names?: Readonly<Record<string, string>>;
}

export type DealStep = Extract<
  AutomationStep,
  { type: 'deal.find' | 'deal.create' | 'deal.move' | 'deal.close' | 'deal.update' }
>;

export const isDealStep = (step: AutomationStep): step is DealStep =>
  step.type === 'deal.find' ||
  step.type === 'deal.create' ||
  step.type === 'deal.move' ||
  step.type === 'deal.close' ||
  step.type === 'deal.update';

export interface DealSimulation {
  readonly explanation: string;
  /** The branch a deal.find takes. */
  readonly branch?: 'found' | 'not_found';
  readonly output?: Readonly<Record<string, string>>;
  /** The deal the run has in hand after the step, when the step changes that. */
  readonly inHand?: SimulatedDeal;
}

const NOTHING = 'Nothing is changed in a test run.';
const UNKNOWN =
  "the contact's one open deal: which deal that is, and whether there is exactly one, is read when the step really runs";

const nameOf = (deal: SimulatedDeal): string => String(deal.values['deal.name'] ?? deal.id);

// As a real run works it out (actions-deals.ts): text filled in, none, or the arrival.
const sourceOf = (
  setting: DealSourceSetting,
  values: ConditionValues,
): string | null | undefined =>
  setting === undefined || setting === null
    ? setting
    : typeof setting === 'string'
      ? mergedText({ title: setting, notes: '' }, values).title
      : arrivalSource(values);

/**
 * What a deal step would do in a test run. Throws the refusal a real run would meet where
 * it can be known here, such as a name with a merge field that has no value.
 */
export function simulateDealStep(
  step: DealStep,
  key: string,
  values: ConditionValues,
  inHand: SimulatedDeal | undefined,
  known: SimulatedDeals | undefined,
  sequence: number,
): DealSimulation {
  const names = known?.names ?? {};
  if (step.type === 'deal.find') {
    const found = known?.found[key] ?? undefined;
    const words = searchWords(step.config);
    if (found === undefined)
      return {
        branch: 'not_found',
        explanation:
          known === undefined
            ? `Would look for the ${step.config.which} of the contact's deals that pass (${words}). A test run without a contact has no deals to look through, so it takes the not_found branch.`
            : `None of the contact's deals passes now (${words}), so it takes the not_found branch.`,
      };
    return {
      branch: 'found',
      output: { dealId: found.id },
      inHand: found,
      explanation: `Would find "${nameOf(found)}", the ${step.config.which} of the contact's deals that pass now (${words}), and take it in hand: the deal steps after it act on it.`,
    };
  }
  if (step.type === 'deal.create') {
    const { config } = step;
    const name =
      config.name === undefined
        ? (values['contact.name'] ?? values['contact.email'] ?? values['contact.phone'] ?? null)
        : mergedText({ title: config.name, notes: '' }, values).title;
    const amount =
      config.amount ??
      (config.amountFrom === undefined
        ? null
        : amountFromField(config.amountFrom, values[config.amountFrom]).amount);
    const source = sourceOf(createdDealSource(config.source, step.typeVersion), values);
    const made: SimulatedDeal = {
      id: `simulated:deal:${key}:${String(sequence)}`,
      values: {
        'deal.name': name,
        'deal.status': 'open',
        'deal.pipeline': names[config.pipeline] ?? config.pipeline,
        'deal.stage': names[config.stage] ?? config.stage,
        'deal.value': amount === null ? null : Number(amount),
        'deal.amount': amount === null ? null : Number(amount),
        'deal.source': source ?? null,
      },
    };
    return {
      output: { dealId: made.id },
      inHand: made,
      explanation: `Would create deal${typeof source === 'string' ? ` with the source "${source}"` : ''}; nothing is sent or changed in a test run. The run would have it in hand: the deal steps after it act on it.`,
    };
  }
  const target =
    inHand === undefined ? UNKNOWN : `"${nameOf(inHand)}", the deal the run has in hand`;
  if (step.type === 'deal.move')
    return {
      explanation: `Would move ${target}, to the stage. ${NOTHING}`,
      ...(inHand === undefined
        ? {}
        : {
            inHand: {
              id: inHand.id,
              values: {
                ...inHand.values,
                'deal.stage': names[step.config.stage] ?? step.config.stage,
                ...(step.config.pipeline === undefined
                  ? {}
                  : { 'deal.pipeline': names[step.config.pipeline] ?? step.config.pipeline }),
              },
            },
          }),
    };
  if (step.type === 'deal.close')
    return {
      explanation: `Would close ${target}, as ${step.config.outcome}. ${NOTHING}`,
      ...(inHand === undefined
        ? {}
        : {
            inHand: {
              id: inHand.id,
              values: { ...inHand.values, 'deal.status': step.config.outcome },
            },
          }),
    };
  const { config } = step;
  const changes: Record<string, ConditionValue> = {};
  if (config.name !== undefined)
    changes['deal.name'] = mergedText({ title: config.name, notes: '' }, values).title;
  if (config.amount !== undefined) {
    changes['deal.value'] = config.amount;
    changes['deal.amount'] = config.amount;
  } else if (config.amountFrom !== undefined) {
    const { amount } = amountFromField(config.amountFrom, values[config.amountFrom]);
    if (amount !== null) {
      changes['deal.value'] = Number(amount);
      changes['deal.amount'] = Number(amount);
    }
  }
  const source = sourceOf(config.source, values);
  // "From how they arrived" in a run nothing arrived with leaves the source as it is.
  if (source !== undefined) changes['deal.source'] = source;
  if (typeof config.expectedCloseDate === 'string' || config.expectedCloseDate === null)
    changes['deal.expectedCloseDate'] = config.expectedCloseDate;
  if (config.status === 'open') changes['deal.status'] = 'open';
  for (const [path, value] of Object.entries(config.fields ?? {})) changes[path] = value;
  const named = [
    ...Object.keys(changes).map((path) => path.replace(/^deal\.(custom\.)?/, '')),
    ...(config.owner === undefined ? [] : ['owner']),
    ...(typeof config.expectedCloseDate === 'object' && config.expectedCloseDate !== null
      ? ['expectedCloseDate']
      : []),
  ].filter((each, index, all) => each !== 'amount' && all.indexOf(each) === index);
  return {
    output: { dealId: inHand?.id ?? `simulated:deal:${key}:${String(sequence)}` },
    explanation: `Would update ${target}: ${named.length === 0 ? 'nothing it names would differ' : named.join(', ')}. ${NOTHING}`,
    ...(inHand === undefined
      ? {}
      : { inHand: { id: inHand.id, values: { ...inHand.values, ...changes } } }),
  };
}
