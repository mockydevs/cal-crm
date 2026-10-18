// Changes to a draft that the builder's panels and its Settings tab make, beside the ones
// both views always made (automation-document.ts): a step's own name, a trigger's type and
// filters, a copy of a trigger, and the automation's settings. Each answers a new draft;
// nothing here keeps anything the document doesn't.
import {
  isRecord,
  newTriggerId,
  stepOf,
  stopsOf,
  triggersOf,
  writtenStep,
  writtenTrigger,
  type Draft,
} from './automation-document';

const writtenTriggers = (draft: Draft): readonly unknown[] =>
  Array.isArray(draft['triggers']) ? (draft['triggers'] as readonly unknown[]) : [];

/** Gives a step a name of its own, or takes it away when the name is empty. */
export function setStepLabel(draft: Draft, id: string, label: string | undefined): Draft {
  if (stepOf(draft, id) === undefined || !isRecord(draft['steps'])) return draft;
  const { label: _old, ...rest } = writtenStep(draft, id);
  const name = label?.trim() ?? '';
  return {
    ...draft,
    steps: { ...draft['steps'], [id]: name === '' ? rest : { ...rest, label: name } },
  };
}

export interface TriggerChange {
  readonly type: string;
  readonly config: Readonly<Record<string, unknown>>;
  /** Its filters; nothing when every event of the type starts the automation. */
  readonly condition: unknown;
}

/** Changes what a trigger listens for, its settings and its filters; its id stays. */
export function updateTrigger(draft: Draft, index: number, change: TriggerChange): Draft {
  const written = writtenTriggers(draft);
  if (index < 0 || index >= written.length) return draft;
  const { if: _old, ...rest } = writtenTrigger(draft, index);
  const changed = {
    ...rest,
    type: change.type,
    config: change.config,
    ...(change.condition === undefined ? {} : { if: change.condition }),
  };
  return {
    ...draft,
    triggers: written.map((raw, position) => (position === index ? changed : raw)),
  };
}

/** A copy of a trigger, right after it, under an id of its own. */
export function duplicateTrigger(draft: Draft, index: number): Draft {
  const original = triggersOf(draft)[index];
  if (original === undefined) return draft;
  const copy = { ...writtenTrigger(draft, index), id: newTriggerId(draft, original.type) };
  return {
    ...draft,
    triggers: writtenTriggers(draft).flatMap((raw, position) =>
      position === index ? [raw, copy] : [raw],
    ),
  };
}

export const weekdays = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type Weekday = (typeof weekdays)[number];

export interface SendingWindow {
  readonly days: readonly Weekday[];
  /** 24-hour times, such as 09:00. */
  readonly start: string;
  readonly end: string;
}

export interface SettingsView {
  /** Whether a contact who finished, or was taken out, may enter again. */
  readonly reEntry: boolean;
  /** Whose clock waits, dates and the time window go by. */
  readonly timezone: 'business' | 'contact';
  /** When messages may go out; nothing when they go at any time. */
  readonly window: SendingWindow | undefined;
}

const isWeekday = (value: unknown): value is Weekday =>
  typeof value === 'string' && (weekdays as readonly string[]).includes(value);
const time = (value: unknown, otherwise: string): string =>
  typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : otherwise;

/** The window a workflow starts with when "Specific time" is switched on: working hours. */
export const startingWindow: SendingWindow = {
  days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  start: '09:00',
  end: '17:00',
};

/** The settings as the Settings tab shows them; what the document leaves out is its default. */
export function settingsOf(draft: Draft): SettingsView {
  const settings = isRecord(draft['settings']) ? draft['settings'] : {};
  const written = settings['sendingWindow'];
  return {
    reEntry: settings['reEnrollment'] === 'after_finished',
    timezone: settings['timezone'] === 'contact' ? 'contact' : 'business',
    window: isRecord(written)
      ? {
          days: Array.isArray(written['days'])
            ? (written['days'] as readonly unknown[]).filter(isWeekday)
            : [],
          start: time(written['start'], startingWindow.start),
          end: time(written['end'], startingWindow.end),
        }
      : undefined,
  };
}

/** Writes the settings the tab changed; every other member of the document stays. */
export function withSettings(draft: Draft, change: Partial<SettingsView>): Draft {
  const { sendingWindow: _old, ...rest } = isRecord(draft['settings']) ? draft['settings'] : {};
  const next = { ...settingsOf(draft), ...change };
  return {
    ...draft,
    settings: {
      ...rest,
      reEnrollment: next.reEntry ? 'after_finished' : 'never',
      timezone: next.timezone,
      ...(next.window === undefined
        ? {}
        : {
            sendingWindow: {
              // In the week's order, however they were ticked.
              days: weekdays.filter((day) => next.window?.days.includes(day)),
              start: next.window.start,
              end: next.window.end,
            },
          }),
    },
  };
}

const isReplyStop = (stop: {
  event: string;
  from: string | undefined;
  condition: unknown;
}): boolean =>
  stop.event === 'message.received' && stop.from === 'contact' && stop.condition === undefined;

/** Whether the workflow ends for a contact as soon as they send a message. */
export const stopsOnReply = (draft: Draft): boolean => stopsOf(draft).some(isReplyStop);

/** Which messages end it: any from the contact, or only a reply to what this run sent. */
export type ReplyStopScope = 'any' | 'this_run';

/** Which messages the stop on a reply counts; nothing when the workflow has no such stop. */
export function replyStopScope(draft: Draft): ReplyStopScope | undefined {
  const stop = stopsOf(draft).find(isReplyStop);
  if (stop === undefined) return undefined;
  return stop.repliedTo === 'this_run' ? 'this_run' : 'any';
}

/** Changes which messages the stop on a reply counts; a workflow without the stop is left. */
export function setReplyStopScope(draft: Draft, scope: ReplyStopScope): Draft {
  const stop = stopsOf(draft).find(isReplyStop);
  if (stop === undefined || replyStopScope(draft) === scope) return draft;
  const written: readonly unknown[] = Array.isArray(draft['stopWhen']) ? draft['stopWhen'] : [];
  return {
    ...draft,
    stopWhen: written.map((each, index) => {
      if (index !== stop.index || !isRecord(each)) return each;
      const { repliedTo: _old, ...rest } = each;
      return scope === 'this_run' ? { ...rest, repliedTo: 'this_run' } : rest;
    }),
  };
}

/** Adds or takes away the stop on a contact's message; every other stop stays as written. */
export function setStopOnReply(draft: Draft, on: boolean): Draft {
  if (on === stopsOnReply(draft)) return draft;
  const written: readonly unknown[] = Array.isArray(draft['stopWhen']) ? draft['stopWhen'] : [];
  if (on)
    return { ...draft, stopWhen: [...written, { event: 'message.received', from: 'contact' }] };
  const kept = stopsOf(draft)
    .filter((stop) => !isReplyStop(stop))
    .map((stop) => written[stop.index]);
  const { stopWhen: _old, ...rest } = draft;
  return kept.length === 0 ? rest : { ...rest, stopWhen: kept };
}
