// The automation document, as the builder reads and edits it (docs/AUTOMATIONS.md section
// 2). A draft may be unfinished, so nothing here trusts its shape: reading gives what is
// there, and each edit gives a new document and leaves the old one alone. The Steps view
// and the JSON view both work on this one document.
import {
  automationBranchNames,
  automationStepTypes,
  type AutomationBranches,
  type AutomationStepType,
} from '@repo/contracts';
import { pointerParts, readJson, type JsonProblem, type JsonSpan } from './automation-json';

/**
 * What names an exported automation (the contract's AUTOMATION_EXPORT_FORMAT). Written here,
 * and held to the contract's by a test: importing it would bring the whole API contract into
 * every chunk that reads a document, the canvas and the step panel among them.
 */
export const EXPORT_FORMAT = 'crm.automation';

/** A draft as the API holds it: a JSON object, possibly unfinished. */
export type Draft = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where a step leads: one step, a step for each branch, or nowhere (the path ends). */
export type StepNext = string | Readonly<Record<string, string>> | undefined;

export interface StepView {
  readonly id: string;
  readonly type: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly next: StepNext;
  readonly label: string | undefined;
}

export interface TriggerView {
  /** Its place in the list: an unfinished draft may repeat or lack ids. */
  readonly index: number;
  readonly id: string;
  readonly type: string;
  readonly config: Readonly<Record<string, unknown>>;
  /** Its "if", when it has one. */
  readonly condition: unknown;
}

