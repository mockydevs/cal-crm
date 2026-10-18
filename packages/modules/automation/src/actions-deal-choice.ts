// Which deal a deal.move or deal.close step acts on, what it asks the CRM to change, and
// the amount a deal.create step takes from a field. No database here, so each rule can be
// read and tested on its own.
import {
  attributionPath,
  DEAL_SOURCE_MAX_LENGTH,
  type ConditionValue,
  type ConditionValues,
  type Deal,
} from '@repo/contracts';
import { isAmount } from '@repo/kernel';

type DealChoiceInput = Pick<Deal, 'status' | 'pipelineId' | 'trashedAt'>;

export type DealChoice<T> =
  | { readonly ok: true; readonly deal: T }
  | {
      readonly ok: false;
      readonly code: 'no_open_deal' | 'several_open_deals';
      readonly explanation: string;
    };

/**
 * The contact's one open deal, in the pipeline when the step names or implies one. With
 * none there is nothing to act on, and with several nothing says which is meant, so both
 * fail the step rather than guess: a deal moved or closed by mistake can't be told apart
 * from one a person moved.
 */
export function chooseDeal<T extends DealChoiceInput>(
  deals: readonly T[],
  pipelineId?: string,
): DealChoice<T> {
  const open = deals.filter(
    (deal) =>
      deal.status === 'open' &&
      deal.trashedAt === null &&
      (pipelineId === undefined || deal.pipelineId === pipelineId),
  );
  const where = pipelineId === undefined ? '' : " in the step's pipeline";
  const [only] = open;
  if (only === undefined)
    return {
      ok: false,
      code: 'no_open_deal',
      explanation: `The contact has no open deal${where}.`,
    };
  if (open.length > 1)
    return {
      ok: false,
      code: 'several_open_deals',
      explanation: `The contact has more than one open deal${where}, so the step can't tell which is meant.`,
    };
  return { ok: true, deal: only };
}

export type DealValues = Pick<
  Deal,
  | 'id'
  | 'revision'
  | 'name'
  | 'pipelineId'
  | 'stageId'
  | 'amount'
  | 'currency'
  | 'expectedCloseDate'
  | 'status'
  | 'outcomeReason'
>;

/**
 * The deal as the CRM's update command takes it, with the step's change. The command
 * replaces every value, so the ones the step leaves alone are sent back as they were read,
 * with the revision that makes the CRM refuse if the deal changed in between.
 */
export function dealUpdate(
  deal: DealValues,
  change: Partial<
    Pick<
      Deal,
      | 'pipelineId'
      | 'stageId'
      | 'status'
      | 'outcomeReason'
      | 'name'
      | 'amount'
      | 'expectedCloseDate'
      | 'source'
    >
  >,
): DealValues & { source?: string | null | undefined } {
  return {
    id: deal.id,
    revision: deal.revision,
    name: deal.name,
    pipelineId: deal.pipelineId,
    stageId: deal.stageId,
    amount: deal.amount,
    currency: deal.currency,
    expectedCloseDate: deal.expectedCloseDate,
    status: deal.status,
    outcomeReason: deal.outcomeReason,
    ...change,
  };
}

/** Where an opportunity step takes the source from, as the document writes it. */
export type DealSourceSetting = string | { readonly from: 'arrival' } | null | undefined;

/**
 * What a deal.create step's source setting comes to. A step at version 2 that names no
 * source takes it from how the lead arrived; one stored at version 1, before the setting
 * existed, names none and gets none, as it always did.
 */
export function createdDealSource(
  setting: DealSourceSetting,
  typeVersion: number | undefined,
): DealSourceSetting {
  return setting === undefined && (typeVersion ?? 1) >= 2 ? { from: 'arrival' } : setting;
}

const ARRIVAL_SOURCE = attributionPath('trigger', 'source');

/**
 * How the lead arrived, as an opportunity's source: the lead source of the touch that
 * started the run (the form submission's, the booking's), else the contact's own Source.
 * Nothing when the run has neither: a source is never made up.
 */
export function arrivalSource(values: ConditionValues): string | undefined {
  for (const path of [ARRIVAL_SOURCE, 'contact.source']) {
    const held = values[path];
    if (typeof held === 'string' && held.trim() !== '')
      return held.trim().slice(0, DEAL_SOURCE_MAX_LENGTH);
  }
  return undefined;
}

/** The amount a deal.create step read from the contact's field. */
export interface FieldAmount {
  /** As the CRM takes an amount: decimal text, or null for a deal without one. */
  readonly amount: string | null;
  /** Why there is no amount, for the step's explanation. Absent when there is one. */
  readonly note?: string;
}

/**
 * The deal's amount from what the field holds. A deal's amount is zero or more, exact to
 * four decimal places, so a number is rounded to four. A field with nothing in it, or with
 * something no deal can take as an amount, gives a deal without one and says so: the deal is
 * still wanted, and its amount can be filled in by a person.
 */
export function amountFromField(path: string, value: ConditionValue | undefined): FieldAmount {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === ''))
    return { amount: null, note: `${path} has nothing in it, so the deal has no amount.` };
  const amount =
    typeof value === 'number'
      ? // Rounded to four places, then without the zeros that rounding leaves behind.
        (Number.isFinite(value) ? value.toFixed(4) : '').replace(/\.?0+$/, '')
      : typeof value === 'string'
        ? value.trim()
        : '';
  if (isAmount(amount) && !amount.startsWith('-')) return { amount };
  const held = typeof value === 'object' ? value.join(', ') : String(value);
  return {
    amount: null,
    note: `${path} holds "${held}", which is not an amount a deal can have, so the deal has no amount.`,
  };
}
