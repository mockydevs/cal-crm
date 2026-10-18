// What publishing would change: the live version beside the draft, in words. Each trigger,
// step, stop and setting that was added, removed or changed, with how it read before and
// how it reads now. Canvas positions and the bookkeeping the server adds on publish (each
// step's typeVersion) aren't changes anyone made, so they're left out.
import { i18n } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { validateAutomation, type AutomationSetup } from '@repo/contracts';
import {
  branchNamesOf,
  isRecord,
  nameOf,
  outlineOf,
  sameJson,
  startOf,
  stepOf,
  stepsOf,
  stopsOf,
  triggersOf,
  writtenStep,
  writtenTrigger,
  type Draft,
  type OutlinePath,
  type StepView,
} from './automation-document';
import { fieldsOf, settingWords, type FieldSpec } from './automation-fields';
import {
  branchLabel,
  durationWords,
  stepLabel,
  stepName,
  stepSummary,
  stopSummary,
  triggerLabel,
  triggerSummary,
} from './automation-summary';

export type ChangeKind = 'added' | 'removed' | 'changed';

/** One setting of a step or trigger, before and after; undefined is "wasn't there". */
export interface SettingChange {
  readonly label: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
}

export interface Change {
  readonly kind: ChangeKind;
  readonly about: 'automation' | 'trigger' | 'step' | 'stop';
  /** The step it's about, by id, so the list can lead to it. */
  readonly step?: string;
  /** What the thing is, such as "Send text" or "Starts when". */
  readonly title: string;
  /** How it read in the live version; nothing for something added. */
  readonly before: string | undefined;
  /** How it reads in the draft; nothing for something removed. */
  readonly after: string | undefined;
  readonly details: readonly SettingChange[];
}

type Config = Readonly<Record<string, unknown>>;

const shown = (value: unknown): string =>
  typeof value === 'string' ? t`“${value}”` : JSON.stringify(value);

/** Each setting that differs, by its form's label; a member no form knows goes by its key. */
function settingChanges(
  fields: readonly FieldSpec[],
  before: Config,
  after: Config,
  setup: AutomationSetup,
  /** The step's type, for a setting made of rows: it reads as the step's own card does. */
  type?: string,
): SettingChange[] {
  const changes: SettingChange[] = [];
  const covered = new Set<string>();
  for (const field of fields) {
    const keys = field.covers ?? [field.key];
    for (const key of keys) covered.add(key);
    if (keys.every((key) => sameJson(before[key], after[key]))) continue;
    const rows = ['members', 'deal_filters', 'deal_changes'].includes(field.input.kind);
    const words = (config: Config): string | undefined => {
      if (keys.every((key) => config[key] === undefined)) return undefined;
      if (keys.length === 1) return settingWords(field, config[field.key], setup);
      return (
        (rows && type !== undefined ? stepSummary({ type, config }, setup) : undefined) ??
        JSON.stringify(Object.fromEntries(keys.map((key) => [key, config[key]])))
      );
    };
    changes.push({ label: i18n._(field.label), before: words(before), after: words(after) });
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (covered.has(key) || sameJson(before[key], after[key])) continue;
    changes.push({
      label: key,
      before: before[key] === undefined ? undefined : shown(before[key]),
      after: after[key] === undefined ? undefined : shown(after[key]),
    });
  }
  return changes;
}

/** Members of a step or trigger that have no words of their own, such as a step's notes. */
function otherChanges(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  described: ReadonlySet<string>,
): SettingChange[] {
  const changes: SettingChange[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (described.has(key) || sameJson(before[key], after[key])) continue;
    changes.push({
      label: key === 'notes' ? t`Notes` : key,
      before: before[key] === undefined ? undefined : shown(before[key]),
      after: after[key] === undefined ? undefined : shown(after[key]),
    });
  }
  return changes;
}

const STEP_MEMBERS = new Set(['type', 'config', 'next', 'label']);
const TRIGGER_MEMBERS = new Set(['id', 'type', 'config', 'if']);

/** Where a step leads, in words: the next step, each branch's, or the end of the path. */
function nextWords(step: StepView, draft: Draft, setup: AutomationSetup): string {
  const name = (id: string | undefined): string => {
    if (id === undefined) return t`the path ends`;
    const target = stepOf(draft, id);
    return target === undefined ? id : stepName(target, setup);
  };
  const names = branchNamesOf(step);
  if (names === undefined) return name(typeof step.next === 'string' ? step.next : undefined);
  const next = step.next;
  return names
    .map((branch) => {
      const target = typeof next === 'string' ? undefined : next?.[branch];
      const label = branchLabel(step, branch);
      const leadsTo = name(target);
      return t`${label}: ${leadsTo}`;
    })
    .join('; ');
}

const notSetUp = (): string => t`Not set up yet`;

