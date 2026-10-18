// What the contact list's bulk action dialogs work out before they send: when an action
// runs (now, later, or in drip mode, as GoHighLevel offers it), how long a drip takes, and
// which contacts the action is for: the ones ticked, or every one the list holds.
import {
  CONTACT_BULK_DRIP_BATCH_MAX,
  CONTACT_BULK_DRIP_INTERVAL_MAX,
  type ContactBulkDelivery,
  type ContactBulkSelection,
  type ContactFilter,
  type FieldListOptions,
} from '@repo/contracts';

export type DeliveryMode = 'now' | 'later' | 'drip';
export type IntervalUnit = 'minutes' | 'hours' | 'days';

const MINUTES: Readonly<Record<IntervalUnit, number>> = { minutes: 1, hours: 60, days: 24 * 60 };

/** The delivery part of a dialog, as typed. */
export interface DeliveryForm {
  readonly mode: DeliveryMode;
  /** A datetime-local value, in the reader's own time: when to start, for later and drip. */
  readonly startAt: string;
  readonly batchSize: string;
  readonly every: string;
  readonly unit: IntervalUnit;
}

export const deliveryDefaults: DeliveryForm = {
  mode: 'now',
  startAt: '',
  batchSize: '100',
  every: '1',
  unit: 'hours',
};

/** What is wrong with a delivery as typed, by the field to put right. */
export type DeliveryProblem = 'start_required' | 'start_invalid' | 'batch' | 'interval';

const whole = (text: string): number | undefined =>
  /^\d{1,9}$/.test(text.trim()) ? Number(text.trim()) : undefined;

/**
 * The delivery the request sends, or what is wrong with it. Now sends none. A start time is
 * read in the reader's own time zone, as the browser's date and time box gives it.
 */
export function deliveryOf(
  form: DeliveryForm,
): { readonly delivery?: ContactBulkDelivery } | { readonly problem: DeliveryProblem } {
  if (form.mode === 'now') return {};
  let startAt: string | undefined;
  if (form.startAt.trim() !== '') {
    const at = new Date(form.startAt);
    if (Number.isNaN(at.getTime())) return { problem: 'start_invalid' };
    startAt = at.toISOString();
  }
  if (form.mode === 'later') {
    if (startAt === undefined) return { problem: 'start_required' };
    return { delivery: { startAt } };
  }
  const batchSize = whole(form.batchSize);
  if (batchSize === undefined || batchSize < 1 || batchSize > CONTACT_BULK_DRIP_BATCH_MAX)
    return { problem: 'batch' };
  const every = whole(form.every);
  const intervalMinutes = every === undefined ? undefined : every * MINUTES[form.unit];
  if (
    intervalMinutes === undefined ||
    intervalMinutes < 1 ||
    intervalMinutes > CONTACT_BULK_DRIP_INTERVAL_MAX
  )
    return { problem: 'interval' };
  return {
    delivery: {
      ...(startAt === undefined ? {} : { startAt }),
      drip: { batchSize, intervalMinutes },
    },
  };
}

/**
 * How long a drip takes from its first batch to its last, in minutes, as GoHighLevel's
 * "estimated duration" reckons it: one wait between each two batches.
 */
export function dripMinutes(count: number, batchSize: number, intervalMinutes: number): number {
  if (count <= 0 || batchSize <= 0) return 0;
  return (Math.ceil(count / batchSize) - 1) * intervalMinutes;
}

/** The filters of the list as a bulk action takes them for "every contact". */
export interface ListSelection extends FieldListOptions {
  readonly q: string;
  readonly createdFrom: string | undefined;
  /** The Filters panel's conditions, such as Email verification. */
  readonly filter?: ContactFilter;
}

/**
 * The contacts an action is for: the ones ticked, or every one the list holds less the ones
 * unticked since. Every one keeps the list's search and filters, so the server counts the
 * same contacts the list shows.
 */
export function selectionOf(
  chosen:
    | { readonly kind: 'ids'; readonly ids: readonly string[] }
    | { readonly kind: 'all'; readonly list: ListSelection; readonly except: readonly string[] },
): ContactBulkSelection {
  if (chosen.kind === 'ids') return { ids: [...chosen.ids] };
  const { list } = chosen;
  return {
    all: true,
    ...(list.q === '' ? {} : { q: list.q }),
    ...(list.createdFrom === undefined ? {} : { createdFrom: list.createdFrom }),
    ...(list.fieldId === undefined ? {} : { fieldId: list.fieldId }),
    ...(list.fieldOperator === undefined ? {} : { fieldOperator: list.fieldOperator }),
    ...(list.fieldValue === undefined ? {} : { fieldValue: list.fieldValue }),
    ...(list.filter === undefined ? {} : { filter: list.filter }),
    ...(chosen.except.length === 0 ? {} : { except: [...chosen.except] }),
  };
}
