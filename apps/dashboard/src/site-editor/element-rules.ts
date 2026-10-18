// What the panel works out about an element from its props and from what the business
// has: when a popup opens, and whether the calendar a calendar element names can take a
// booking. Plain functions over plain values; the page document's own names throughout
// (packages/contracts, sites-document.ts).

/** How a popup opens: from a link or a button only, or also by itself. */
export type PopupTrigger = 'none' | 'delay' | 'exit';
/** How often a popup that opens by itself does so. */
export type PopupFrequency = 'session' | 'always';

export interface PopupOpening {
  readonly trigger: PopupTrigger;
  /** How long after the page is shown a popup with `delay` opens. */
  readonly delaySeconds: number;
  readonly frequency: PopupFrequency;
}

const TRIGGERS: readonly PopupTrigger[] = ['none', 'delay', 'exit'];
export const MAX_DELAY_SECONDS = 3600;

/** When a popup opens, read from its props: what the document leaves out is its default. */
export function openingOf(props: Readonly<Record<string, unknown>>): PopupOpening {
  const trigger = TRIGGERS.find((each) => each === props['trigger']) ?? 'none';
  const delay = props['delaySeconds'];
  return {
    trigger,
    delaySeconds:
      typeof delay === 'number' && Number.isInteger(delay) && delay >= 0
        ? Math.min(MAX_DELAY_SECONDS, delay)
        : 0,
    // Once in a visit is what a popup does when the document says nothing.
    frequency: props['frequency'] === 'always' ? 'always' : 'session',
  };
}

/**
 * The props to set for a change to when a popup opens. `frequency` is kept only where it
 * says something: a popup that opens from a link alone has none, and "once in a visit" is
 * the default, so both take the key off (undefined). A popup that starts opening after a
 * delay with no delay set waits five seconds, not none: a popup over a page the visitor
 * has not yet seen is rarely meant.
 */
export function openingPatch(
  props: Readonly<Record<string, unknown>>,
  change: Partial<PopupOpening>,
): Readonly<Record<string, unknown>> {
  const now = openingOf(props);
  const next = { ...now, ...change };
  const delaySeconds =
    change.trigger === 'delay' && now.trigger !== 'delay' && now.delaySeconds === 0
      ? 5
      : next.delaySeconds;
  return {
    trigger: next.trigger,
    delaySeconds,
    frequency: next.trigger === 'none' || next.frequency === 'session' ? undefined : 'always',
  };
}

/** A calendar of the business, as far as a page cares. */
export interface CalendarChoice {
  readonly id: string;
  readonly name: string;
  /** Whether it takes bookings: an inactive calendar has no booking page. */
  readonly active: boolean;
}

/** Where a calendar element stands: ready to publish, or why not. */
export type CalendarState =
  | { readonly at: 'none' }
  | { readonly at: 'gone' }
  | { readonly at: 'inactive'; readonly name: string }
  | { readonly at: 'ready'; readonly name: string };

export function calendarStateOf(
  calendarId: unknown,
  calendars: ReadonlyMap<string, CalendarChoice>,
): CalendarState {
  if (typeof calendarId !== 'string' || calendarId === '') return { at: 'none' };
  const found = calendars.get(calendarId);
  if (found === undefined) return { at: 'gone' };
  return found.active ? { at: 'ready', name: found.name } : { at: 'inactive', name: found.name };
}

/** What a published page's link to a calendar says when the element gives no words of its own. */
export const DEFAULT_CALENDAR_LABEL = 'Book a time';

/** The words of a calendar element's link: its own, or the page's default. */
export function calendarLabelOf(label: unknown): string {
  return typeof label === 'string' && label.trim() !== '' ? label.trim() : DEFAULT_CALENDAR_LABEL;
}

/** One thing in the way of a page, as the editor keeps them. */
interface Problem {
  readonly message: string;
  readonly nodeId: string | null;
  /** True for what stops a save or a publish; false for something only worth a look. */
  readonly blocking: boolean;
}

/** What is said of one element: a sentence, and whether it stops the page. */
export interface ElementProblem {
  readonly message: string;
  readonly blocking: boolean;
}

/**
 * What is wrong with each element, by the id the saved page knows it by: each sentence
 * once, and as blocking if any list says it blocks.
 */
export function problemsByNode(
  ...lists: readonly (readonly Problem[] | undefined)[]
): ReadonlyMap<string, readonly ElementProblem[]> {
  const found = new Map<string, ElementProblem[]>();
  for (const list of lists)
    for (const problem of list ?? []) {
      if (problem.nodeId === null) continue;
      const said = found.get(problem.nodeId) ?? [];
      const at = said.findIndex((each) => each.message === problem.message);
      const blocking = problem.blocking || said[at]?.blocking === true;
      if (at === -1) said.push({ message: problem.message, blocking });
      else said[at] = { message: problem.message, blocking };
      found.set(problem.nodeId, said);
    }
  return found;
}