/** The steps in the order the Steps view lists them, then any the walk didn't reach. */
function listedOrder(draft: Draft): string[] {
  const order: string[] = [];
  const visit = (path: OutlinePath): void => {
    for (const item of path.items) {
      if (item.kind !== 'step') continue;
      order.push(item.step.id);
      item.branches.forEach(visit);
    }
  };
  const outline = outlineOf(draft);
  visit(outline.main);
  outline.detached.forEach(visit);
  return order;
}

function stepChanges(before: Draft, after: Draft, setup: AutomationSetup): Change[] {
  const changes: Change[] = [];
  for (const id of listedOrder(after)) {
    const now = stepOf(after, id);
    if (now === undefined) continue;
    const was = stepOf(before, id);
    const title = now.label ?? stepLabel(now.type) ?? now.type;
    const reads = stepSummary(now, setup) ?? notSetUp();
    if (was === undefined) {
      changes.push({
        kind: 'added',
        about: 'step',
        step: id,
        title,
        before: undefined,
        after: reads,
        details: [],
      });
      continue;
    }
    const read = stepSummary(was, setup) ?? notSetUp();
    const details: SettingChange[] =
      was.type === now.type
        ? settingChanges(fieldsOf('step', now.type) ?? [], was.config, now.config, setup, now.type)
        : [
            {
              label: t`Kind of step`,
              before: stepLabel(was.type) ?? was.type,
              after: stepLabel(now.type) ?? now.type,
            },
          ];
    if (was.label !== now.label)
      details.push({ label: t`Name`, before: was.label, after: now.label });
    if (!sameJson(was.next, now.next))
      details.push({
        label: t`What comes next`,
        before: nextWords(was, before, setup),
        after: nextWords(now, after, setup),
      });
    details.push(...otherChanges(writtenStep(before, id), writtenStep(after, id), STEP_MEMBERS));
    if (details.length > 0)
      changes.push({
        kind: 'changed',
        about: 'step',
        step: id,
        title,
        before: read,
        after: reads,
        details,
      });
  }
  for (const was of stepsOf(before)) {
    if (stepOf(after, was.id) !== undefined) continue;
    changes.push({
      kind: 'removed',
      about: 'step',
      title: was.label ?? stepLabel(was.type) ?? was.type,
      before: stepSummary(was, setup) ?? notSetUp(),
      after: undefined,
      details: [],
    });
  }
  return changes;
}

function triggerChanges(before: Draft, after: Draft, setup: AutomationSetup): Change[] {
  const changes: Change[] = [];
  const title = t`Starts when`;
  const reads = (trigger: ReturnType<typeof triggersOf>[number]): string =>
    triggerSummary(trigger, setup) ?? triggerLabel(trigger.type) ?? trigger.type;
  const earlier = triggersOf(before);
  const later = triggersOf(after);
  for (const now of later) {
    const was = earlier.find((trigger) => trigger.id === now.id);
    if (was === undefined) {
      changes.push({
        kind: 'added',
        about: 'trigger',
        title,
        before: undefined,
        after: reads(now),
        details: [],
      });
      continue;
    }
    const details =
      was.type === now.type
        ? settingChanges(fieldsOf('trigger', now.type) ?? [], was.config, now.config, setup)
        : [];
    if (!sameJson(was.condition, now.condition))
      details.push({
        label: t`Only if`,
        before: was.condition === undefined ? undefined : shown(was.condition),
        after: now.condition === undefined ? undefined : shown(now.condition),
      });
    details.push(
      ...otherChanges(
        writtenTrigger(before, was.index),
        writtenTrigger(after, now.index),
        TRIGGER_MEMBERS,
      ),
    );
    if (was.type !== now.type || details.length > 0)
      changes.push({
        kind: 'changed',
        about: 'trigger',
        title,
        before: reads(was),
        after: reads(now),
        details,
      });
  }
  for (const was of earlier)
    if (!later.some((trigger) => trigger.id === was.id))
      changes.push({
        kind: 'removed',
        about: 'trigger',
        title,
        before: reads(was),
        after: undefined,
        details: [],
      });
  return changes;
}

function stopChanges(before: Draft, after: Draft): Change[] {
  const title = t`Stops as soon as`;
  const raw = (draft: Draft): readonly unknown[] =>
    Array.isArray(draft['stopWhen']) ? (draft['stopWhen'] as readonly unknown[]) : [];
  const reads = (draft: Draft, index: number): string => {
    const stop = stopsOf(draft)[index];
    return (
      (stop === undefined ? undefined : stopSummary(stop)) ?? JSON.stringify(raw(draft)[index])
    );
  };
  const earlier = raw(before);
  const later = raw(after);
  return [
    ...later.flatMap((stop, index): Change[] =>
      earlier.some((each) => sameJson(each, stop))
        ? []
        : [
            {
              kind: 'added',
              about: 'stop',
              title,
              before: undefined,
              after: reads(after, index),
              details: [],
            },
          ],
    ),
    ...earlier.flatMap((stop, index): Change[] =>
      later.some((each) => sameJson(each, stop))
        ? []
        : [
            {
              kind: 'removed',
              about: 'stop',
              title,
              before: reads(before, index),
              after: undefined,
              details: [],
            },
          ],
    ),
  ];
}

