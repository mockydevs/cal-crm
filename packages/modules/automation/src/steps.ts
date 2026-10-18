// What a step decides, without doing anything: which step comes next, the branch it took
// and why, or how long to wait. The runner records the plan and moves the enrolment in one
// transaction; actions with side effects run elsewhere.
import {
  addDuration,
  automationRetryableFailures,
  automationRetryableSteps,
  CONDITION_FALLBACK,
  evaluateCondition,
  zoneClock,
  zonedParts,
  zonedTime,
  zoneOffset,
  zoneWallClock as wallClock,
  type AutomationStep,
  type ConditionValues,
} from '@repo/contracts';

import { firingInstant } from './zoned-dates.js';

export type StepPlan =
  | {
      readonly kind: 'next';
      readonly next: string | null;
      readonly branch: string | null;
      readonly output: Readonly<Record<string, unknown>>;
      readonly explanation: string;
    }
  | {
      readonly kind: 'wait';
      readonly wakeAt: Date;
      readonly next: string | null;
      readonly explanation: string;
    }
  | { readonly kind: 'fail'; readonly error: string; readonly explanation: string }
  /**
   * wait.event, first visit: wait at this step for the event until the timeout. A goal step
   * set to wait arms too, with no event of its own: what it waits for has been listened for
   * since the run began (goals.ts). A wait for a condition or for an appointment arms with no
   * event either: the runner knows from the step what such a wait listens for.
   */
  | {
      readonly kind: 'arm';
      readonly wakeAt: Date;
      readonly event: string | null;
      readonly explanation: string;
      /** What the run keeps for the next visit to this wait: a deadline, a decision held. */
      readonly carry?: Readonly<Record<string, unknown>>;
      /** The same wait goes on: its waiting row is brought up to date, not begun anew. */
      readonly again?: true;
    };

/** The appointment a wait.appointment step waits for, as the runner read it. */
export interface WaitedAppointment {
  /** The id the API shows for it. */
  readonly id: string;
  readonly startsAt: Date;
  readonly status: string;
}

/** How long a run waits at a goal step set to wait: the longest any wait may last. */
export const GOAL_WAIT = 'P365D';

/**
 * Catalog steps the engine can't run yet, each with why. The business's setup reports
 * them (setup.ts), so the validator refuses a document that uses one before it is
 * published; one reached anyway fails safely as not_implemented.
 */
export const UNAVAILABLE_STEPS = {
  'whatsapp.send': 'There is no WhatsApp channel yet.',
  'ai.ask': 'AI steps do not run in automations yet.',
  'ai.classify': 'AI steps do not run in automations yet.',
  'ai.draft_reply': 'AI steps do not run in automations yet.',
} as const satisfies Partial<Record<AutomationStep['type'], string>>;

export interface StepInput {
  readonly key: string;
  readonly step: AutomationStep;
  readonly values: ConditionValues;
  readonly now: Date;
  /** The time zone the automation's settings name: the contact's, or the business's. */
  readonly timeZone: string;
  readonly enrolmentId: string;
  /**
   * For a wait.event step, or a goal step, already waiting: the event that arrived, or null
   * at the timeout.
   */
  readonly armed?: {
    readonly receivedEventId: string | null;
    /** What the step's plan asked the run to keep when the wait began or went on. */
    readonly carry?: Readonly<Record<string, unknown>> | undefined;
  };
  /**
   * For a wait.appointment step: the appointment the wait is for, as it is now. null, or
   * left out, when the contact has none or it no longer exists.
   */
  readonly appointment?: WaitedAppointment | null | undefined;
  /** For a goal step: how the run comes to it. */
  readonly goal?: {
    /** The goal was met and brought the run here, from the step named (null: not known). */
    readonly met?: {
      readonly eventId: string;
      readonly eventType: string;
      readonly from: string | null;
    };
    /** The run has been through the goal step before. */
    readonly passed?: boolean;
  };
}

const linearNext = (step: AutomationStep): string | null =>
  typeof step.next === 'string' ? step.next : null;

function branchNext(step: AutomationStep, branch: string): string | null {
  const next: unknown = step.next;
  if (typeof next !== 'object' || next === null) return null;
  const target: unknown = (next as Readonly<Record<string, unknown>>)[branch];
  return typeof target === 'string' ? target : null;
}