export interface StopView {
  readonly index: number;
  readonly event: string;
  readonly from: string | undefined;
  readonly condition: unknown;
  /** For a stop on a message: only a reply to what this run sent (`this_run`). */
  readonly repliedTo: string | undefined;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function nextOf(value: unknown): StepNext {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  const branches: Record<string, string> = {};
  for (const [name, target] of Object.entries(value))
    if (typeof target === 'string') branches[name] = target;
  return branches;
}

function stepView(id: string, raw: unknown): StepView {
  const step = isRecord(raw) ? raw : {};
  return {
    id,
    type: text(step['type']),
    config: isRecord(step['config']) ? step['config'] : {},
    next: nextOf(step['next']),
    label: typeof step['label'] === 'string' && step['label'] !== '' ? step['label'] : undefined,
  };
}

const rawSteps = (draft: Draft): Readonly<Record<string, unknown>> =>
  isRecord(draft['steps']) ? draft['steps'] : {};
const rawTriggers = (draft: Draft): readonly unknown[] =>
  Array.isArray(draft['triggers']) ? (draft['triggers'] as readonly unknown[]) : [];

export const nameOf = (draft: Draft): string => text(draft['name']);

export const startOf = (draft: Draft): string | undefined =>
  typeof draft['start'] === 'string' && draft['start'] !== '' ? draft['start'] : undefined;

/** Every step, in the order the document lists them. */
export function stepsOf(draft: Draft): StepView[] {
  return Object.entries(rawSteps(draft)).map(([id, raw]) => stepView(id, raw));
}

export function stepOf(draft: Draft, id: string): StepView | undefined {
  const steps = rawSteps(draft);
  return Object.hasOwn(steps, id) ? stepView(id, steps[id]) : undefined;
}

/** A step as the document writes it, with every member, for what the views don't model. */
export function writtenStep(draft: Draft, id: string): Readonly<Record<string, unknown>> {
  const steps = rawSteps(draft);
  const raw = Object.hasOwn(steps, id) ? steps[id] : undefined;
  return isRecord(raw) ? raw : {};
}

export function writtenTrigger(draft: Draft, index: number): Readonly<Record<string, unknown>> {
  const raw = rawTriggers(draft)[index];
  return isRecord(raw) ? raw : {};
}

export function triggersOf(draft: Draft): TriggerView[] {
  return rawTriggers(draft).map((raw, index) => {
    const trigger = isRecord(raw) ? raw : {};
    return {
      index,
      id: text(trigger['id']),
      type: text(trigger['type']),
      config: isRecord(trigger['config']) ? trigger['config'] : {},
      condition: trigger['if'],
    };
  });
}

export function stopsOf(draft: Draft): StopView[] {
  const stops: readonly unknown[] = Array.isArray(draft['stopWhen']) ? draft['stopWhen'] : [];
  return stops.map((raw, index) => {
    const stop = isRecord(raw) ? raw : {};
    return {
      index,
      event: text(stop['event']),
      from: typeof stop['from'] === 'string' ? stop['from'] : undefined,
      condition: stop['if'],
      repliedTo: typeof stop['repliedTo'] === 'string' ? stop['repliedTo'] : undefined,
    };
  });
}

/** How a step type branches, or nothing for a type this version doesn't know. */
export function branchingOf(type: string): AutomationBranches | undefined {
  return Object.hasOwn(automationStepTypes, type)
    ? automationStepTypes[type as keyof typeof automationStepTypes].branches
    : undefined;
}

/**
 * The branches a step has, in order, or nothing for a step that just leads to the next.
 * A branch the document names but the type doesn't have is kept, last, so it stays in
 * sight until someone fixes it.
 */
export function branchNamesOf(step: StepView): string[] | undefined {
  const written = isRecord(step.next) ? Object.keys(step.next) : [];
  // Named as the contract names them for the validator and the engine: an If / else with
  // one condition has yes and no, and one with branches of its own has those and none.
  const named = Object.hasOwn(automationStepTypes, step.type)
    ? automationBranchNames(step.type as AutomationStepType, step.config)
    : undefined;
  const expected = named === undefined ? undefined : [...named];
  if (expected === undefined) return written.length > 0 ? written : undefined;
  return [...expected, ...written.filter((name) => !expected.includes(name))];
}

/** The step each branch leads to; a step without branches has the one unnamed path. */
function targetsOf(step: StepView): (string | undefined)[] {
  if (typeof step.next === 'string') return [step.next];
  const next = step.next;
  if (next === undefined) return [];
  return (branchNamesOf(step) ?? []).map((name) => next[name]);
}

/** Where a new step can go: before the first step, or after a step, on one of its branches. */
export type InsertAt =
  | { readonly kind: 'start' }
  | { readonly kind: 'after'; readonly step: string; readonly branch?: string }
  /** Before a step, on every path that leads to it: where paths come together. */
  | { readonly kind: 'before'; readonly step: string };

export type OutlineItem =
  | { readonly kind: 'step'; readonly step: StepView; readonly branches: readonly OutlineBranch[] }
  /** The path returns to a step it has already been through: a loop. */
  | { readonly kind: 'back'; readonly to: string }
  /** The path carries on at a step that is listed on another path. */
  | { readonly kind: 'join'; readonly to: string }
  /** The path points at a step the document doesn't have. */
  | { readonly kind: 'missing'; readonly to: string }
  | { readonly kind: 'end' };

export interface OutlinePath {
  /** Where a step added at the top of this path goes; none for steps nothing leads to. */
  readonly at: InsertAt | undefined;
  readonly items: readonly OutlineItem[];
}

export interface OutlineBranch extends OutlinePath {
  readonly name: string;
}

export interface Outline {
  readonly main: OutlinePath;
  /** Steps nothing leads to, each with what follows it. */
  readonly detached: readonly OutlinePath[];
}

/**
 * The steps in the order a contact meets them, from the start, with each branch's path
 * under its step. Every step is listed once: a path that returns to an earlier step says
 * so and stops, which is also what keeps a loop from going round forever.
 */
export function outlineOf(draft: Draft): Outline {
  const listed = new Set<string>();

  const walk = (from: string | undefined, onPath: ReadonlySet<string>): OutlineItem[] => {
    const items: OutlineItem[] = [];
    const path = new Set(onPath);
    let id = from;
    while (id !== undefined) {
      if (listed.has(id)) {
        items.push({ kind: path.has(id) ? 'back' : 'join', to: id });
        return items;
      }
      const step = stepOf(draft, id);
      if (step === undefined) {
        items.push({ kind: 'missing', to: id });
        return items;
      }
      listed.add(id);
      path.add(id);
      const names = branchNamesOf(step);
      if (names === undefined) {
        items.push({ kind: 'step', step, branches: [] });
        id = typeof step.next === 'string' ? step.next : undefined;
        continue;
      }
      const next = step.next;
      const stepId = id;
      items.push({
        kind: 'step',
        step,
        branches: names.map((name) => ({
          name,
          at: { kind: 'after', step: stepId, branch: name },
          items: walk(typeof next === 'string' ? undefined : next?.[name], path),
        })),
      });
      // Each branch ends itself; nothing follows a step that branches.
      return items;
    }
    items.push({ kind: 'end' });
    return items;
  };

  const main: OutlinePath = { at: { kind: 'start' }, items: walk(startOf(draft), new Set()) };
  const detached: OutlinePath[] = [];
  for (const step of stepsOf(draft))
    if (!listed.has(step.id)) detached.push({ at: undefined, items: walk(step.id, new Set()) });
  return { main, detached };
}

/** The steps a contact can reach from the start. */
export function reachableSteps(draft: Draft): Set<string> {
  const reached = new Set<string>();
  const waiting = [startOf(draft)];
  while (waiting.length > 0) {
    const id = waiting.pop();
    if (id === undefined || reached.has(id)) continue;
    const step = stepOf(draft, id);
    if (step === undefined) continue;
    reached.add(id);
    waiting.push(...targetsOf(step));
  }
  return reached;
}

function withSteps(draft: Draft, steps: Readonly<Record<string, unknown>>): Draft {
  return { ...draft, steps };
}

function withNext(raw: unknown, next: StepNext): Record<string, unknown> {
  const { next: _dropped, ...rest } = isRecord(raw) ? raw : {};
  if (next === undefined) return rest;
  if (typeof next !== 'string' && Object.keys(next).length === 0) return rest;
  return { ...rest, next };
}

/** An id for a new step or trigger of a type: sms_send, then sms_send_2. */
function freeKey(type: string, taken: ReadonlySet<string>): string {
  const base =
    type
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '_')
      .slice(0, 50)
      .replaceAll(/^[^a-z]+|_+$/g, '') || 'step';
  if (!taken.has(base)) return base;
  for (let count = 2; ; count += 1) {
    const candidate = `${base}_${String(count)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const newStepId = (draft: Draft, type: string): string =>
  freeKey(type, new Set(Object.keys(rawSteps(draft))));

export const newTriggerId = (draft: Draft, type: string): string =>
  freeKey(type, new Set(triggersOf(draft).map((trigger) => trigger.id)));

export function renameAutomation(draft: Draft, name: string): Draft {
  return { ...draft, name };
}

export interface NewStep {
  readonly id: string;
  readonly type: string;
  readonly config: Readonly<Record<string, unknown>>;
  /** The name its author gives it, when they give one. */
  readonly label?: string | undefined;
}

// What a new step is written as, leading on to what it was put in front of.
function freshStep(added: NewStep, displaced: string | undefined): Record<string, unknown> {
  const names = branchNamesOf(stepView(added.id, { type: added.type, config: added.config }));
  const firstBranch = names?.[0];
  return withNext(
    {
      type: added.type,
      config: added.config,
      ...(added.label === undefined ? {} : { label: added.label }),
    },
    displaced === undefined
      ? undefined
      : names === undefined
        ? displaced
        : firstBranch === undefined
          ? undefined
          : { [firstBranch]: displaced },
  );
}

// Puts a new step in front of one that several paths lead to: every path that led to that
// step now leads to the new one, which leads on to it. A Go To keeps its own target.
function addBefore(draft: Draft, target: string, added: NewStep): Draft {
  const steps = rawSteps(draft);
  if (stepOf(draft, target) === undefined) return draft;
  const ordered: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(steps)) {
    if (id === target) ordered[added.id] = freshStep(added, target);
    const next = isRecord(raw) ? raw['next'] : undefined;
    ordered[id] =
      next === target
        ? withNext(raw, added.id)
        : isRecord(next) && Object.values(next).includes(target)
          ? withNext(
              raw,
              Object.fromEntries(
                Object.entries(next).map(([name, to]) => [name, to === target ? added.id : to]),
              ) as StepNext,
            )
          : raw;
  }
  const led = { ...draft, steps: ordered };
  return startOf(draft) === target ? { ...led, start: added.id } : led;
}

/**
 * Puts a new step into the flow. What used to come next now follows the new step (on its
 * first branch, when it branches), so nothing after it is cut off.
 */
export function addStep(draft: Draft, at: InsertAt, added: NewStep): Draft {
  const steps = rawSteps(draft);
  if (Object.hasOwn(steps, added.id)) return draft;
  if (at.kind === 'before') return addBefore(draft, at.step, added);
  const before = at.kind === 'after' ? stepOf(draft, at.step) : undefined;
  if (at.kind === 'after' && before === undefined) return draft;

  const displaced =
    before === undefined
      ? startOf(draft)
      : typeof before.next === 'string'
        ? at.kind === 'after' && at.branch === undefined
          ? before.next
          : undefined
        : at.kind === 'after' && at.branch !== undefined
          ? before.next?.[at.branch]
          : undefined;
  const fresh = freshStep(added, displaced);

  if (before === undefined || at.kind === 'start')
    return { ...withSteps(draft, { [added.id]: fresh, ...steps }), start: added.id };

  const linked = withNext(
    steps[before.id],
    at.branch === undefined
      ? added.id
      : { ...(typeof before.next === 'string' ? {} : before.next), [at.branch]: added.id },
  );
  // Listed right after the step it follows, so the JSON reads in order too.
  const ordered: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(steps)) {
    ordered[id] = id === before.id ? linked : raw;
    if (id === before.id) ordered[added.id] = fresh;
  }
  return withSteps(draft, ordered);
}

/** What a step leads to once it is gone: its next step, or its first branch that has one. */
function successorOf(step: StepView): string | undefined {
  return targetsOf(step).find((target) => target !== undefined && target !== step.id);
}

/**
 * Takes a step out and joins the flow back up: whatever led to it now leads to what came
 * after it. A step with branches is replaced by its first branch; the other branches'
 * steps stay in the document, with nothing leading to them.
 */
export function removeStep(draft: Draft, id: string): Draft {
  const removed = stepOf(draft, id);
  if (removed === undefined) return draft;
  const successor = successorOf(removed);
  const relinked = (target: string): string | undefined => (target === id ? successor : target);

  const steps: Record<string, unknown> = {};
  for (const [stepId, raw] of Object.entries(rawSteps(draft))) {
    if (stepId === id) continue;
    const next = stepView(stepId, raw).next;
    if (next === undefined) {
      steps[stepId] = raw;
      continue;
    }
    if (typeof next === 'string') {
      steps[stepId] = next === id ? withNext(raw, successor) : raw;
      continue;
    }
    if (!Object.values(next).includes(id)) {
      steps[stepId] = raw;
      continue;
    }
    const branches: Record<string, string> = {};
    for (const [name, target] of Object.entries(next)) {
      const kept = relinked(target);
      if (kept !== undefined) branches[name] = kept;
    }
    steps[stepId] = withNext(raw, branches);
  }

  const { start: _start, layout, ...rest } = draft;
  const start = startOf(draft) === id ? successor : draft['start'];
  const positions = isRecord(layout)
    ? Object.fromEntries(Object.entries(layout).filter(([key]) => key !== id))
    : layout;
  return {
    ...rest,
    ...(start === undefined ? {} : { start }),
    steps,
    ...(positions === undefined ? {} : { layout: positions }),
  };
}

/** What removing a step does, to say before asking: where the flow goes, and what it cuts off. */
export function removalEffect(
  draft: Draft,
  id: string,
): { readonly joinsTo: string | undefined; readonly cutOff: readonly string[] } {
  const removed = stepOf(draft, id);
  const after = reachableSteps(removeStep(draft, id));
  return {
    joinsTo: removed === undefined ? undefined : successorOf(removed),
    cutOff: [...reachableSteps(draft)].filter((step) => step !== id && !after.has(step)),
  };
}

/**
 * Changes a step's settings. When the settings name the branches (an A/B split's variants,
 * an AI step's categories), each branch keeps the path it had: by position when the number
 * of branches is the same, so a rename keeps its path, and by name otherwise.
 */
export function updateStepConfig(
  draft: Draft,
  id: string,
  config: Readonly<Record<string, unknown>>,
): Draft {
  const steps = rawSteps(draft);
  const before = stepOf(draft, id);
  if (before === undefined) return draft;
  const raw = { ...(isRecord(steps[id]) ? steps[id] : {}), config };
  let changed: Record<string, unknown> = raw;
  const branching = branchingOf(before.type);
  if (branching?.kind === 'from_config' && isRecord(before.next)) {
    const next = before.next;
    // An If / else given branches of its own, however many: what was the no path is the
    // path of the branch for none of them.
    const { fallback, legacy } = branching;
    const old = branchNamesOf({ ...before, next: undefined }) ?? [];
    const fresh = branchNamesOf({ ...before, config, next: undefined }) ?? [];
    const branches: Record<string, string> = {};
    fresh.forEach((name, position) => {
      // A branch keeps its path by its name, wherever it now stands. One with a new name
      // takes the path of the branch that stood in its place, when that one is gone: a
      // rename. (An If / else given branches of its own: yes stays, no becomes none.)
      const stood = old[position];
      const from = old.includes(name)
        ? name
        : name === fallback && old.join() === legacy?.join()
          ? legacy.at(-1)
          : old.length === fresh.length && stood !== undefined && !fresh.includes(stood)
            ? stood
            : undefined;
      const target = from === undefined ? undefined : next[from];
      if (target !== undefined) branches[name] = target;
    });
    changed = withNext(raw, branches);
  }
  return withSteps(draft, { ...steps, [id]: changed });
}

export interface NewTrigger {
  readonly type: string;
  readonly config: Readonly<Record<string, unknown>>;
  /** Its filters: only events that also match start the automation. */
  readonly condition?: unknown;
}

export function addTrigger(draft: Draft, added: NewTrigger): Draft {
  const id = newTriggerId(draft, added.type);
  return {
    ...draft,
    triggers: [
      ...rawTriggers(draft),
      {
        id,
        type: added.type,
        config: added.config,
        ...(added.condition === undefined ? {} : { if: added.condition }),
      },
    ],
  };
}

export function updateTriggerConfig(
  draft: Draft,
  index: number,
  config: Readonly<Record<string, unknown>>,
): Draft {
  return {
    ...draft,
    triggers: rawTriggers(draft).map((raw, position) =>
      position === index ? { ...(isRecord(raw) ? raw : {}), config } : raw,
    ),
  };
}

/** An automation needs a way to start, so its last trigger stays. */
export const canRemoveTrigger = (draft: Draft): boolean => rawTriggers(draft).length > 1;

export function removeTrigger(draft: Draft, index: number): Draft {
  if (!canRemoveTrigger(draft)) return draft;
  return { ...draft, triggers: rawTriggers(draft).filter((_, position) => position !== index) };
}

/** The document as the JSON view shows it. Reading it back gives the same document. */
export function formatDraft(draft: Draft): string {
  return JSON.stringify(draft, null, 2);
}

export type DraftRead =
  | { readonly ok: true; readonly draft: Draft; readonly spans: ReadonlyMap<string, JsonSpan> }
  | { readonly ok: false; readonly problem: JsonProblem | 'not_an_object' };

/** Reads the JSON view's text: a document, or what is wrong with the text and where. */
export function readDraft(source: string): DraftRead {
  const read = readJson(source);
  if (!read.ok) return read;
  return isRecord(read.value)
    ? { ok: true, draft: read.value, spans: read.spans }
    : { ok: false, problem: 'not_an_object' };
}

/**
 * Reads what someone pastes or opens to import: a document, or an exported automation
 * (GET /automations/{id}/export), which wraps one.
 */
export function readImport(source: string): DraftRead {
  const read = readDraft(source);
  if (!read.ok) return read;
  const { draft } = read;
  return draft['format'] === EXPORT_FORMAT && isRecord(draft['document'])
    ? { ok: true, draft: draft['document'], spans: new Map() }
    : read;
}

/** Whether two documents are the same, whatever order their members are written in. */
export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((item, position) => sameJson(item, right[position]))
    );
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
    );
  }
  return false;
}

/** What a validation issue is about: a step, a trigger, or the automation as a whole. */
export type IssueSubject =
  | { readonly kind: 'step'; readonly id: string }
  | { readonly kind: 'trigger'; readonly index: number }
  | { readonly kind: 'automation' };

export function subjectOf(pointer: string): IssueSubject {
  const [area, key] = pointerParts(pointer);
  if (area === 'steps' && key !== undefined) return { kind: 'step', id: key };
  if (area === 'triggers' && key !== undefined && /^\d+$/.test(key))
    return { kind: 'trigger', index: Number(key) };
  return { kind: 'automation' };
}
