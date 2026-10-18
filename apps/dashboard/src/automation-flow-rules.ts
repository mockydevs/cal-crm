// The rules behind the flow-control forms: an If / else's own branches, kept in the order
// they are tried; the events that meet a goal, each with the filters its trigger has; and
// where a refusal about a whole step is said. The contract checks what these build; nothing
// here decides what is valid.
import {
  automationGoalEvents,
  CONDITION_FALLBACK,
  MAX_CONDITION_BRANCHES,
  MAX_GOAL_EVENTS,
} from '@repo/contracts';
import { isRecord } from './automation-document';
import { fieldsOf, type FieldSpec } from './automation-fields';

export interface Branch {
  /** Its key in the document: what `next` names, and what a run's history keeps. */
  readonly name: string;
  /** What it is called on screen; nothing while it goes by its key. */
  readonly label: string | undefined;
  readonly if: unknown;
}

/** The branches a condition has of its own, in the order they are tried. */
export function branchesOf(config: Readonly<Record<string, unknown>>): Branch[] {
  const written: readonly unknown[] = Array.isArray(config['branches']) ? config['branches'] : [];
  return written.flatMap((each) =>
    isRecord(each) && typeof each['name'] === 'string'
      ? [
          {
            name: each['name'],
            label: typeof each['label'] === 'string' ? each['label'] : undefined,
            if: each['if'],
          },
        ]
      : [],
  );
}

/** A branch as the document holds it: no label member while it has none. */
const written = (branch: Branch): Record<string, unknown> => ({
  name: branch.name,
  ...(branch.label === undefined || branch.label.trim() === '' ? {} : { label: branch.label }),
  ...(branch.if === undefined ? {} : { if: branch.if }),
});

export const writtenBranches = (branches: readonly Branch[]): Record<string, unknown>[] =>
  branches.map(written);

/** A key no branch has yet: branch_1, branch_2 and so on; never the fallback's. */
export function newBranchName(taken: readonly string[]): string {
  for (let number = taken.length + 1; ; number += 1) {
    const name = `branch_${String(number)}`;
    if (!taken.includes(name) && name !== CONDITION_FALLBACK) return name;
  }
}

/** Whether another branch can be added: ten is the most a condition holds. */
export const canAddBranch = (branches: readonly unknown[]): boolean =>
  branches.length < MAX_CONDITION_BRANCHES;

/** One more branch, last before the fallback, with one condition to fill in. */
export function withBranch(branches: readonly Branch[]): Branch[] {
  if (!canAddBranch(branches)) return [...branches];
  const name = newBranchName(branches.map((each) => each.name));
  return [...branches, { name, label: undefined, if: { field: '', operator: 'equals' } }];
}

/** The branch one place earlier or later; as it was when there is no such place. */
export function movedBranch(branches: readonly Branch[], index: number, by: -1 | 1): Branch[] {
  const to = index + by;
  const moved = branches[index];
  const other = branches[to];
  if (moved === undefined || other === undefined) return [...branches];
  return branches.map((each, place) => (place === index ? other : place === to ? moved : each));
}

/**
 * A condition with yes and no, as one with branches of its own: the condition becomes the
 * branch `yes`, and what was the no path is the fallback's (the builder moves `next` to
 * match: yes stays, no becomes none).
 */
export function namedFrom(condition: unknown): Branch[] {
  return [{ name: 'yes', label: undefined, if: condition }];
}

export type GoalEventType = (typeof automationGoalEvents)[number];

export interface GoalEvent {
  readonly type: string;
  readonly config: Readonly<Record<string, unknown>>;
}

/** The events a goal lists, as written. */
export function goalEventsOf(value: unknown): GoalEvent[] {
  const written: readonly unknown[] = Array.isArray(value) ? value : [];
  return written.flatMap((each) =>
    isRecord(each) && typeof each['type'] === 'string'
      ? [{ type: each['type'], config: isRecord(each['config']) ? each['config'] : {} }]
      : [],
  );
}

export const canAddGoalEvent = (events: readonly unknown[]): boolean =>
  events.length < MAX_GOAL_EVENTS;

/**
 * The filters an event of a goal has: its trigger's own settings. A message is asked only
 * its channel (which automation it answers is not asked of a goal), and a setting the
 * forms can't hold is left to the JSON view.
 */
export function goalEventFields(type: string): readonly FieldSpec[] {
  return (fieldsOf('trigger', type) ?? []).filter(
    (field) =>
      (type !== 'message.received' || field.key === 'channel') &&
      (field.input.kind === 'reference' ||
        field.input.kind === 'choice' ||
        field.input.kind === 'text'),
  );
}

/** An event with one filter set, or taken away when it is emptied. */
export function withGoalFilter(event: GoalEvent, key: string, value: unknown): GoalEvent {
  const { [key]: _old, ...rest } = event.config;
  return {
    type: event.type,
    config: value === undefined || value === '' ? rest : { ...rest, [key]: value },
  };
}

/** The first event type the goal doesn't list yet, for a row just added. */
export function nextGoalEvent(events: readonly GoalEvent[]): GoalEvent {
  const free = automationGoalEvents.find((type) => !events.some((each) => each.type === type));
  return { type: free ?? automationGoalEvents[0], config: {} };
}