const UNITS = [
  ['year', 'years'],
  ['month', 'months'],
  ['week', 'weeks'],
  ['day', 'days'],
  ['hour', 'hours'],
  ['minute', 'minutes'],
  ['second', 'seconds'],
] as const;

/** A duration in words, such as "2 days" for P2D. */
function durationWords(duration: string): string {
  const match =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
      duration,
    );
  if (match === null) return duration;
  return match
    .slice(1)
    .flatMap((part: string | undefined, index) => {
      const count = Number(part ?? 0);
      const unit = UNITS[index];
      return count === 0 || unit === undefined
        ? []
        : [`${String(count)} ${count === 1 ? unit[0] : unit[1]}`];
    })
    .join(', ');
}

const DAY = 86_400_000;

/** A stable bucket from 0 to 99 for an enrolment at a step (FNV-1a), so a retry splits alike. */
export function splitBucket(enrolmentId: string, stepKey: string): number {
  let hash = 0x811c9dc5;
  for (const character of `${enrolmentId}:${stepKey}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

const goOn = (next: string | null, explanation: string): StepPlan => ({
  kind: 'next',
  next,
  branch: null,
  output: {},
  explanation,
});

type Failed = Extract<StepPlan, { kind: 'fail' }>;

const fail = (error: string, explanation: string): Failed => ({
  kind: 'fail',
  error,
  explanation,
});

// An Invalid Date throws when written out, and a step that throws is retried without end.
const isInstant = (date: Date): boolean => !Number.isNaN(date.getTime());

const unreadable = (duration: string): Failed =>
  fail('invalid_duration', `${duration} is not a length of time.`);

const beyondRange = (): Failed =>
  fail('date_out_of_range', 'The wait ends beyond the last date that can be kept.');

const windowWords = (window: SendingWindow, timeZone: string): string =>
  `${window.days.join(', ')}, ${window.start} to ${window.end}, ${timeZone}`;

/**
 * The first moment from `at` on at which a wait's resume window is open: `at` itself when
 * there is no window or it is open then. A failure when the window can never be judged.
 */
function resumeFrom(
  window: SendingWindow | undefined,
  at: Date,
  timeZone: string,
): Date | Extract<StepPlan, { kind: 'fail' }> {
  if (window === undefined) return at;
  const opening = sendingWindowOpening(window, at, timeZone);
  if (opening === undefined)
    return zoneClock(timeZone) === undefined
      ? { kind: 'fail', error: 'invalid_time_zone', explanation: `${timeZone} is not a time zone.` }
      : {
          kind: 'fail',
          error: 'invalid_resume_window',
          explanation: `The resume window (${window.start} to ${window.end}) never opens.`,
        };
  return opening.open ? at : opening.opensAt;
}

/** A wait that leaves its step: until `wakeAt`, or the window's opening when it is closed then. */
function sleepUntil(
  input: StepInput,
  window: SendingWindow | undefined,
  wakeAt: Date,
  waiting: string,
): StepPlan {
  const resumes = resumeFrom(window, wakeAt, input.timeZone);
  if (!(resumes instanceof Date)) return resumes;
  return {
    kind: 'wait',
    wakeAt: resumes,
    next: linearNext(input.step),
    explanation:
      window === undefined || resumes.getTime() === wakeAt.getTime()
        ? `${waiting}.`
        : `${waiting}; the resume window (${windowWords(window, input.timeZone)}) is closed then, so it goes on at ${resumes.toISOString()}.`,
  };
}

function waitUntil(
  input: StepInput,
  wakeAt: Date,
  config: {
    readonly ifPassed?: 'continue' | 'end' | undefined;
    readonly resumeWindow?: SendingWindow | undefined;
  },
): StepPlan {
  const next = linearNext(input.step);
  if (wakeAt.getTime() > input.now.getTime())
    return sleepUntil(input, config.resumeWindow, wakeAt, `Waiting until ${wakeAt.toISOString()}`);
  if (config.ifPassed === 'end')
    return goOn(
      null,
      `${wakeAt.toISOString()} has passed, and this step is set to end the run then.`,
    );
  const resumes = resumeFrom(config.resumeWindow, input.now, input.timeZone);
  if (!(resumes instanceof Date)) return resumes;
  return config.resumeWindow === undefined || resumes.getTime() === input.now.getTime()
    ? goOn(next, `${wakeAt.toISOString()} has passed, so it went on at once.`)
    : {
        kind: 'wait',
        wakeAt: resumes,
        next,
        explanation: `${wakeAt.toISOString()} has passed; the resume window (${windowWords(config.resumeWindow, input.timeZone)}) is closed, so it goes on at ${resumes.toISOString()}.`,
      };
}

/** What a wait that stays at its step came to: the branch, what it gives, and why. */
interface Decided {
  readonly branch: string;
  readonly output: Readonly<Record<string, unknown>>;
  readonly explanation: string;
  /** A person chose the branch (run-continue.ts): the run goes on now, window or not. */
  readonly continued?: true;
}

// A decision the run kept while the resume window was closed, if what it kept is one.
function decidedOf(carry: Readonly<Record<string, unknown>> | undefined): Decided | undefined {
  const kept = carry?.['decided'];
  if (typeof kept !== 'object' || kept === null) return undefined;
  const { branch, output, explanation, continued } = kept as Readonly<Record<string, unknown>>;
  return typeof branch === 'string' &&
    typeof explanation === 'string' &&
    typeof output === 'object' &&
    output !== null
    ? {
        branch,
        explanation,
        output: output as Readonly<Record<string, unknown>>,
        ...(continued === true ? { continued: true as const } : {}),
      }
    : undefined;
}

/**
 * Lets a wait that stays at its step go on down the branch decided, or, while its resume
 * window is closed, keeps the decision with the run and sleeps until the window opens. The
 * step is judged against the window again when it wakes, so waking late cannot pass it.
 */
function through(input: StepInput, window: SendingWindow | undefined, decided: Decided): StepPlan {
  // A person who continues a run means now: the resume window holds only what the wait
  // itself decides.
  const resumes =
    decided.continued === true ? input.now : resumeFrom(window, input.now, input.timeZone);
  if (!(resumes instanceof Date)) return resumes;
  if (window === undefined || resumes.getTime() === input.now.getTime())
    return {
      kind: 'next',
      next: branchNext(input.step, decided.branch),
      branch: decided.branch,
      output: decided.output,
      explanation: decided.explanation,
    };
  return {
    kind: 'arm',
    wakeAt: resumes,
    event: null,
    ...(input.armed === undefined ? {} : { again: true as const }),
    carry: { decided },
    explanation: `It would go on now (${decided.branch}), but the resume window (${windowWords(window, input.timeZone)}) is closed, so it goes on at ${resumes.toISOString()}.`,
  };
}

function planConditionWait(
  input: StepInput,
  step: Extract<AutomationStep, { type: 'wait.condition' }>,
): StepPlan {
  const window = step.config.resumeWindow;
  const holds = evaluateCondition(step.config.if, input.values, input.now, input.timeZone);
  const met = (explanation: string): StepPlan =>
    through(input, window, { branch: 'met', output: {}, explanation });
  if (input.armed === undefined) {
    if (holds) return met('The condition already held, so the met branch was taken.');
    const wakeAt = addDuration(input.now, step.config.timeout);
    if (wakeAt === undefined) return unreadable(step.config.timeout);
    if (!isInstant(wakeAt)) return beyondRange();
    return {
      kind: 'arm',
      wakeAt,
      event: null,
      carry: { until: wakeAt.toISOString() },
      explanation: `Waiting until the condition holds, or until ${wakeAt.toISOString()}.`,
    };
  }
  const changed = input.armed.receivedEventId !== null;
  if (holds)
    return met(
      changed
        ? 'The condition held when the record changed, so the met branch was taken.'
        : 'The condition held when the wait ended, so the met branch was taken.',
    );
  const kept = input.armed.carry?.['until'];
  const until = typeof kept === 'string' ? new Date(kept) : undefined;
  // Woken by a change before the deadline: the same wait goes on to the same deadline.
  if (changed && until !== undefined && isInstant(until) && until.getTime() > input.now.getTime())
    return {
      kind: 'arm',
      wakeAt: until,
      event: null,
      again: true,
      carry: { until: until.toISOString() },
      explanation: `The record changed, but the condition does not hold yet; still waiting until ${until.toISOString()}.`,
    };
  return through(input, window, {
    branch: 'timed_out',
    output: {},
    explanation: 'The condition did not hold before the timeout.',
  });
}

// The statuses of an appointment that will not take place, in the words a run's history
// uses for each.
const ONLY_CANCELLED: Readonly<Record<string, string>> = { cancelled: 'cancelled' };
const NOT_TAKING_PLACE: Readonly<Record<string, string>> = {
  ...ONLY_CANCELLED,
  no_show: 'marked no-show',
  invalid: 'marked invalid',
};

function planAppointmentWait(
  input: StepInput,
  step: Extract<AutomationStep, { type: 'wait.appointment' }>,
): StepPlan {
  const { offset, direction, resumeWindow: window } = step.config;
  const appointment = input.appointment ?? null;
  const waiting = input.armed !== undefined;
  if (appointment === null)
    return through(input, window, {
      branch: 'no_appointment',
      output: {},
      explanation: waiting
        ? 'The appointment no longer exists, so the no_appointment branch was taken.'
        : 'The contact has no upcoming appointment, so the no_appointment branch was taken.',
    });
  // An appointment that will not take place. A step stored at version 1 knew only the
  // cancelled one, and goes on as it did; version 2 takes a no-show or an invalid one too.
  const off = (input.step.typeVersion ?? 1) >= 2 ? NOT_TAKING_PLACE : ONLY_CANCELLED;
  const status = off[appointment.status];
  if (status !== undefined)
    return through(input, window, {
      branch: 'no_appointment',
      output: { appointmentId: appointment.id },
      explanation: `The appointment is ${status}, so the no_appointment branch was taken.`,
    });
  const target =
    offset === undefined
      ? appointment.startsAt
      : addDuration(appointment.startsAt, offset, direction === 'before' ? -1 : 1);
  if (target === undefined) return unreadable(offset ?? '');
  if (!isInstant(target)) return beyondRange();
  const starts = appointment.startsAt.toISOString();
  const output = { appointmentId: appointment.id, startsAt: starts };
  const carry = { appointment: appointment.id, target: target.toISOString() };
  // The time it waited for until now; another one means the appointment was moved.
  const before = input.armed?.carry?.['target'];
  const moved = typeof before === 'string' && before !== carry.target;
  if (target.getTime() <= input.now.getTime())
    return through(
      input,
      window,
      waiting
        ? {
            branch: 'reached',
            output,
            explanation: moved
              ? `The appointment was moved to ${starts}; its time to wait for (${carry.target}) has come, so the reached branch was taken.`
              : 'The time came, so the reached branch was taken.',
          }
        : {
            branch: 'passed',
            output,
            explanation: `The time to wait for (${carry.target}) had already passed, so the passed branch was taken.`,
          },
    );
  if (waiting)
    return {
      kind: 'arm',
      wakeAt: target,
      event: null,
      again: true,
      carry,
      explanation: moved
        ? `The appointment was moved to ${starts}, so the wait now ends at ${carry.target}.`
        : `Still waiting until ${carry.target}.`,
    };
  return {
    kind: 'arm',
    wakeAt: target,
    event: null,
    carry,
    explanation:
      offset === undefined
        ? `Waiting until the appointment starts, at ${starts}.`
        : `Waiting until ${durationWords(offset)} ${direction} the appointment starts (${starts}), at ${carry.target}.`,
  };
}

/** How long a wait.until step waits for its empty date field to get a value. */
export const EMPTY_FIELD_WAIT = 'P365D';

type FieldWaitConfig = Exclude<
  Extract<AutomationStep, { type: 'wait.until' }>['config'],
  { readonly at: string }
>;

/**
 * The instant a wait until a date field ends for the value the field holds now, or why it
 * has none. A date with no time of day lands at the step's time of day in the run's zone; a
 * date and time keeps its time of day. Either way the offset moves the date on the zone's
 * calendar and the clock by its hours (zoned-dates.ts), so 1 day before at 09:00 is 09:00
 * the day before whatever the clocks did.
 */
function fieldTarget(input: StepInput, config: FieldWaitConfig): Date | 'empty' | Failed {
  const { field, offset, direction, time } = config;
  const value = input.values[field];
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value : undefined;
  if (date === undefined) return 'empty';
  if (zoneClock(input.timeZone) === undefined)
    return {
      kind: 'fail',
      error: 'invalid_time_zone',
      explanation: `${input.timeZone} is not a time zone.`,
    };
  const local =
    date.length === 10
      ? { date, time: time ?? '00:00', seconds: 0 }
      : zonedParts(new Date(date), input.timeZone);
  const base =
    local === undefined
      ? undefined
      : firingInstant(local.date, { offset, direction, time: local.time }, input.timeZone);
  if (local === undefined || base === undefined) {
    if (offset !== undefined && addDuration(new Date(0), offset) === undefined)
      return unreadable(offset);
    // The date reads, and moving it by the offset leaves the dates that can be kept.
    return local !== undefined && zonedTime(local.date, local.time, input.timeZone) !== undefined
      ? beyondRange()
      : fail('invalid_date', `${field} holds ${date}, which is not a date.`);
  }
  return new Date(base.getTime() + local.seconds * 1000);
}

/**
 * A wait until a date field. It waits at its step, listening for the record's field
 * changes, and reads the field again whenever it wakes: a date moved later moves the wait,
 * one moved earlier ends it sooner, and an empty field does what ifEmpty says (wait for a
 * value by default, as ActiveCampaign's date wait does; go on; or end the run).
 */
function planFieldWait(input: StepInput, config: FieldWaitConfig): StepPlan {
  const next = linearNext(input.step);
  const { field } = config;
  const armed = input.armed;
  const target = fieldTarget(input, config);
  if (typeof target === 'object' && !(target instanceof Date)) return target;
  if (target === 'empty') {
    // A step stored before ifEmpty existed (version 1) goes on, as it always did.
    const choice = config.ifEmpty ?? ((input.step.typeVersion ?? 1) >= 2 ? 'wait' : 'continue');
    if (choice === 'continue')
      return goOn(
        next,
        armed === undefined
          ? `${field} has no date, so there was nothing to wait for.`
          : `${field} was emptied while the run waited, so it went on.`,
      );
    if (choice === 'end')
      return goOn(null, `${field} has no date, and this step is set to end the run then.`);
    // Waiting for a value: until EMPTY_FIELD_WAIT from when the field was first found empty.
    const kept = armed?.carry?.['emptyUntil'];
    const until =
      typeof kept === 'string' ? new Date(kept) : addDuration(input.now, EMPTY_FIELD_WAIT);
    if (until === undefined || !isInstant(until)) return beyondRange();
    if (until.getTime() <= input.now.getTime())
      return goOn(null, `${field} had no date for 365 days of waiting, so the run ended.`);
    return {
      kind: 'arm',
      wakeAt: until,
      event: null,
      ...(armed === undefined ? {} : { again: true as const }),
      carry: { emptyUntil: until.toISOString() },
      explanation: `${field} has no date yet, so the run waits here for one, until ${until.toISOString()} at the latest.`,
    };
  }
  const before = armed?.carry?.['target'];
  const reached = typeof before === 'string' && before === target.toISOString();
  if (target.getTime() > input.now.getTime())
    return {
      kind: 'arm',
      wakeAt: target,
      event: null,
      ...(armed === undefined ? {} : { again: true as const }),
      carry: { target: target.toISOString() },
      explanation:
        armed === undefined || reached
          ? `Waiting until ${target.toISOString()}.`
          : `${field} changed, so the wait now ends at ${target.toISOString()}.`,
    };
  // The time it waited for has come: it goes on, inside the resume window if there is one.
  if (reached) {
    const resumes = resumeFrom(config.resumeWindow, input.now, input.timeZone);
    if (!(resumes instanceof Date)) return resumes;
    return config.resumeWindow === undefined || resumes.getTime() === input.now.getTime()
      ? goOn(next, `The time came (${target.toISOString()}), so it went on.`)
      : {
          kind: 'wait',
          wakeAt: resumes,
          next,
          explanation: `The time came (${target.toISOString()}); the resume window (${windowWords(config.resumeWindow, input.timeZone)}) is closed, so it goes on at ${resumes.toISOString()}.`,
        };
  }
  // Already passed when the step was reached, or the field moved into the past while it
  // waited: as ifPassed says.
  return waitUntil(input, target, config);
}

/** What the step does now, for this enrolment and these values. */
export function planStep(input: StepInput): StepPlan {
  const { step, values, now } = input;
  switch (step.type) {
    case 'wait': {
      const wakeAt = addDuration(now, step.config.duration);
      if (wakeAt === undefined) return unreadable(step.config.duration);
      if (!isInstant(wakeAt)) return beyondRange();
      return sleepUntil(
        input,
        step.config.resumeWindow,
        wakeAt,
        `Waiting ${durationWords(step.config.duration)}, until ${wakeAt.toISOString()}`,
      );
    }
    case 'wait.until': {
      if ('at' in step.config) {
        const at = new Date(step.config.at);
        return isInstant(at)
          ? waitUntil(input, at, step.config)
          : fail('invalid_date', `${step.config.at} is not a date.`);
      }
      return planFieldWait(input, step.config);
    }
    case 'wait.condition': {
      const held = decidedOf(input.armed?.carry);
      return held === undefined
        ? planConditionWait(input, step)
        : through(input, step.config.resumeWindow, held);
    }
    case 'wait.appointment': {
      const held = decidedOf(input.armed?.carry);
      return held === undefined
        ? planAppointmentWait(input, step)
        : through(input, step.config.resumeWindow, held);
    }
    case 'wait.event': {
      const held = decidedOf(input.armed?.carry);
      if (held !== undefined) return through(input, step.config.resumeWindow, held);
      if (input.armed === undefined) {
        const wakeAt = addDuration(now, step.config.timeout);
        if (wakeAt === undefined) return unreadable(step.config.timeout);
        if (!isInstant(wakeAt)) return beyondRange();
        return {
          kind: 'arm',
          wakeAt,
          event: step.config.event,
          explanation: `Waiting for ${step.config.event} until ${wakeAt.toISOString()}.`,
        };
      }
      const received = input.armed.receivedEventId;
      return through(input, step.config.resumeWindow, {
        branch: received === null ? 'timed_out' : 'received',
        output: received === null ? {} : { eventId: received },
        explanation:
          received === null
            ? `No ${step.config.event} came before the timeout.`
            : `${step.config.event} arrived, so the received branch was taken.`,
      });
    }
    case 'condition': {
      if ('branches' in step.config) {
        // Tried in the order written; the first that holds is taken.
        const tried = step.config.branches;
        const index = tried.findIndex((each) =>
          evaluateCondition(each.if, values, now, input.timeZone),
        );
        const taken = tried[index];
        const branch = taken?.name ?? CONDITION_FALLBACK;
        return {
          kind: 'next',
          next: branchNext(step, branch),
          branch,
          output: {},
          explanation:
            taken === undefined
              ? `${tried.length === 1 ? 'The one branch did not hold' : `None of the ${String(tried.length)} branches held`}, so the ${CONDITION_FALLBACK} branch was taken.`
              : `Branch "${taken.name}" held (number ${String(index + 1)} of ${String(tried.length)}, tried in order), so it was taken.`,
        };
      }
      const holds = evaluateCondition(step.config.if, values, now, input.timeZone);
      const branch = holds ? 'yes' : 'no';
      return {
        kind: 'next',
        next: branchNext(step, branch),
        branch,
        output: {},
        explanation: `The condition was ${holds ? 'true' : 'false'}, so the ${branch} branch was taken.`,
      };
    }
    case 'split': {
      const bucket = splitBucket(input.enrolmentId, input.key);
      let floor = 0;
      const variant =
        step.config.variants.find((each) => {
          floor += each.percent;
          return bucket < floor;
        }) ?? step.config.variants.at(-1);
      const name = variant?.name ?? '';
      return {
        kind: 'next',
        next: branchNext(step, name),
        branch: name,
        output: { variant: name },
        explanation: `Bucket ${String(bucket)} of 100 fell in variant ${name}.`,
      };
    }
    case 'goto':
      return goOn(step.config.target, `Went to "${step.config.target}".`);
    case 'goal': {
      const next = linearNext(step);
      const met = input.goal?.met;
      if (met !== undefined)
        return {
          kind: 'next',
          next,
          branch: null,
          output: { eventId: met.eventId },
          explanation: `The goal was met (${met.eventType}), so the run came straight here${met.from === null ? '' : ` from "${met.from}"`}.`,
        };
      if (input.armed !== undefined) {
        const received = input.armed.receivedEventId;
        return received === null
          ? goOn(null, 'The goal was not met in 365 days of waiting here, so the run ended.')
          : {
              kind: 'next',
              next,
              branch: null,
              output: { eventId: received },
              explanation: 'The goal was met while the run waited here, so it went on.',
            };
      }
      if (input.goal?.passed === true)
        return goOn(next, 'This run has been through the goal step before, so it went on.');
      if (step.config.otherwise === 'continue')
        return goOn(next, 'Reached before the goal was met; this step is set to go on anyway.');
      if (step.config.otherwise === 'end')
        return goOn(null, 'Reached before the goal was met; this step is set to end the run here.');
      const wakeAt = addDuration(now, GOAL_WAIT);
      if (wakeAt === undefined || !isInstant(wakeAt)) return beyondRange();
      return {
        kind: 'arm',
        wakeAt,
        event: null,
        explanation: `Waiting here until the goal is met, or until ${wakeAt.toISOString()}.`,
      };
    }
    case 'whatsapp.send':
    case 'ai.ask':
    case 'ai.classify':
    case 'ai.draft_reply':
      return fail(
        'not_implemented',
        `${step.type} steps are not available yet. ${UNAVAILABLE_STEPS[step.type]}`,
      );
    // Actions with side effects, which the runner runs itself (actions.ts, webhook-task.ts)
    // before it asks for a plan: the planner alone never performs one.
    case 'email.send':
    case 'sms.send':
    case 'contact.update':
    case 'deal.create':
    case 'deal.find':
    case 'deal.move':
    case 'deal.close':
    case 'deal.update':
    case 'task.create':
    case 'note.create':
    case 'dnd.set':
    case 'owner.assign':
    case 'owner.remove':
    case 'followers.add':
    case 'followers.remove':
    case 'score.modify':
    case 'team.notify':
    case 'tag.add':
    case 'tag.remove':
    case 'webhook.call':
    case 'email.verify':
    case 'manual.call':
    case 'manual.sms':
    case 'automation.run':
    case 'automation.remove':
      return fail('not_implemented', `${step.type} steps are run by the engine, not planned.`);
  }
}

/** When messages may go out (the document's settings.sendingWindow). */
export interface SendingWindow {
  readonly days: readonly string[];
  /** A 24-hour time of day, such as 09:00. */
  readonly start: string;
  /** An end before the start is a window that runs past midnight. */
  readonly end: string;
}

/**
 * The steps the sending window holds: the messages an automation sends a contact. Changing
 * a field, adding a tag or calling a webhook is not held, and neither is a step the engine
 * can't run yet.
 */
export const WINDOWED_STEPS: ReadonlySet<AutomationStep['type']> = new Set([
  'email.send',
  'sms.send',
]);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// A calendar date as YYYY-MM-DD, from a day counted in milliseconds as if it were UTC.
const dateOf = (day: number): string => new Date(day).toISOString().slice(0, 10);

/**
 * Whether the sending window is open at an instant in a time zone, and if not, when it next
 * opens. A window opens at its start on each of its days and closes at its end the same
 * day, or the day after when the end is not after the start (22:00 to 06:00). Where the
 * clocks change, a time they skip moves forward and a time that comes twice is the first,
 * as zonedTime has it. undefined when the zone is not one, or the window never opens.
 */
export function sendingWindowOpening(
  window: SendingWindow,
  now: Date,
  timeZone: string,
): { readonly open: true } | { readonly open: false; readonly opensAt: Date } | undefined {
  const clock = zoneClock(timeZone);
  if (clock === undefined || window.start === window.end) return undefined;
  // Today's date on the zone's own calendar.
  const today = new Date(now.getTime() + zoneOffset(clock, now.getTime()));
  const midnight = wallClock(
    today.getUTCFullYear(),
    today.getUTCMonth() + 1,
    today.getUTCDate(),
    0,
    0,
    0,
  );
  // From yesterday, whose window may still be open past midnight, through a week ahead.
  for (let ahead = -1; ahead <= 7; ahead += 1) {
    const day = midnight + ahead * DAY;
    if (!window.days.includes(WEEKDAYS[new Date(day).getUTCDay()] ?? '')) continue;
    const opens = zonedTime(dateOf(day), window.start, timeZone);
    const closes = zonedTime(
      dateOf(window.end > window.start ? day : day + DAY),
      window.end,
      timeZone,
    );
    if (opens === undefined || closes === undefined) continue;
    if (now.getTime() < opens.getTime()) return { open: false, opensAt: opens };
    if (now.getTime() < closes.getTime()) return { open: true };
  }
  return undefined;
}

/**
 * What the sending window does to a message step at an instant: nothing when it is open
 * (undefined), a hold until it opens, or a failure when it can never be judged.
 */
export function planSendingHold(
  window: SendingWindow,
  now: Date,
  timeZone: string,
):
  | { readonly kind: 'hold'; readonly wakeAt: Date; readonly explanation: string }
  | { readonly kind: 'fail'; readonly error: string; readonly explanation: string }
  | undefined {
  const opening = sendingWindowOpening(window, now, timeZone);
  if (opening === undefined)
    return zoneClock(timeZone) === undefined
      ? { kind: 'fail', error: 'invalid_time_zone', explanation: `${timeZone} is not a time zone.` }
      : {
          kind: 'fail',
          error: 'invalid_sending_window',
          explanation: `The sending window (${window.start} to ${window.end}) never opens.`,
        };
  if (opening.open) return undefined;
  return {
    kind: 'hold',
    wakeAt: opening.opensAt,
    explanation: `Outside the sending window (${window.start} to ${window.end}, ${timeZone}), so it waits until ${opening.opensAt.toISOString()}.`,
  };
}

/** The wait before a step's first retry when its retry names none. */
export const DEFAULT_RETRY_WAIT = 'PT1M';

const RETRYABLE_STEPS: ReadonlySet<string> = new Set(automationRetryableSteps);
const RETRYABLE_FAILURES: ReadonlySet<string> = new Set(automationRetryableFailures);

/**
 * When a step that just failed is tried again, if it is: its retry allows another try, the
 * step is one a retry may be on, and the failure is one that can pass with time. `tries` is
 * how many times the step has been tried in this visit, the failed one included. The wait
 * doubles with each try unless the retry says fixed.
 */
export function retryTime(
  step: AutomationStep,
  error: string,
  tries: number,
  now: Date,
): Date | undefined {
  const retry = step.retry;
  if (retry === undefined || tries > retry.times) return undefined;
  if (!RETRYABLE_STEPS.has(step.type) || !RETRYABLE_FAILURES.has(error)) return undefined;
  const first = addDuration(now, retry.wait ?? DEFAULT_RETRY_WAIT);
  if (first === undefined || !isInstant(first)) return undefined;
  const wait = first.getTime() - now.getTime();
  const at = new Date(now.getTime() + (retry.backoff === 'fixed' ? wait : wait * 2 ** (tries - 1)));
  return isInstant(at) ? at : undefined;
}

/**
 * Where a run goes when this step fails, if it goes on at all: to the step's next
 * (`continue`), or to the step named (`goTo`), which is recorded as the branch `failed`.
 * Nothing when the step stops the run, which is what a step does unless it says otherwise.
 */
export function failurePath(
  step: AutomationStep,
):
  | { readonly next: string | null; readonly branch: string | null; readonly words: string }
  | undefined {
  const policy = step.onFailure;
  if (policy === undefined || policy === 'stop') return undefined;
  if (policy === 'continue') {
    const next = linearNext(step);
    return {
      next,
      branch: null,
      words:
        next === null
          ? 'This step is set to go on when it fails, and nothing comes after it, so the run ended here.'
          : `This step is set to go on when it fails, so the run went on to "${next}".`,
    };
  }
  return {
    next: policy.goTo,
    branch: 'failed',
    words: `This step is set to go to "${policy.goTo}" when it fails, so the run went on there.`,
  };
}
