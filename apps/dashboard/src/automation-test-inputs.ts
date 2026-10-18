// What a test of a workflow can be told beside the contact (POST /automations/{id}/test-runs):
// sample values for the fields the workflow reads, and events that happen during its waits.
// Pure rules: which fields and events the draft asks about, and how what was typed is sent.
import type { AutomationSetup } from '@repo/contracts';
import { isRecord, stepsOf, stopsOf, type Draft } from './automation-document';

const FIELD_PATH = /^[a-z][a-z_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const MERGE_FIELD = /\{\{\s*((?:contact|deal)\.[A-Za-z0-9_.]+)\s*\}\}/g;

/**
 * The fields the draft reads, in the order it first reads them: every condition's field,
 * and every contact or deal merge field in its text.
 */
export function fieldsRead(draft: Draft): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(MERGE_FIELD))
        if (match[1] !== undefined) found.add(match[1]);
      return;
    }
    if (Array.isArray(value)) {
      for (const each of value) walk(each);
      return;
    }
    if (!isRecord(value)) return;
    const { field } = value;
    if (typeof field === 'string' && FIELD_PATH.test(field) && 'operator' in value)
      found.add(field);
    for (const each of Object.values(value)) walk(each);
  };
  walk(draft['triggers']);
  walk(draft['steps']);
  walk(draft['stopWhen']);
  return [...found];
}

/**
 * The events the draft waits for or stops on, in the order it names them: its stop
 * conditions, what its waits wait for, and what meets its goal. A simulated event of any
 * other kind would change nothing in a test.
 */
export function eventsAwaited(draft: Draft): string[] {
  const found = new Set<string>();
  for (const stop of stopsOf(draft)) if (stop.event !== '') found.add(stop.event);
  for (const step of stepsOf(draft)) {
    const { event, events } = step.config;
    if (step.type === 'wait.event' && typeof event === 'string') found.add(event);
    if (step.type === 'goal' && Array.isArray(events))
      for (const each of events as readonly unknown[])
        if (isRecord(each) && typeof each['type'] === 'string') found.add(each['type']);
  }
  return [...found];
}

export type SampleValue = string | number | boolean | string[];

/**
 * What was typed for a field, as the value the test is given: a number for a number field,
 * yes or no for a checkbox, a list for a field that holds several (and for tags), and the
 * text as it is otherwise. Nothing for an empty box.
 */
export function sampleValueOf(
  path: string,
  typed: string,
  setup: AutomationSetup,
): SampleValue | undefined {
  const text = typed.trim();
  if (text === '') return undefined;
  const key = path.split('.').at(-1) ?? path;
  const owner = path.startsWith('deal.') ? setup.fields.deal : setup.fields.contact;
  const type = owner.find((field) => field.key === key || field.aliases.includes(key))?.type;
  if (type === 'multi_choice' || type === 'tags' || path === 'contact.tags')
    return text
      .split(',')
      .map((each) => each.trim())
      .filter((each) => each !== '');
  if (type === 'number' || type === 'money') {
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
  }
  if (type === 'boolean') {
    if (/^(yes|true)$/i.test(text)) return true;
    if (/^(no|false)$/i.test(text)) return false;
  }
  return text;
}

// An ISO 8601 length of time, as the contract's `after` takes it. Written here so the test
// dialog doesn't bring in every step's form with the one function it would borrow.
const afterOf = (amount: number, unit: EventRow['unit']): string =>
  unit === 'days' ? `P${String(amount)}D` : `PT${String(amount)}${unit === 'hours' ? 'H' : 'M'}`;

export interface SampleRow {
  readonly field: string;
  readonly value: string;
}
export interface EventRow {
  readonly event: string;
  readonly amount: number | undefined;
  readonly unit: 'minutes' | 'hours' | 'days';
}

/** The body of the test request: only what was filled in, as the contract takes it. */
export function testRunBody(
  contactId: string | undefined,
  samples: readonly SampleRow[],
  events: readonly EventRow[],
  setup: AutomationSetup,
): {
  contactId?: string;
  values?: Record<string, SampleValue>;
  events?: { event: string; after: string }[];
} {
  const values: Record<string, SampleValue> = {};
  for (const row of samples) {
    const value = row.field === '' ? undefined : sampleValueOf(row.field, row.value, setup);
    if (value !== undefined) values[row.field] = value;
  }
  const happening = events.flatMap((row) =>
    row.event === '' || row.amount === undefined || row.amount < 1
      ? []
      : [{ event: row.event, after: afterOf(Math.trunc(row.amount), row.unit) }],
  );
  return {
    ...(contactId === undefined ? {} : { contactId }),
    ...(Object.keys(values).length === 0 ? {} : { values }),
    ...(happening.length === 0 ? {} : { events: happening }),
  };
}