const settingNames = {
  reEnrollment: msg`Going through again`,
  timezone: msg`Time zone`,
  sendingWindow: msg`When messages may go out`,
};
const settingValues: Readonly<Record<string, () => string>> = {
  never: () => t`Each contact goes through once`,
  after_finished: () => t`A contact can go through again once they've finished`,
  contact: () => t`The contact's`,
  business: () => t`The business's`,
};

function settingsChanges(before: Draft, after: Draft): Change[] {
  const was = isRecord(before['settings']) ? before['settings'] : {};
  const now = isRecord(after['settings']) ? after['settings'] : {};
  const words = (value: unknown): string | undefined =>
    value === undefined
      ? undefined
      : typeof value === 'string' && Object.hasOwn(settingValues, value)
        ? settingValues[value]?.()
        : (durationWords(value) ?? shown(value));
  const details: SettingChange[] = [];
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (sameJson(was[key], now[key])) continue;
    details.push({
      label: Object.hasOwn(settingNames, key)
        ? i18n._(settingNames[key as keyof typeof settingNames])
        : key,
      before: words(was[key]),
      after: words(now[key]),
    });
  }
  return details.length === 0
    ? []
    : [
        {
          kind: 'changed',
          about: 'automation',
          title: t`Settings`,
          before: undefined,
          after: undefined,
          details,
        },
      ];
}

/** Top-level members with their own section here, and those that aren't changes to report. */
const DESCRIBED = new Set([
  'name',
  'description',
  'triggers',
  'stopWhen',
  'start',
  'steps',
  'settings',
]);
const NOT_CHANGES = new Set(['$schema', 'layout']);

/** A document without what the server adds on publish, so only people's changes compare. */
export function comparable(draft: Draft): Draft {
  const steps = isRecord(draft['steps']) ? draft['steps'] : undefined;
  const rest = Object.fromEntries(Object.entries(draft).filter(([key]) => !NOT_CHANGES.has(key)));
  if (steps === undefined) return rest;
  return {
    ...rest,
    steps: Object.fromEntries(
      Object.entries(steps).map(([id, raw]) => {
        if (!isRecord(raw)) return [id, raw];
        const { typeVersion: _added, ...step } = raw;
        return [id, step];
      }),
    ),
  };
}

/**
 * Everything that differs between two versions of an automation, in reading order: its
 * name, what starts it, its steps as the Steps view lists them, what stops it, its
 * settings, and anything else the document holds.
 */
export function describeChanges(live: Draft, draft: Draft, setup: AutomationSetup): Change[] {
  const before = comparable(live);
  const after = comparable(draft);
  const changes: Change[] = [];
  const whole = (title: string, was: unknown, now: unknown): void => {
    if (sameJson(was, now)) return;
    changes.push({
      kind: was === undefined ? 'added' : now === undefined ? 'removed' : 'changed',
      about: 'automation',
      title,
      before: was === undefined ? undefined : shown(was),
      after: now === undefined ? undefined : shown(now),
      details: [],
    });
  };
  whole(t`Name`, nameOf(before), nameOf(after));
  whole(t`Description`, before['description'] ?? '', after['description'] ?? '');
  changes.push(...triggerChanges(before, after, setup));
  const first = (source: Draft): string | undefined => {
    const id = startOf(source);
    const step = id === undefined ? undefined : stepOf(source, id);
    return step === undefined ? id : stepName(step, setup);
  };
  if (startOf(before) !== startOf(after))
    changes.push({
      kind: 'changed',
      about: 'automation',
      title: t`First step`,
      before: first(before),
      after: first(after),
      details: [],
    });
  changes.push(...stepChanges(before, after, setup));
  changes.push(...stopChanges(before, after));
  changes.push(...settingsChanges(before, after));
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (!DESCRIBED.has(key)) whole(key, before[key], after[key]);
  return changes;
}

/**
 * A document as the server keeps a published one: names resolved to ids, defaults filled
 * in. A draft that isn't valid yet can't be resolved, and is compared as it is written.
 */
function resolved(draft: Draft, setup: AutomationSetup): Draft {
  return validateAutomation(draft, setup).document ?? draft;
}

/**
 * What publishing the draft would change in the live version. Both are resolved first, so
 * a template given by name in the draft and by id in the live version isn't a change.
 */
export function publishChanges(live: Draft, draft: Draft, setup: AutomationSetup): Change[] {
  return describeChanges(resolved(live, setup), resolved(draft, setup), setup);
}
