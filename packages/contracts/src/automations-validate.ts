// The automation validator (AUTOMATIONS.md section 4): the document's shape, its flow,
// and this business's setup, with each problem at its exact JSON Pointer and a fix to try.
// It is pure, so the API, the builder's live check and the assistant all get the same
// answer for the same document and setup.
import type * as z from 'zod';

import {
  attributionLeafAt,
  attributionLeaves,
  attributionTriggers,
  isAttributionPath,
} from './automations-attribution.js';
import {
  automationBranchNames,
  automationRetryableSteps,
  automationStepTypes,
  automationTriggerTypes,
  CONDITION_FALLBACK,
  LOOP_MIN_WAIT,
  LOOP_MIN_WAIT_MS,
  MAX_RETRY_WAIT_HOURS,
  type AutomationGoalEvent,
  type AutomationStepType,
  type AutomationTriggerType,
} from './automations-catalog.js';
import {
  automationDocument,
  type AutomationDocument,
  type AutomationStep,
  type AutomationTrigger,
} from './automations.js';
import type { AutomationComputedValue } from './automations-field-writes.js';
import {
  isSubmissionPath,
  SUBMISSION_ANSWER_KEY,
  SUBMISSION_PAGE_PATH,
  submissionAnswerKey,
  submissionAnswerPath,
  submissionTriggers,
  type SubmissionQuestion,
} from './automations-submission.js';
import type { AutomationCondition } from './automations-values.js';
import { automationTouches, touchWords, triggerListens } from './automations-touches.js';
import { isAllowedWebhookHeader } from './automations-webhook-header-names.js';
import type { WebhookHeader } from './automations-webhook-secrets.js';
import { contactTypes } from './contact-attributes.js';
import { EMAIL_UNSUBSCRIBE_MERGE_FIELD } from './email-unsubscribe-field.js';

/** The types a field can have, as automations see them: the CRM's value types, and tags. */
export const automationFieldTypes = [
  'text',
  'long_text',
  'number',
  'money',
  'date',
  'datetime',
  'boolean',
  'single_choice',
  'multi_choice',
  'email',
  'phone',
  'url',
  'tags',
] as const;

export type AutomationFieldType = (typeof automationFieldTypes)[number];

/** A custom field of the business, as automations reference it. */
export interface AutomationCustomField {
  readonly key: string;
  /** Keys that resolve to this field after a merge (crm.field_key_aliases). */
  readonly aliases: readonly string[];
  readonly type: AutomationFieldType;
  readonly options: readonly { readonly key: string; readonly label: string }[];
  /** What people call the field. Left out by a setup that can't tell: the key stands in. */
  readonly label?: string | undefined;
  /** The folder the field is kept in, for listing fields as Settings does; null for none. */
  readonly folder?: { readonly id: string; readonly name: string } | null | undefined;
}

export interface AutomationNamed {
  readonly id: string;
  readonly name: string;
}

/** What the business has, read when validating: nothing outside it can be referenced. */
export interface AutomationSetup {
  readonly fields: {
    readonly contact: readonly AutomationCustomField[];
    readonly deal: readonly AutomationCustomField[];
  };
  /**
   * The published forms. With its questions, a form's answers are checked by key and read
   * by kind (trigger.answers.<key>); a setup that leaves them out can't tell, and every
   * answer of that form is read as text.
   */
  readonly forms: readonly (AutomationNamed & {
    readonly questions?: readonly SubmissionQuestion[] | undefined;
    /**
     * Whether the form is published. A draft is listed so that a trigger naming it is told
     * to publish it rather than that it does not exist; an archived form is not listed.
     * Left out by a setup that lists published forms only.
     */
    readonly status?: 'published' | 'draft' | undefined;
  })[];
  readonly emailTemplates: readonly AutomationNamed[];
  readonly whatsappTemplates: readonly AutomationNamed[];
  readonly mailboxes: readonly AutomationNamed[];
  /** Numbers a text message step may send from: registered, working and able to send SMS. */
  readonly phoneNumbers: readonly AutomationNamed[];
  readonly calendars: readonly AutomationNamed[];
  readonly pipelines: readonly (AutomationNamed & {
    readonly stages: readonly AutomationNamed[];
  })[];
  readonly lostReasons: readonly AutomationNamed[];
  readonly tags: readonly AutomationNamed[];
  readonly users: readonly AutomationNamed[];
  /**
   * The business's automations, each with the automations its published version starts
   * (its automation.run steps), by id. Left out, an automation is read as starting none.
   */
  readonly automations: readonly (AutomationNamed & {
    readonly starts?: readonly string[] | undefined;
    /**
     * The automations whose runs ending start its published version (its
     * automation.run_ended triggers), by id. Left out, none.
     */
    readonly startsAfter?: readonly string[] | undefined;
    /**
     * What its published version's triggers listen for on a contact, and what its steps
     * change there, as automationTouches keys. Left out, nothing.
     */
    readonly listens?: readonly string[] | undefined;
    readonly writes?: readonly string[] | undefined;
  })[];
  /**
   * The business's trigger links, each with the key a message writes as
   * {{trigger_link.<key>}}. Left out by a setup that can't tell: nothing about a link is
   * then checked.
   */
  readonly triggerLinks?: readonly (AutomationNamed & { readonly key: string })[];
  /** The keys of the business's custom values: {{custom_values.<key>}} or {{values.<key>}}. */
  readonly values: readonly string[];
  /**
   * Whether the business profile has a postal address (a street line): what a marketing
   * email's footer shows. Left out by a setup that can't tell: nothing is said then.
   */
  readonly postalAddress?: boolean | undefined;
  readonly channels: { readonly email: boolean; readonly sms: boolean; readonly whatsapp: boolean };
  readonly ai: boolean;
  /** Whether a webhook signing secret exists, so webhook steps can send. */
  readonly webhooks: boolean;
  /**
   * The names of the business's webhook secrets, which a webhook step's header may send.
   * Left out by a setup that can't tell: no header's secret is then checked.
   */
  readonly webhookSecrets?: readonly string[] | undefined;
  /**
   * Whether email verification is on (Settings → Email Services → Email Verification), so an
   * Email verification step can check an address. Left out by a setup that can't tell:
   * nothing about it is then checked.
   */
  readonly emailVerification?: boolean | undefined;
  /**
   * Step types in the catalog that this install's engine can't run yet. A document that
   * uses one is refused, so nothing is published that could only fail when it runs.
   */
  readonly unavailableSteps: readonly string[];
  /** Trigger types in the catalog that nothing on this install fires yet. */
  readonly unavailableTriggers: readonly string[];
}

export interface AutomationIssue {
  /** A JSON Pointer into the document, such as /steps/check_in/config/message. */
  readonly path: string;
  readonly code: string;
  readonly message: string;
  readonly suggestion?: string;
}

export interface AutomationValidation {
  readonly valid: boolean;
  readonly errors: readonly AutomationIssue[];
  readonly warnings: readonly AutomationIssue[];
  /** With names resolved to ids, field paths made canonical and step versions added. */
  readonly document?: AutomationDocument;
}

// Said of a document with no trigger: allowed, since another automation can start it.
const NO_TRIGGER =
  'Nothing starts this workflow on its own. Add at least one trigger to start this workflow. Without one it runs only when another workflow starts it.';

/** How far ahead a deal.update step may set an expected close date: ten years. */
export const MAX_CLOSE_DATE_DAYS = 3650;

// Query parameters whose value is likely a credential.
const SECRET_QUERY_KEYS = new Set([
  'key',
  'api_key',
  'apikey',
  'api-key',
  'token',
  'access_token',
  'auth',
  'secret',
  'client_secret',
  'password',
  'sig',
  'signature',
]);

/** The longest wait or offset a step may hold. */
export const MAX_WAIT_DAYS = 365;

const BUILT_IN_FIELDS: Readonly<Record<'contact' | 'deal', Record<string, AutomationFieldType>>> = {
  contact: {
    firstName: 'text',
    lastName: 'text',
    name: 'text',
    email: 'email',
    phone: 'phone',
    tags: 'tags',
    // Where the contact came from, in the business's own words, and lead or customer.
    source: 'text',
    type: 'single_choice',
    createdAt: 'datetime',
    updatedAt: 'datetime',
    // The primary email address's verification, as email verification last found it.
    emailVerification: 'single_choice',
    emailVerified: 'boolean',
  },
  deal: {
    name: 'text',
    // The deal's value, under the name people know it by and under the column's.
    value: 'money',
    amount: 'money',
    source: 'text',
    currency: 'text',
    status: 'single_choice',
    pipeline: 'text',
    stage: 'text',
    expectedCloseDate: 'date',
    createdAt: 'datetime',
    closedAt: 'datetime',
  },
};
const READ_ONLY_FIELDS = new Set([
  'name',
  'tags',
  'createdAt',
  'updatedAt',
  'closedAt',
  'status',
  'pipeline',
  'stage',
  // A contact's own two; no step sets them yet (actions-contact.ts).
  'source',
  'type',
  // Email verification's to say, never a step's.
  'emailVerification',
  'emailVerified',
]);
const DEAL_STATUSES = [
  { key: 'open', label: 'Open' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
];
const CONTACT_TYPES = contactTypes.map((key) => ({
  key,
  label: `${key.charAt(0).toUpperCase()}${key.slice(1)}`,
}));
/**
 * An appointment's statuses, as calendar.appointments keeps them (calendar-events.ts
 * appointmentStatuses; a test holds the two equal). Written here so the builder's chunk
 * does not take in the calendar's endpoints with that list.
 */
export const AUTOMATION_APPOINTMENT_STATUSES = [
  { key: 'booked', label: 'Booked' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'no_show', label: 'No-show' },
  { key: 'completed', label: 'Completed' },
  { key: 'invalid', label: 'Invalid' },
];
/**
 * What email verification says of a contact's primary address, worded as the contact page
 * words it: unchecked has had no check yet, excluded is left out of verification.
 */
const EMAIL_VERIFICATIONS = [
  { key: 'valid', label: 'Verified' },
  { key: 'risky', label: 'Risky' },
  { key: 'invalid', label: 'Invalid' },
  { key: 'unknown', label: 'Unknown' },
  { key: 'unchecked', label: 'Not verified' },
  { key: 'excluded', label: 'Excluded' },
];
/** The choices of a built-in field that has them. */
const BUILT_IN_OPTIONS: Readonly<Record<string, typeof DEAL_STATUSES>> = {
  'deal.status': DEAL_STATUSES,
  'contact.type': CONTACT_TYPES,
  'contact.emailVerification': EMAIL_VERIFICATIONS,
  'appointment.status': AUTOMATION_APPOINTMENT_STATUSES,
};
/**
 * The triggers whose run is about one appointment of the contact. Only a workflow whose
 * triggers are all of these may send a transactional message (workflowMessagePurpose).
 */
export const automationAppointmentTriggers = [
  'appointment.booked',
  'appointment.status_changed',
] as const satisfies readonly AutomationTriggerType[];

/**
 * What a message or a condition reads of the appointment a run is about, as
 * appointment.<key>, never written: the appointment whose event started the run, otherwise
 * the one the run's latest wait for an appointment waited for. Every key is there, empty,
 * in a run without one. startTime is the start in words in the contact's zone (the zone
 * they booked in, else their own, else the calendar's), such as "Thursday, October 15,
 * 2026, 3:00 PM Eastern Daylight Time"; calendar is the calendar's name. Kept here, not in
 * the catalog, so the builder's first chunk stays within its budget.
 */
export const automationAppointmentFields = {
  title: 'text',
  startTime: 'text',
  startsAt: 'datetime',
  calendar: 'text',
  location: 'text',
  status: 'single_choice',
  // The appointment's own link to reschedule or cancel (migration 0107), filled in only in
  // a message, and only while the appointment is booked or confirmed and ahead: write it
  // with a fallback, such as {{appointment.manageUrl | default: "reply to this email"}}.
  manageUrl: 'text',
} as const satisfies Readonly<Record<string, AutomationFieldType>>;
const APPOINTMENT_FIELDS: Readonly<Record<string, AutomationFieldType>> =
  automationAppointmentFields;

const pointer = (...parts: readonly (string | number)[]) =>
  parts.map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');

// Levenshtein distance, for "Did you mean" suggestions.
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] ?? 0;
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1]?.toLowerCase() === b[j - 1]?.toLowerCase() ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length] ?? 0;
}

/** The closest candidate, if it's close enough to be what was meant. */
function closest(wanted: string, candidates: readonly string[]): string | undefined {
  let best: { candidate: string; score: number } | undefined;
  for (const candidate of candidates) {
    const score = distance(wanted, candidate);
    if (best === undefined || score < best.score) best = { candidate, score };
  }
  return best !== undefined && best.score <= Math.max(2, Math.floor(wanted.length / 3))
    ? best.candidate
    : undefined;
}

const suggest = (candidate: string | undefined) =>
  candidate === undefined ? {} : { suggestion: `Did you mean ${candidate}?` };

/** The days a duration can last at most, counting months as 31 days and years as 365. */
export function maxDurationDays(duration: string): number {
  const match =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
      duration,
    );
  if (match === null) return Number.POSITIVE_INFINITY;
  const [years, months, weeks, days, hours, minutes, seconds] = match
    .slice(1)
    // An unmatched group is undefined at run time, whatever the type says.
    .map((part: string | undefined) => Number(part ?? 0));
  return (
    (years ?? 0) * 365 +
    (months ?? 0) * 31 +
    (weeks ?? 0) * 7 +
    (days ?? 0) +
    (hours ?? 0) / 24 +
    (minutes ?? 0) / 1440 +
    (seconds ?? 0) / 86400
  );
}

/** The least time a duration can last, counting months as 28 days and years as 365. */
export function minDurationMs(duration: string): number {
  const match =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
      duration,
    );
  if (match === null) return 0;
  const [years, months, weeks, days, hours, minutes, seconds] = match
    .slice(1)
    // An unmatched group is undefined at run time, whatever the type says.
    .map((part: string | undefined) => Number(part ?? 0));
  const inDays = (years ?? 0) * 365 + (months ?? 0) * 28 + (weeks ?? 0) * 7 + (days ?? 0);
  return ((inDays * 24 + (hours ?? 0)) * 60 + (minutes ?? 0)) * 60_000 + (seconds ?? 0) * 1000;
}

/**
 * Whether a step, inside a loop, waits an hour or more each time round: a wait that long,
 * a wait for an event or a condition with a timeout that long, a wait for an appointment,
 * or a wait until a date field, which may change between rounds. A wait until a fixed
 * moment passes once, and is then no wait at all.
 */
function waitsAnHour(step: AutomationStep): boolean {
  if (step.type === 'wait') return minDurationMs(step.config.duration) >= LOOP_MIN_WAIT_MS;
  if (step.type === 'wait.event' || step.type === 'wait.condition')
    return minDurationMs(step.config.timeout) >= LOOP_MIN_WAIT_MS;
  if (step.type === 'wait.until') return 'field' in step.config;
  return step.type === 'wait.appointment';
}

interface ResolvedField {
  readonly path: string;
  readonly type: AutomationFieldType;
  readonly options: readonly { readonly key: string; readonly label: string }[];
  readonly writable: boolean;
}

type FieldResult =
  | { readonly kind: 'field'; readonly field: ResolvedField }
  | { readonly kind: 'error'; readonly message: string; readonly suggestion?: string };

/**
 * An answer of the submission that started the run, by its question's key. When every
 * "Form submitted" trigger names a form, the key must be a question of one of those forms,
 * and the answer has that question's kind and choices. When one of them starts for any
 * form, or the document has no such trigger yet, any key a form could use is taken and
 * read as text: nobody can say which form it will be.
 */
function answerResolver(
  setup: AutomationSetup,
  triggers: readonly AutomationTrigger[],
): (path: string, key: string) => FieldResult {
  return (path, key) => {
    if (!SUBMISSION_ANSWER_KEY.test(key))
      return {
        kind: 'error',
        message: `${path} is not an answer: after trigger.answers. comes a question's key, such as trigger.answers.budget.`,
      };
    const free: FieldResult = {
      kind: 'field',
      field: { path, type: 'text', options: [], writable: false },
    };
    const named = triggers
      .filter((trigger) => (submissionTriggers as readonly string[]).includes(trigger.type))
      .map((trigger) => (trigger.config as { readonly form?: unknown }).form);
    if (named.length === 0 || named.some((form) => typeof form !== 'string')) return free;
    const forms = setup.forms.filter(
      (form) => named.includes(form.id) || named.includes(form.name),
    );
    // A form the business does not have is said where the trigger names it, not here.
    if (forms.length < new Set(named).size || forms.some((form) => form.questions === undefined))
      return free;
    const questions = forms.flatMap((form) => form.questions ?? []);
    const asked = questions.filter((question) => question.key === key);
    const [first] = asked;
    if (first === undefined) {
      const close = closest(key, [...new Set(questions.map((question) => question.key))]);
      return {
        kind: 'error',
        message: `${path} is not a question of ${forms.map((form) => form.name).join(' or ')}.`,
        ...suggest(close === undefined ? undefined : submissionAnswerPath(close)),
      };
    }
    // Two forms may ask the same key in two ways: then it is read as text.
    const oneKind = asked.every((question) => question.type === first.type);
    const options = new Map(
      asked.flatMap((question) => question.options).map((option) => [option.key, option]),
    );
    return {
      kind: 'field',
      field: {
        path,
        type: oneKind ? first.type : 'text',
        options: oneKind ? [...options.values()] : [],
        writable: false,
      },
    };
  };
}

function fieldResolver(
  setup: AutomationSetup,
  triggers: readonly AutomationTrigger[],
): (path: string) => FieldResult {
  const resolveAnswer = answerResolver(setup, triggers);
  return (path) => {
    // The submission that started the run: the page it was sent from, and its answers.
    if (path === SUBMISSION_PAGE_PATH)
      return { kind: 'field', field: { path, type: 'text', options: [], writable: false } };
    const answer = submissionAnswerKey(path);
    if (answer !== undefined) return resolveAnswer(path, answer);
    // Where the contact came from: the first and latest touch, and the touch of the event
    // that started the run. Read, never written.
    const attribution = attributionLeafAt(path);
    if (attribution !== undefined)
      return {
        kind: 'field',
        field: {
          path,
          type: attribution.leaf.type,
          options: attribution.leaf.options,
          writable: false,
        },
      };
    if (isAttributionPath(path)) {
      const at = path.lastIndexOf('.');
      const leaf = closest(
        path.slice(at + 1),
        attributionLeaves.map((each) => each.key),
      );
      return {
        kind: 'error',
        message: `${path} is not something attribution keeps.`,
        ...suggest(leaf === undefined ? undefined : `${path.slice(0, at)}.${leaf}`),
      };
    }
    const [head, ...rest] = path.split('.');
    if (head === 'appointment') {
      const key = rest.length === 1 ? (rest[0] ?? '') : '';
      const type = Object.hasOwn(APPOINTMENT_FIELDS, key) ? APPOINTMENT_FIELDS[key] : undefined;
      if (type === undefined) {
        const near = closest(rest.join('.'), Object.keys(APPOINTMENT_FIELDS));
        return {
          kind: 'error',
          message: `${path} is not something an appointment has.`,
          ...suggest(near === undefined ? undefined : `appointment.${near}`),
        };
      }
      return {
        kind: 'field',
        field: { path, type, options: BUILT_IN_OPTIONS[path] ?? [], writable: false },
      };
    }
    if (head !== 'contact' && head !== 'deal')
      return {
        kind: 'error',
        message: `${path} is not a field: fields start with contact., deal., appointment., trigger.attribution. or trigger.answers., or are trigger.pageUrl.`,
      };
    const builtIns = BUILT_IN_FIELDS[head];
    const custom = setup.fields[head];
    const candidates = [
      ...Object.keys(builtIns).map((key) => `${head}.${key}`),
      ...custom.map((field) => `${head}.custom.${field.key}`),
    ];
    // Suggestions compare the field's own key, not the shared contact.custom. prefix.
    const keyOf = (candidate: string) => candidate.slice(candidate.lastIndexOf('.') + 1);
    const unknown = (): FieldResult => {
      const key = closest(keyOf(path), candidates.map(keyOf));
      return {
        kind: 'error',
        message: `${path} is not a field.`,
        ...suggest(candidates.find((candidate) => key !== undefined && keyOf(candidate) === key)),
      };
    };
    const customField = (key: string): FieldResult => {
      const field = custom.find((each) => each.key === key || each.aliases.includes(key));
      return field === undefined
        ? unknown()
        : {
            kind: 'field',
            field: {
              path: `${head}.custom.${field.key}`,
              type: field.type,
              options: field.options,
              writable: true,
            },
          };
    };
    if (rest.length === 2 && rest[0] === 'custom') return customField(rest[1] ?? '');
    if (rest.length !== 1) return unknown();
    const key = rest[0] ?? '';
    const builtIn = builtIns[key];
    // Built-in fields come first; a bare key is a custom field only when no built-in has it.
    if (builtIn !== undefined)
      return {
        kind: 'field',
        field: {
          path,
          type: builtIn,
          options: BUILT_IN_OPTIONS[path] ?? [],
          writable: !READ_ONLY_FIELDS.has(key),
        },
      };
    return customField(key);
  };
}

type Reference =
  | 'form'
  | 'emailTemplate'
  | 'whatsappTemplate'
  | 'mailbox'
  | 'phoneNumber'
  | 'calendar'
  | 'pipeline'
  | 'stage'
  | 'lostReason'
  | 'tag'
  | 'user'
  | 'automation'
  | 'triggerLink';

const REFERENCE_LISTS: Readonly<
  Record<Reference, (setup: AutomationSetup) => readonly AutomationNamed[]>
> = {
  form: (setup) => setup.forms,
  emailTemplate: (setup) => setup.emailTemplates,
  whatsappTemplate: (setup) => setup.whatsappTemplates,
  mailbox: (setup) => setup.mailboxes,
  phoneNumber: (setup) => setup.phoneNumbers,
  calendar: (setup) => setup.calendars,
  pipeline: (setup) => setup.pipelines,
  stage: (setup) => setup.pipelines.flatMap((pipeline) => pipeline.stages),
  lostReason: (setup) => setup.lostReasons,
  tag: (setup) => setup.tags,
  user: (setup) => setup.users,
  automation: (setup) => setup.automations,
  triggerLink: (setup) => setup.triggerLinks ?? [],
};

const REFERENCE_NOUNS: Readonly<Record<Reference, string>> = {
  form: 'form',
  emailTemplate: 'email template',
  whatsappTemplate: 'WhatsApp template',
  mailbox: 'mailbox',
  phoneNumber: 'phone number',
  calendar: 'calendar',
  pipeline: 'pipeline',
  stage: 'stage',
  lostReason: 'lost reason',
  tag: 'tag',
  user: 'team member',
  automation: 'automation',
  triggerLink: 'trigger link',
};

/** Which config keys of each step and trigger type name something of the business. */
const STEP_REFERENCES: Partial<Record<AutomationStepType, Readonly<Record<string, Reference>>>> = {
  'email.send': { template: 'emailTemplate', mailbox: 'mailbox' },
  'sms.send': { number: 'phoneNumber' },
  'whatsapp.send': { template: 'whatsappTemplate' },
  'deal.create': { pipeline: 'pipeline' },
  'deal.move': { pipeline: 'pipeline' },
  'deal.close': { lostReason: 'lostReason' },
  'deal.find': { pipeline: 'pipeline' },
  'deal.update': { owner: 'user' },
  'owner.assign': { user: 'user' },
  'manual.call': { user: 'user' },
  'manual.sms': { user: 'user' },
  'tag.add': { tag: 'tag' },
  'tag.remove': { tag: 'tag' },
  'automation.run': { automation: 'automation' },
};
/** Config keys that hold a list of references, each resolved as the single ones are. */
const STEP_REFERENCE_LISTS: Partial<
  Record<AutomationStepType, Readonly<Record<string, Reference>>>
> = {
  'automation.remove': { automations: 'automation', except: 'automation' },
  'owner.assign': { users: 'user' },
  'followers.add': { users: 'user' },
  'followers.remove': { users: 'user' },
};
const TRIGGER_REFERENCES: Partial<
  Record<AutomationTriggerType, Readonly<Record<string, Reference>>>
> = {
  'form.submitted': { form: 'form' },
  'appointment.booked': { calendar: 'calendar' },
  'appointment.status_changed': { calendar: 'calendar' },
  'deal.stage_changed': { pipeline: 'pipeline' },
  'deal.closed': { pipeline: 'pipeline' },
  'tag.added': { tag: 'tag' },
  'tag.removed': { tag: 'tag' },
  'trigger_link.clicked': { link: 'triggerLink' },
};

const TRIGGER_REFERENCE_LISTS: Partial<
  Record<AutomationTriggerType, Readonly<Record<string, Reference>>>
> = {
  'message.received': { repliedTo: 'automation' },
  'automation.run_ended': { automations: 'automation' },
};

const MESSAGE_STEPS: Partial<Record<AutomationStepType, 'email' | 'sms' | 'whatsapp'>> = {
  'email.send': 'email',
  'sms.send': 'sms',
  'whatsapp.send': 'whatsapp',
};
const WAIT_STEPS: ReadonlySet<AutomationStepType> = new Set([
  'wait',
  'wait.until',
  'wait.event',
  'wait.condition',
  'wait.appointment',
]);

const OPERATOR_TYPES: Readonly<Record<string, readonly AutomationFieldType[] | 'any'>> = {
  equals: 'any',
  not_equals: 'any',
  is_set: 'any',
  is_empty: 'any',
  includes: ['text', 'long_text', 'multi_choice', 'tags', 'email', 'url'],
  excludes: ['text', 'long_text', 'multi_choice', 'tags', 'email', 'url'],
  starts_with: ['text', 'long_text', 'email', 'url', 'phone'],
  greater_than: ['number', 'money', 'date', 'datetime'],
  less_than: ['number', 'money', 'date', 'datetime'],
  before: ['date', 'datetime'],
  after: ['date', 'datetime'],
  within_last: ['date', 'datetime'],
  within_next: ['date', 'datetime'],
};

const MERGE_TOKEN = /\{\{\s*([^{}\s]+)\s*\}\}/g;
// The same without the global flag, for asking whether a text has one: a global pattern
// remembers where its last test ended.
const HAS_MERGE_TOKEN = /\{\{\s*[^{}\s]+\s*\}\}/;

/** Where each step leads, branch by branch: its next, or for a Go To its target alone. */
function nextOf(
  step: AutomationStep,
): readonly (readonly [branch: string | null, target: string])[] {
  if (step.type === 'goto') return [[null, step.config.target]];
  const next: unknown = step.next;
  if (typeof next === 'string') return [[null, next]];
  if (typeof next !== 'object' || next === null) return [];
  return Object.entries(next).flatMap(([branch, target]) =>
    typeof target === 'string' ? [[branch, target] as const] : [],
  );
}

/** The step a step goes to when it fails, if it names one. */
const failurePath = (step: AutomationStep): string | undefined =>
  typeof step.onFailure === 'object' ? step.onFailure.goTo : undefined;

/** Every step a step can lead to: where its next leads, and where it goes when it fails. */
function stepsAfter(step: AutomationStep): readonly string[] {
  const failed = failurePath(step);
  return [...nextOf(step).map(([, target]) => target), ...(failed === undefined ? [] : [failed])];
}

class Collector {
  readonly errors: AutomationIssue[] = [];
  readonly warnings: AutomationIssue[] = [];
  error(path: string, code: string, message: string, more: { suggestion?: string } = {}): void {
    this.errors.push({ path, code, message, ...more });
  }
  warn(path: string, code: string, message: string, more: { suggestion?: string } = {}): void {
    this.warnings.push({ path, code, message, ...more });
  }
}

function zodIssues(error: z.ZodError, collect: Collector, input: unknown): void {
  for (const issue of error.issues) {
    const path = pointer(
      ...issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
    );
    if (
      path === '/start' &&
      typeof input === 'object' &&
      input !== null &&
      (!('start' in input) || input.start === undefined)
    ) {
      collect.error(path, 'invalid', 'Add the first action to choose where this workflow starts.', {
        suggestion: 'Choose Add the first action in the builder.',
      });
      continue;
    }
    // An unknown step or trigger type gets the closest real one.
    const last = issue.path.at(-1);
    if (last === 'type' && issue.code === 'invalid_union') {
      const given = issue.path.reduce<unknown>(
        (value, part) =>
          typeof value === 'object' &&
          value !== null &&
          (typeof part === 'string' || typeof part === 'number')
            ? (value as Record<string | number, unknown>)[part]
            : undefined,
        input,
      );
      const types =
        issue.path[0] === 'triggers'
          ? Object.keys(automationTriggerTypes)
          : Object.keys(automationStepTypes);
      collect.error(
        path,
        'unknown_type',
        `${String(given)} is not a ${issue.path[0] === 'triggers' ? 'trigger' : 'step'} type.`,
        {
          ...suggest(typeof given === 'string' ? closest(given, types) : undefined),
        },
      );
      continue;
    }
    collect.error(path, 'invalid', issue.message);
  }
}

/**
 * Checks a document against the format and this business's setup. Valid documents come
 * back normalized: names resolved to ids, field paths canonical (contact.custom.<key>) and
 * each step's typeVersion added. The author's own text is never rewritten.
 */
export function validateAutomation(
  input: unknown,
  setup: AutomationSetup,
  /**
   * Which automation the document is, by id, when it is one that exists. With it, a step
   * that would start the automation itself, or close a loop through what the others have
   * published, is refused; without it no loop can be told, and none is looked for.
   */
  self: { readonly automationId?: string | undefined } = {},
): AutomationValidation {
  const collect = new Collector();
  const parsed = automationDocument.safeParse(input);
  if (!parsed.success) {
    zodIssues(parsed.error, collect, input);
    // An unfinished draft is still told that nothing starts it.
    if (
      typeof input === 'object' &&
      input !== null &&
      'triggers' in input &&
      Array.isArray(input.triggers) &&
      input.triggers.length === 0
    )
      collect.warn('/triggers', 'no_trigger', NO_TRIGGER);
    return { valid: false, errors: collect.errors, warnings: collect.warnings };
  }
  // Zod builds fresh objects, arrays and records for its output (zod 4.6.5,
  // v4/core/schemas.js), and these schemas are strict, so nothing here is the caller's.
  const document = parsed.data;
  const resolveField = fieldResolver(setup, document.triggers);
  const stepIds = Object.keys(document.steps);

  const resolveReference = (
    path: string,
    kind: Reference,
    given: string,
    list = REFERENCE_LISTS[kind](setup),
  ): string | undefined => {
    // A setup that can't tell which trigger links exist leaves the reference as written.
    if (kind === 'triggerLink' && setup.triggerLinks === undefined) return given;
    const byId = list.find((item) => item.id === given);
    if (byId !== undefined) return byId.id;
    const byName = list.filter(
      (item) => item.name.trim().toLowerCase() === given.trim().toLowerCase(),
    );
    if (byName.length === 1) return byName[0]?.id;
    if (byName.length > 1) {
      collect.error(
        path,
        'ambiguous_reference',
        `More than one ${REFERENCE_NOUNS[kind]} is named "${given}".`,
        {
          suggestion: 'Use its id instead.',
        },
      );
      return undefined;
    }
    collect.error(path, 'unknown_reference', `There's no ${REFERENCE_NOUNS[kind]} "${given}".`, {
      ...suggest(
        closest(
          given,
          list.map((item) => item.name),
        ),
      ),
    });
    return undefined;
  };

  // A stage belongs to a pipeline: the one given, else the only pipeline that has it.
  const resolveStage = (
    path: string,
    given: string,
    pipelineId: string | undefined,
  ): string | undefined => {
    const pipelines =
      pipelineId === undefined
        ? setup.pipelines
        : setup.pipelines.filter((pipeline) => pipeline.id === pipelineId);
    const stages = pipelines.flatMap((pipeline) => pipeline.stages);
    return resolveReference(path, 'stage', given, stages);
  };

  // The first place the document reads the touch of the event that started the run, and
  // the first place it reads the submission that did.
  let readsArrival: string | undefined;
  let readsSubmission: string | undefined;
  const checkField = (path: string, given: string): ResolvedField | undefined => {
    if (given.startsWith('trigger.attribution.')) readsArrival ??= path;
    if (isSubmissionPath(given)) readsSubmission ??= path;
    const result = resolveField(given);
    if (result.kind === 'error') {
      collect.error(
        path,
        'unknown_field',
        result.message,
        result.suggestion === undefined ? {} : { suggestion: result.suggestion },
      );
      return undefined;
    }
    return result.field;
  };

  const checkValue = (
    path: string,
    field: ResolvedField,
    value: unknown,
    operator: string,
  ): unknown => {
    if (
      ['number', 'money'].includes(field.type) &&
      operator !== 'includes' &&
      typeof value !== 'number'
    ) {
      collect.error(
        path,
        'wrong_value_type',
        `${field.path} holds numbers; compare it with a number.`,
      );
      return value;
    }
    if (field.type === 'boolean' && typeof value !== 'boolean') {
      collect.error(
        path,
        'wrong_value_type',
        `${field.path} is yes or no; compare it with true or false.`,
      );
      return value;
    }
    if (
      ['date', 'datetime'].includes(field.type) &&
      (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    ) {
      collect.error(
        path,
        'wrong_value_type',
        `${field.path} holds dates; compare it with a date such as 2026-12-01.`,
      );
      return value;
    }
    if (field.options.length > 0 && typeof value === 'string') {
      const option = field.options.find(
        (each) => each.key === value || each.label.toLowerCase() === value.toLowerCase(),
      );
      if (option === undefined) {
        collect.error(path, 'unknown_option', `"${value}" is not an option of ${field.path}.`, {
          ...suggest(
            closest(
              value,
              field.options.map((each) => each.label),
            ),
          ),
        });
        return value;
      }
      return option.key;
    }
    return value;
  };

  // A computed value fits the field it is written to, and reads fields of the right kind.
  const checkComputed = (
    path: string,
    target: ResolvedField,
    computed: AutomationComputedValue,
  ): AutomationComputedValue => {
    const dated = ['date', 'datetime'].includes(target.type);
    if (computed.op === 'math') {
      if (!['number', 'money'].includes(target.type))
        collect.error(
          path,
          'wrong_field_type',
          `Arithmetic gives a number, and ${target.path} isn't a number field.`,
        );
      const operand = (side: 'left' | 'right'): number | string => {
        const given = computed[side];
        if (typeof given === 'number') return given;
        const field = checkField(`${path}/${side}`, given);
        if (field === undefined) return given;
        if (!['number', 'money'].includes(field.type))
          collect.error(`${path}/${side}`, 'wrong_field_type', `${field.path} isn't a number.`);
        return field.path;
      };
      if (computed.operator === '/' && computed.right === 0)
        collect.error(`${path}/right`, 'division_by_zero', 'Nothing can be divided by zero.');
      return { ...computed, left: operand('left'), right: operand('right') };
    }
    if (!dated)
      collect.error(
        path,
        'wrong_field_type',
        `${computed.op === 'now' ? 'now' : 'date_add'} gives a date, and ${target.path} isn't a date field.`,
      );
    if (computed.op === 'now') return computed;
    if (computed.field !== undefined && computed.value !== undefined)
      collect.error(
        `${path}/value`,
        'date_base_given_twice',
        'Count from a field or from a fixed date, not both.',
        { suggestion: 'Remove field, or remove value.' },
      );
    if (computed.field === undefined) return computed;
    const from = checkField(`${path}/field`, computed.field);
    if (from === undefined) return computed;
    if (!['date', 'datetime'].includes(from.type))
      collect.error(`${path}/field`, 'wrong_field_type', `${from.path} isn't a date.`);
    return { ...computed, field: from.path };
  };

  // What field.changed's `to` names: a value of the field's own kind, as a comparison's is,
  // with a choice given by its label made its key. Empty text is "changed to nothing".
  const checkChangedTo = (path: string, field: ResolvedField, to: unknown): unknown =>
    to === '' ? to : checkValue(path, field, to, 'equals');

  const checkCondition = (path: string, condition: AutomationCondition): AutomationCondition => {
    if ('all' in condition)
      return {
        all: condition.all.map((each, index) =>
          checkCondition(`${path}/all/${String(index)}`, each),
        ),
      };
    if ('any' in condition)
      return {
        any: condition.any.map((each, index) =>
          checkCondition(`${path}/any/${String(index)}`, each),
        ),
      };
    if ('not' in condition) return { not: checkCondition(`${path}/not`, condition.not) };
    const field = checkField(`${path}/field`, condition.field);
    if (field === undefined) return condition;
    const allowed = OPERATOR_TYPES[condition.operator];
    if (allowed !== 'any' && allowed !== undefined && !allowed.includes(field.type)) {
      collect.error(
        `${path}/operator`,
        'wrong_operator',
        `${condition.operator} doesn't apply to ${field.path}.`,
      );
      return { ...condition, field: field.path };
    }
    if ('value' in condition && !['within_last', 'within_next'].includes(condition.operator))
      return {
        ...condition,
        field: field.path,
        value: checkValue(`${path}/value`, field, condition.value, condition.operator) as never,
      };
    return { ...condition, field: field.path };
  };

  const stepOutputs = new Map(
    stepIds.map((id) => [
      id,
      automationStepTypes[document.steps[id]?.type ?? 'wait'].outputs.map(
        (output): string => output.key,
      ),
    ]),
  );
  const triggerOutputs = new Set(
    document.triggers.flatMap((trigger) =>
      automationTriggerTypes[trigger.type].outputs.map((output): string => output.key),
    ),
  );

  // Checks every {{token}} in the author's text, and rewrites only tokens that resolve to a
  // different canonical path, leaving the rest of the text as it was.
  const checkText = (path: string, text: string, email = false): string =>
    text.replace(MERGE_TOKEN, (token, reference: string) => {
      const [head, ...rest] = reference.split('.');
      // An email's own unsubscribe address, put in as the email leaves.
      if (email && reference === EMAIL_UNSUBSCRIBE_MERGE_FIELD) return token;
      if (head === 'trigger' && rest[0] === 'attribution') readsArrival ??= path;
      if (isSubmissionPath(reference)) readsSubmission ??= path;
      if (
        head === 'contact' ||
        head === 'deal' ||
        head === 'appointment' ||
        isAttributionPath(reference) ||
        isSubmissionPath(reference)
      ) {
        const result = resolveField(reference);
        if (result.kind === 'error') {
          collect.error(
            path,
            'unknown_merge_field',
            `${reference} is not a field.`,
            result.suggestion === undefined ? {} : { suggestion: result.suggestion },
          );
          return token;
        }
        return result.field.path === reference ? token : `{{${result.field.path}}}`;
      }
      // custom_values.<key> is the key Settings shows for a custom value; values.<key> is
      // the same value under its older name. Both are left as the author wrote them.
      if (head === 'values' || head === 'custom_values') {
        const key = rest.join('.');
        if (!setup.values.includes(key))
          collect.error(path, 'unknown_merge_field', `${reference} is not a custom value.`, {
            ...suggest(closest(key, setup.values)),
          });
        return token;
      }
      if (head === 'steps') {
        const [stepId = '', output = ''] = rest;
        const outputs = stepOutputs.get(stepId);
        if (outputs === undefined || rest.length !== 2 || !outputs.includes(output))
          collect.error(path, 'unknown_merge_field', `${reference} is not an output of a step.`, {
            ...suggest(outputs === undefined ? closest(stepId, stepIds) : closest(output, outputs)),
          });
        return token;
      }
      if (head === 'trigger') {
        if (rest.length !== 1 || !triggerOutputs.has(rest[0] ?? ''))
          collect.error(
            path,
            'unknown_merge_field',
            `${reference} is not something the triggers provide.`,
            {
              ...suggest(closest(rest.join('.'), [...triggerOutputs])),
            },
          );
        return token;
      }
      // A trigger link, by its key: the send turns it into the contact's own address for it.
      if (head === 'trigger_link') {
        const keys = setup.triggerLinks?.map((link) => link.key);
        const key = rest.join('.');
        if (keys !== undefined && !keys.includes(key))
          collect.error(path, 'unknown_merge_field', `${reference} is not a trigger link.`, {
            ...suggest(closest(key, keys)),
          });
        return token;
      }
      // The merge keys of a deal's and a company's fields exist, but a step runs for one
      // contact: nothing says which deal or company it would read.
      if (head === 'opportunity' || head === 'business') {
        collect.error(
          path,
          'unknown_merge_field',
          `${reference} can't be filled in: a step has the contact's fields and the business's custom values only.`,
        );
        return token;
      }
      collect.error(path, 'unknown_merge_field', `${reference} is not a merge field.`, {
        suggestion:
          'Merge fields start with contact., deal., appointment., custom_values., values., trigger_link., steps. or trigger.',
      });
      return token;
    });

  // A webhook step's headers: each named once, each secret one the business has, and each
  // written value's merge fields checked as any text is.
  const checkWebhookHeaders = (
    path: string,
    headers: readonly WebhookHeader[],
  ): readonly WebhookHeader[] => {
    const seen = new Set<string>();
    return headers.map((header, index) => {
      const at = `${path}/${String(index)}`;
      const name = header.name.toLowerCase();
      if (!isAllowedWebhookHeader(header.name))
        collect.error(
          `${at}/name`,
          'reserved_header',
          `The webhook sets ${header.name} itself, or it belongs to the connection: choose another name.`,
        );
      if (seen.has(name))
        collect.error(`${at}/name`, 'duplicate_header', `The header ${header.name} is set twice.`);
      seen.add(name);
      if ('secret' in header) {
        const known = setup.webhookSecrets;
        if (known !== undefined && !known.includes(header.secret))
          collect.error(
            `${at}/secret`,
            'unknown_secret',
            `There is no webhook secret named ${header.secret}.`,
            { ...suggest(closest(header.secret, known)) },
          );
        return header;
      }
      return { ...header, value: checkText(`${at}/value`, header.value) };
    });
  };

  // A key in a webhook's URL is kept in the document, its versions and every run's history.
  const warnSecretInUrl = (path: string, url: string): void => {
    // The query string's names, read without a URL parser: the contracts run anywhere.
    const query = /^[^?#]*\?([^#]*)/.exec(url)?.[1] ?? '';
    const named = query
      .split('&')
      .map((pair) => {
        const name = (pair.split('=')[0] ?? '').replace(/\+/g, ' ');
        try {
          return decodeURIComponent(name);
        } catch {
          return name;
        }
      })
      .filter((key) => SECRET_QUERY_KEYS.has(key.toLowerCase()));
    if (named.length > 0)
      collect.warn(
        path,
        'secret_in_url',
        `The web address holds ${named.join(', ')}, which looks like a secret: the address is kept in the workflow and its run history. Store it as a webhook secret and send it in a header, such as Authorization.`,
      );
  };

  // Which automation leads to which starting: X leads to Y when a step of X starts Y, or
  // when Y starts as a run of X ends. The others' edges are what they have published; this
  // document's own are what it says now, whatever the same automation published before.
  const own = self.automationId;
  const named = new Map(setup.automations.map((each) => [each.id, each]));
  const nameOf = (id: string) => named.get(id)?.name ?? id;
  // A reference as the id it would resolve to, without reporting anything.
  const quietId = (given: string): string => {
    if (named.has(given)) return given;
    const byName = setup.automations.filter(
      (each) => each.name.trim().toLowerCase() === given.trim().toLowerCase(),
    );
    return byName.length === 1 && byName[0] !== undefined ? byName[0].id : given;
  };
  const ownStarts = Object.values(document.steps).flatMap((step) =>
    step.type === 'automation.run' ? [quietId(step.config.automation)] : [],
  );
  const ownStartsAfter = document.triggers.flatMap((trigger) =>
    trigger.type === 'automation.run_ended' ? trigger.config.automations.map(quietId) : [],
  );
  const leadsTo = (id: string): readonly string[] => [
    ...(id === own ? ownStarts : (named.get(id)?.starts ?? [])),
    ...(own !== undefined && ownStartsAfter.includes(id) ? [own] : []),
    ...setup.automations.flatMap((each) =>
      each.id !== own && (each.startsAfter ?? []).includes(id) ? [each.id] : [],
    ),
  ];
  // The automations on a way from one to another, the last being `to`; nothing when
  // there is no way.
  const wayFrom = (from: string, to: string): readonly string[] | undefined => {
    const seen = new Set<string>();
    const walk = (id: string): readonly string[] | undefined => {
      if (id === to) return [];
      if (seen.has(id)) return undefined;
      seen.add(id);
      for (const next of leadsTo(id)) {
        const rest = walk(next);
        if (rest !== undefined) return [next, ...rest];
      }
      return undefined;
    };
    return walk(from);
  };
  // What starting an automation from this one would loop through, in words, if it would:
  // the automation itself, or a way back to it. The other side's publish runs the same
  // check, so a loop can't be made in two steps.
  const loopThrough = (target: string): string | undefined => {
    if (own === undefined) return undefined;
    if (target === own) return 'This automation would start itself.';
    const back = wayFrom(target, own);
    if (back === undefined) return undefined;
    // The document's name is what its author sees, at both ends of the loop.
    const through = [
      document.name,
      nameOf(target),
      ...back.slice(0, -1).map(nameOf),
      document.name,
    ];
    return `Starting "${nameOf(target)}" would loop: ${through.join(' → ')}.`;
  };
  // The same for starting when a run of another automation ends.
  const loopAfter = (source: string): string | undefined => {
    if (own === undefined) return undefined;
    if (source === own) return 'This automation would start whenever one of its own runs ended.';
    const there = wayFrom(own, source);
    if (there === undefined) return undefined;
    const through = [document.name, ...there.map(nameOf), document.name];
    return `Starting when "${nameOf(source)}" ends would loop: ${through.join(' → ')}.`;
  };

  // Triggers: unique ids, references, filters.
  const seenTriggers = new Set<string>();
  document.triggers = document.triggers.map((trigger, index): AutomationTrigger => {
    const path = pointer('triggers', index);
    if (setup.unavailableTriggers.includes(trigger.type))
      collect.error(
        path,
        'trigger_unavailable',
        `Nothing starts an automation on "${automationTriggerTypes[trigger.type].label}" yet.`,
        { suggestion: 'Remove this trigger, or use one that is available.' },
      );
    if (seenTriggers.has(trigger.id))
      collect.error(`${path}/id`, 'duplicate_id', `Another trigger is already ${trigger.id}.`);
    seenTriggers.add(trigger.id);
    const config: Record<string, unknown> = { ...trigger.config };
    for (const [key, kind] of Object.entries(TRIGGER_REFERENCES[trigger.type] ?? {})) {
      const given = config[key];
      if (typeof given === 'string')
        config[key] = resolveReference(`${path}/config/${key}`, kind, given) ?? given;
    }
    // A form that exists and is not published takes no submission: said as what to do,
    // not as a form that is not there.
    if (trigger.type === 'form.submitted') {
      const named = setup.forms.find((form) => form.id === config['form']);
      if (named?.status === 'draft')
        collect.warn(
          `${path}/config/form`,
          'form_draft',
          `This form is a draft: publish it to receive submissions. Until then nothing starts this workflow from "${named.name}".`,
        );
    }
    for (const [key, kind] of Object.entries(TRIGGER_REFERENCE_LISTS[trigger.type] ?? {})) {
      const given = config[key];
      if (Array.isArray(given))
        config[key] = given.map((each: unknown, index) =>
          typeof each === 'string'
            ? (resolveReference(`${path}/config/${key}/${String(index)}`, kind, each) ?? each)
            : each,
        );
    }
    if (trigger.type === 'automation.run_ended') {
      const sources = Array.isArray(config['automations']) ? config['automations'] : [];
      sources.forEach((source: unknown, index) => {
        const loop = typeof source === 'string' ? loopAfter(source) : undefined;
        if (loop !== undefined)
          collect.error(`${path}/config/automations/${String(index)}`, 'automation_loop', loop, {
            suggestion: 'Name a different automation, or remove it from this trigger.',
          });
      });
      if (
        trigger.config.stoppedBy !== undefined &&
        trigger.config.how !== undefined &&
        !trigger.config.how.includes('stopped')
      )
        collect.error(
          `${path}/config/stoppedBy`,
          'never_matches',
          'Only a run a stop condition ended has an event that stopped it: add "stopped" to how, or remove stoppedBy.',
        );
    }
    if (trigger.type === 'deal.stage_changed' && typeof config['stage'] === 'string')
      config['stage'] =
        resolveStage(
          `${path}/config/stage`,
          config['stage'],
          typeof config['pipeline'] === 'string' ? config['pipeline'] : undefined,
        ) ?? config['stage'];
    if (
      (trigger.type === 'field.changed' || trigger.type === 'date.reached') &&
      typeof config['field'] === 'string'
    ) {
      const field = checkField(`${path}/config/field`, config['field']);
      if (field !== undefined && isSubmissionPath(field.path))
        // An answer is sent once, with its submission.
        collect.error(
          `${path}/config/field`,
          'wrong_field',
          `${field.path} is part of a form submission, which this trigger can't watch.`,
          {
            suggestion: 'Start on the form instead, and add a condition on the answer.',
          },
        );
      else if (field !== undefined && isAttributionPath(field.path))
        // A touch is recorded, never changed, and is no date of the contact's to come round.
        collect.error(
          `${path}/config/field`,
          'wrong_field',
          `${field.path} is attribution, which this trigger can't watch.`,
          {
            suggestion:
              'Start on the form or the booking instead, and filter by lead source or add a condition on it.',
          },
        );
      else if (field !== undefined) {
        config['field'] = field.path;
        if (trigger.type === 'field.changed' && config['to'] !== undefined)
          config['to'] = checkChangedTo(`${path}/config/to`, field, config['to']);
        if (trigger.type === 'date.reached' && !['date', 'datetime'].includes(field.type))
          collect.error(`${path}/config/field`, 'wrong_field_type', `${field.path} isn't a date.`);
        // A date and time fires at its own instant, once: it has no time of day to set and
        // no day of the year of its own.
        if (trigger.type === 'date.reached' && field.type === 'datetime') {
          if (trigger.config.time !== undefined)
            collect.error(
              `${path}/config/time`,
              'time_not_allowed',
              `${field.path} is a date and time, which fires at its own time.`,
              { suggestion: 'Remove time, or move it with offset.' },
            );
          if (trigger.config.repeat === 'yearly')
            collect.error(
              `${path}/config/repeat`,
              'repeat_not_allowed',
              `${field.path} is a date and time, which fires once.`,
              { suggestion: 'Set repeat to never.' },
            );
        }
      }
    }
    if (
      trigger.type === 'date.reached' &&
      trigger.config.repeat === 'yearly' &&
      document.settings.reEnrollment === 'never'
    )
      collect.warn(
        `${path}/config/repeat`,
        'repeats_but_enrols_once',
        'This date comes round every year, but the automation takes a contact once ever. Let contacts go through again (settings.reEnrollment: after_finished), or set repeat to never.',
      );
    const filtered =
      trigger.if === undefined ? {} : { if: checkCondition(`${path}/if`, trigger.if) };
    return { ...trigger, config, ...filtered } as AutomationTrigger;
  });

  if (document.triggers.length === 0) collect.warn('/triggers', 'no_trigger', NO_TRIGGER);

  document.stopWhen = document.stopWhen.map((stop, index) =>
    stop.if === undefined
      ? stop
      : { ...stop, if: checkCondition(pointer('stopWhen', index, 'if'), stop.if) },
  );
  // A stop on a reply to the run's own messages needs a step that sends one.
  document.stopWhen.forEach((stop, index) => {
    if (
      'repliedTo' in stop &&
      stop.repliedTo !== undefined &&
      !Object.values(document.steps).some((step) => MESSAGE_STEPS[step.type] !== undefined)
    )
      collect.warn(
        pointer('stopWhen', index, 'repliedTo'),
        'stop_never_applies',
        'This stop applies to a reply to a message this workflow sent, and no step here sends one, so it never applies.',
      );
  });

  // Flow: start, every next, branch names, reachability, loops, waits.
  if (!stepIds.includes(document.start))
    collect.error('/start', 'unknown_step', `There's no step ${document.start}.`, {
      ...suggest(closest(document.start, stepIds)),
    });
  // The one goal step a workflow may have (GoHighLevel documents one per workflow).
  const goalStep = stepIds.find((id) => document.steps[id]?.type === 'goal');
  for (const [id, step] of Object.entries(document.steps)) {
    const path = pointer('steps', id);
    // What the step does when it fails: a path to a step that exists and is another one,
    // and "continue" only where there is one next step to go on to.
    const failed = failurePath(step);
    if (failed === id)
      collect.error(
        `${path}/onFailure/goTo`,
        'failure_path_to_itself',
        'A step cannot go to itself when it fails.',
        { suggestion: 'Use retry to try the step again, or name another step.' },
      );
    else if (failed !== undefined && !stepIds.includes(failed))
      collect.error(`${path}/onFailure/goTo`, 'unknown_step', `There's no step ${failed}.`, {
        ...suggest(closest(failed, stepIds)),
      });
    if (step.onFailure === 'continue' && (step.type === 'goto' || typeof step.next === 'object'))
      collect.error(
        `${path}/onFailure`,
        'on_failure_not_for_step',
        step.type === 'goto'
          ? 'A Go To has no next step to go on to. Name the step with goTo.'
          : 'This step has branches, so "continue" has no one next step to go on to. Name the step with goTo.',
        { suggestion: 'Use { "goTo": "<step>" } instead.' },
      );
    if (step.retry !== undefined) {
      if (!(automationRetryableSteps as readonly string[]).includes(step.type))
        collect.error(
          `${path}/retry`,
          'retry_not_for_step',
          `A ${automationStepTypes[step.type].label.toLowerCase()} step is not retried: only steps that change a record or queue a message are.`,
          { suggestion: 'Remove retry from this step.' },
        );
      if (
        step.retry.wait !== undefined &&
        maxDurationDays(step.retry.wait) * 24 > MAX_RETRY_WAIT_HOURS
      )
        collect.error(
          `${path}/retry/wait`,
          'retry_wait_too_long',
          `A retry waits at most ${String(MAX_RETRY_WAIT_HOURS)} hours.`,
        );
    }
    for (const [branch, target] of nextOf(step))
      if (!stepIds.includes(target))
        collect.error(
          step.type === 'goto'
            ? `${path}/config/target`
            : branch === null
              ? `${path}/next`
              : `${path}/next/${branch}`,
          'unknown_step',
          `There's no step ${target}.`,
          {
            ...suggest(closest(target, stepIds)),
          },
        );
    if (step.type === 'goto' && step.next !== undefined)
      collect.error(
        `${path}/next`,
        'goto_has_next',
        'A Go To ends its path: it leads to its target and nowhere else.',
        { suggestion: 'Remove next from this step.' },
      );
    if (step.type === 'goal' && goalStep !== undefined && id !== goalStep)
      collect.error(
        path,
        'more_than_one_goal',
        `A workflow has one goal step, and ${goalStep} is it.`,
        {
          suggestion: 'List every event that meets the goal in that step, and remove this one.',
        },
      );
    if (step.type === 'condition') {
      const names = automationBranchNames('condition', step.config) ?? [];
      if ('branches' in step.config) {
        const own = step.config.branches.map((branch) => branch.name);
        if (new Set(own).size !== own.length)
          collect.error(`${path}/config`, 'duplicate_branch', 'Each branch needs its own name.');
        own.forEach((name, index) => {
          if (name === CONDITION_FALLBACK)
            collect.error(
              `${path}/config/branches/${String(index)}/name`,
              'reserved_branch',
              `${CONDITION_FALLBACK} is the branch taken when no other holds, so no branch can be named it.`,
              { suggestion: 'Give this branch another name.' },
            );
        });
      }
      for (const [branch] of nextOf(step))
        if (branch !== null && !names.includes(branch))
          collect.error(
            `${path}/next/${branch}`,
            'unknown_branch',
            `${branch} is not one of this step's branches: ${names.join(', ')}.`,
            { ...suggest(closest(branch, names)) },
          );
    }
    if (step.type === 'split' || step.type === 'ai.classify') {
      const names =
        step.type === 'split'
          ? step.config.variants.map((variant) => variant.name)
          : step.config.categories;
      if (new Set(names).size !== names.length)
        collect.error(`${path}/config`, 'duplicate_branch', 'Each branch needs its own name.');
      for (const [branch] of nextOf(step))
        if (branch !== null && !names.includes(branch))
          collect.error(
            `${path}/next/${branch}`,
            'unknown_branch',
            `${branch} is not one of this step's ${step.type === 'split' ? 'variants' : 'categories'}.`,
            {
              ...suggest(closest(branch, names)),
            },
          );
      if (step.type === 'split') {
        const total = step.config.variants.reduce((sum, variant) => sum + variant.percent, 0);
        if (total !== 100)
          collect.error(
            `${path}/config/variants`,
            'split_total',
            `The percentages add up to ${String(total)}, not 100.`,
          );
      }
    }
    // The longest a timing step can hold an enrolment, and the config key that sets it.
    const held: readonly [number, string] | undefined =
      step.type === 'wait'
        ? [maxDurationDays(step.config.duration), 'duration']
        : step.type === 'wait.event' || step.type === 'wait.condition'
          ? [maxDurationDays(step.config.timeout), 'timeout']
          : (step.type === 'wait.until' || step.type === 'wait.appointment') &&
              'offset' in step.config &&
              step.config.offset !== undefined
            ? [maxDurationDays(step.config.offset), 'offset']
            : undefined;
    if (held !== undefined && held[0] > MAX_WAIT_DAYS)
      collect.error(
        `${path}/config/${held[1]}`,
        'wait_too_long',
        `A wait can last at most ${String(MAX_WAIT_DAYS)} days.`,
      );
  }

  const reachable = new Set<string>();
  // A run comes to the goal step when the goal is met, so it is an entry beside the start.
  const queue = stepIds.includes(document.start)
    ? [document.start, ...(goalStep === undefined ? [] : [goalStep])]
    : [];
  while (queue.length > 0) {
    const id = queue.shift() ?? '';
    if (reachable.has(id)) continue;
    reachable.add(id);
    const step = document.steps[id];
    if (step !== undefined)
      for (const target of stepsAfter(step)) if (stepIds.includes(target)) queue.push(target);
  }
  if (stepIds.includes(document.start))
    for (const id of stepIds)
      if (!reachable.has(id))
        collect.error(pointer('steps', id), 'unreachable_step', `No path leads to ${id}.`, {
          suggestion: `Point a step's next at ${id}, or remove it.`,
        });

  // A loop must wait somewhere, or it would run without end: find every cycle (Tarjan).
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let counter = 0;
  const components: string[][] = [];
  const connect = (id: string): void => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    const step = document.steps[id];
    for (const target of step === undefined ? [] : stepsAfter(step)) {
      if (!stepIds.includes(target)) continue;
      if (!index.has(target)) {
        connect(target);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target))
        low.set(id, Math.min(low.get(id) ?? 0, index.get(target) ?? 0));
    }
    if (low.get(id) === index.get(id)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member !== undefined) {
          onStack.delete(member);
          component.push(member);
        }
      } while (member !== undefined && member !== id);
      components.push(component);
    }
  };
  for (const id of stepIds) if (!index.has(id)) connect(id);
  for (const component of components) {
    const [first] = component;
    const loops =
      component.length > 1 ||
      (first !== undefined &&
        stepsAfter(document.steps[first] ?? ({} as AutomationStep)).some(
          (target) => target === first,
        ));
    if (!loops || first === undefined) continue;
    const members = [...component].sort();
    if (
      !component.some((id) => {
        const type = document.steps[id]?.type;
        return type !== undefined && WAIT_STEPS.has(type);
      })
    )
      collect.error(
        pointer('steps', members[0] ?? first),
        'loop_without_wait',
        `The steps ${members.join(', ')} loop without a wait.`,
        {
          suggestion: 'Add a wait step inside the loop.',
        },
      );
    // Each time round, a loop must wait an hour at least: a wait of no time, or until a
    // fixed moment that passes once, lets it go round at once.
    else if (
      !component.some((id) => {
        const step = document.steps[id];
        return step !== undefined && waitsAnHour(step);
      })
    )
      collect.error(
        pointer('steps', members[0] ?? first),
        'loop_wait_too_short',
        `The steps ${members.join(', ')} loop, and their waits can end in less than an hour each time round. A loop must wait at least an hour (${LOOP_MIN_WAIT}); the engine holds it to that anyway.`,
        {
          suggestion:
            'Make a wait in the loop an hour or longer, or wait for an event, a condition or a date field with a timeout of an hour or more.',
        },
      );
  }

  // A goal's event with what it names resolved, as the trigger of its type is resolved.
  const resolveGoalEvent = (path: string, event: AutomationGoalEvent): AutomationGoalEvent => {
    const config: Record<string, unknown> = { ...event.config };
    for (const [key, kind] of Object.entries(TRIGGER_REFERENCES[event.type] ?? {})) {
      const given = config[key];
      if (typeof given === 'string')
        config[key] = resolveReference(`${path}/${key}`, kind, given) ?? given;
    }
    if (event.type === 'deal.stage_changed' && typeof config['stage'] === 'string')
      config['stage'] =
        resolveStage(
          `${path}/stage`,
          config['stage'],
          typeof config['pipeline'] === 'string' ? config['pipeline'] : undefined,
        ) ?? config['stage'];
    if (event.type === 'field.changed') {
      const field = checkField(`${path}/field`, event.config.field);
      if (field !== undefined && isSubmissionPath(field.path))
        collect.error(
          `${path}/field`,
          'wrong_field',
          `${field.path} is part of a form submission, which is sent once and never changes.`,
        );
      else if (field !== undefined && isAttributionPath(field.path))
        collect.error(
          `${path}/field`,
          'wrong_field',
          `${field.path} is attribution, which is recorded once and never changes.`,
        );
      else if (field !== undefined) {
        config['field'] = field.path;
        if (config['to'] !== undefined)
          config['to'] = checkChangedTo(`${path}/to`, field, config['to']);
      }
    }
    return { ...event, config } as AutomationGoalEvent;
  };

  // Whether every run of the workflow is about one appointment of the contact.
  const aboutAnAppointment =
    document.triggers.length > 0 &&
    document.triggers.every((trigger) =>
      (automationAppointmentTriggers as readonly string[]).includes(trigger.type),
    );
  // Setup: references, fields, merge fields, connected channels and AI.
  for (const id of stepIds) {
    const step = document.steps[id];
    if (step === undefined) continue;
    const path = pointer('steps', id);
    const config: Record<string, unknown> = { ...step.config };
    for (const [key, kind] of Object.entries(STEP_REFERENCES[step.type] ?? {})) {
      const given = config[key];
      if (typeof given === 'string')
        config[key] = resolveReference(`${path}/config/${key}`, kind, given) ?? given;
    }
    // A transactional message is one about the appointment the contact booked, such as a
    // reminder (workflow-email-content.ts): only a run an appointment started is about one.
    const transactional =
      (step.type === 'email.send' || step.type === 'sms.send') &&
      config['purpose'] === 'transactional';
    if (transactional && !aboutAnAppointment)
      collect.error(
        `${path}/config/purpose`,
        'transactional_needs_appointment',
        'Only a workflow that starts when an appointment is booked or its status changes can send a transactional message: the message is then about the contact’s own appointment.',
        {
          suggestion:
            'Send it as marketing, or start the workflow with Appointment booked or Appointment status changed alone.',
        },
      );
    // Every other workflow email is marketing email: its footer shows the business's postal
    // address, which US law asks of commercial email. A profile without one still sends;
    // the owner is told at each such step.
    if (step.type === 'email.send' && !transactional && setup.postalAddress === false)
      collect.warn(
        path,
        'no_postal_address',
        'Your business profile has no postal address. US law (CAN-SPAM) asks every marketing email to show a valid postal address: add yours in Settings → Business profile and it is added to the end of this email. The email is still sent without it.',
      );
    // A step that syncs with a template sends that template: one that is not in this
    // business's library (an import from elsewhere, or archived since) cannot send, and is
    // never taken for a working link. A copy's provenance is only that.
    if (step.type === 'email.send' && config['mode'] === 'sync') {
      const linked = (config['source'] as { id?: unknown } | undefined)?.id;
      if (!setup.emailTemplates.some((template) => template.id === linked))
        collect.error(
          `${path}/config/source`,
          'unknown_reference',
          'The template this step syncs with is not in the library, or is archived.',
          { suggestion: 'Choose a template to sync with, or turn sync off.' },
        );
    }
    for (const [key, kind] of Object.entries(STEP_REFERENCE_LISTS[step.type] ?? {})) {
      const given = config[key];
      if (Array.isArray(given))
        config[key] = given.map((each: unknown, index) =>
          typeof each === 'string'
            ? (resolveReference(`${path}/config/${key}/${String(index)}`, kind, each) ?? each)
            : each,
        );
    }
    // A team that takes turns names each member once: twice would give them two turns.
    if (step.type === 'owner.assign' && Array.isArray(config['users'])) {
      const members: unknown[] = config['users'];
      members.forEach((member, index) => {
        if (members.indexOf(member) !== index)
          collect.error(
            `${path}/config/users/${String(index)}`,
            'duplicate_member',
            'This team member is already in the list; each takes one turn.',
            { suggestion: 'Remove the repeat.' },
          );
      });
    }
    if (step.type === 'automation.run' && typeof config['automation'] === 'string') {
      const loop = loopThrough(config['automation']);
      if (loop !== undefined)
        collect.error(`${path}/config/automation`, 'automation_loop', loop, {
          suggestion: 'Start a different automation, or remove this step.',
        });
    }
    if (
      (step.type === 'deal.create' || step.type === 'deal.move' || step.type === 'deal.find') &&
      typeof config['stage'] === 'string'
    )
      config['stage'] =
        resolveStage(
          `${path}/config/stage`,
          config['stage'],
          typeof config['pipeline'] === 'string' ? config['pipeline'] : undefined,
        ) ?? config['stage'];
    if (step.type === 'deal.create' && step.config.amountFrom !== undefined) {
      const amountPath = `${path}/config/amountFrom`;
      if (step.config.amount !== undefined)
        collect.error(
          amountPath,
          'amount_given_twice',
          'Give the opportunity a fixed amount or take it from a field, not both.',
          { suggestion: 'Remove amount, or remove amountFrom.' },
        );
      const field = checkField(amountPath, step.config.amountFrom);
      if (field !== undefined) {
        config['amountFrom'] = field.path;
        // The deal is created for the contact, so the amount is read from the contact.
        if (!field.path.startsWith('contact.'))
          collect.error(amountPath, 'wrong_field', `${field.path} is not a contact field.`);
        else if (!['number', 'money'].includes(field.type))
          collect.error(amountPath, 'wrong_field_type', `${field.path} isn't a number.`);
      }
    }
    if (step.type === 'deal.find' && step.config.customField !== undefined) {
      const given = step.config.customField;
      const fieldPath = `${path}/config/customField/field`;
      const field = checkField(fieldPath, given.field);
      if (field !== undefined) {
        if (!field.path.startsWith('deal.custom.'))
          collect.error(
            fieldPath,
            'wrong_field',
            `${field.path} is not a custom field of an opportunity.`,
            {
              suggestion:
                'Name one as deal.custom.<key>; the other filters cover the built-in ones.',
            },
          );
        config['customField'] = {
          field: field.path,
          equals: checkValue(`${path}/config/customField/equals`, field, given.equals, 'equals'),
        };
      }
    }
    if (step.type === 'deal.update') {
      const given = step.config;
      if (Object.values(given).every((value) => value === undefined))
        collect.error(
          `${path}/config`,
          'nothing_to_update',
          'Say what to change on the opportunity.',
          {
            suggestion: 'Add name, amount, owner, expectedCloseDate, source, status or fields.',
          },
        );
      if (given.amountFrom !== undefined) {
        const amountPath = `${path}/config/amountFrom`;
        if (given.amount !== undefined)
          collect.error(
            amountPath,
            'amount_given_twice',
            'Give the opportunity a fixed amount or take it from a field, not both.',
            { suggestion: 'Remove amount, or remove amountFrom.' },
          );
        const field = checkField(amountPath, given.amountFrom);
        if (field !== undefined) {
          config['amountFrom'] = field.path;
          if (!field.path.startsWith('contact.'))
            collect.error(amountPath, 'wrong_field', `${field.path} is not a contact field.`);
          else if (!['number', 'money'].includes(field.type))
            collect.error(amountPath, 'wrong_field_type', `${field.path} isn't a number.`);
        }
      }
      if (
        typeof given.expectedCloseDate === 'object' &&
        given.expectedCloseDate !== null &&
        maxDurationDays(given.expectedCloseDate.in) > MAX_CLOSE_DATE_DAYS
      )
        collect.error(
          `${path}/config/expectedCloseDate/in`,
          'date_too_far',
          `An expected close date is at most ${String(MAX_CLOSE_DATE_DAYS / 365)} years ahead.`,
        );
      if (given.fields !== undefined) {
        const fields: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(given.fields)) {
          const fieldPath = `${path}/config/fields/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
          const field = checkField(fieldPath, name);
          if (field === undefined) {
            fields[name] = value;
            continue;
          }
          if (!field.path.startsWith('deal.custom.'))
            collect.error(
              fieldPath,
              'wrong_field',
              `${field.path} is not a custom field of an opportunity.`,
              {
                suggestion:
                  "Custom fields are deal.custom.<key>; a deal's name, value, owner, close date and source have settings of their own.",
              },
            );
          fields[field.path] =
            value === null ? null : checkValue(fieldPath, field, value, 'equals');
        }
        config['fields'] = fields;
      }
    }
    if (step.type === 'condition') {
      if ('branches' in step.config)
        config['branches'] = step.config.branches.map((branch, index) => ({
          ...branch,
          if: checkCondition(`${path}/config/branches/${String(index)}/if`, branch.if),
        }));
      else config['if'] = checkCondition(`${path}/config/if`, step.config.if);
    }
    if (step.type === 'goal')
      config['events'] = step.config.events.map((event, index) =>
        resolveGoalEvent(`${path}/config/events/${String(index)}/config`, event),
      );
    if (step.type === 'wait.until' && 'field' in step.config) {
      const field = checkField(`${path}/config/field`, step.config.field);
      if (field !== undefined) {
        config['field'] = field.path;
        if (!['date', 'datetime'].includes(field.type))
          collect.error(`${path}/config/field`, 'wrong_field_type', `${field.path} isn't a date.`);
      }
    }
    if (step.type === 'wait.condition')
      config['if'] = checkCondition(`${path}/config/if`, step.config.if);
    if (step.type === 'wait.event') {
      // Each filter belongs to one event: on another it could never be judged.
      if (step.config.channel !== undefined && step.config.event !== 'message.received')
        collect.error(
          `${path}/config/channel`,
          'filter_not_for_event',
          'A channel can be chosen only when the wait is for message.received.',
          { suggestion: 'Remove channel, or wait for message.received.' },
        );
      if (step.config.link !== undefined) {
        if (step.config.event !== 'trigger_link.clicked')
          collect.error(
            `${path}/config/link`,
            'filter_not_for_event',
            'A trigger link can be chosen only when the wait is for trigger_link.clicked.',
            { suggestion: 'Remove link, or wait for trigger_link.clicked.' },
          );
        else
          config['link'] =
            resolveReference(`${path}/config/link`, 'triggerLink', step.config.link) ??
            step.config.link;
      }
    }
    // A resume window that opens and closes at the same time is never open: the run would
    // never go on from the wait.
    if ('resumeWindow' in step.config && step.config.resumeWindow !== undefined) {
      const { start, end } = step.config.resumeWindow;
      if (start === end)
        collect.error(
          `${path}/config/resumeWindow/end`,
          'empty_resume_window',
          `The resume window opens and closes at ${start}, so it is never open.`,
          {
            suggestion:
              'Give it an end after its start, or an end before its start for a window that runs past midnight.',
          },
        );
    }
    if (step.type === 'contact.update') {
      const fields: Record<string, unknown> = {};
      for (const [given, value] of Object.entries(step.config.fields)) {
        const fieldPath = `${path}/config/fields/${given.replaceAll('~', '~0').replaceAll('/', '~1')}`;
        const field = checkField(fieldPath, given);
        if (field === undefined) {
          fields[given] = value;
          continue;
        }
        if (!field.path.startsWith('contact.'))
          collect.error(fieldPath, 'wrong_field', `${field.path} is not a contact field.`);
        else if (!field.writable)
          collect.error(
            fieldPath,
            'read_only_field',
            `${field.path} can't be set by an automation.`,
          );
        // Written alone, or under `set` beside onlyIfEmpty: the value is checked the same.
        const wrapped = typeof value === 'object' && value !== null && 'set' in value;
        const written = wrapped ? value.set : value;
        const valuePath = wrapped ? `${fieldPath}/set` : fieldPath;
        const checked =
          written === null
            ? null
            : typeof written === 'object'
              ? checkComputed(valuePath, field, written)
              : typeof written === 'string' && HAS_MERGE_TOKEN.test(written)
                ? // Filled in as the step runs, and fitted to the field then.
                  checkText(valuePath, written)
                : checkValue(valuePath, field, written, 'equals');
        fields[field.path] = wrapped ? { ...value, set: checked } : checked;
      }
      config['fields'] = fields;
    }
    for (const key of [
      'message',
      'title',
      'notes',
      'reason',
      'text',
      'prompt',
      'instructions',
      'body',
      'subject',
      'name',
      'source',
      // What a Send email step says about its email.
      'html',
      'preheader',
      'fromName',
      'replyTo',
    ]) {
      const text = config[key];
      if (typeof text === 'string')
        config[key] = checkText(`${path}/config/${key}`, text, step.type === 'email.send');
    }
    // Each address in Cc and Bcc may be one merge field.
    for (const key of ['cc', 'bcc']) {
      const list = config[key];
      if (Array.isArray(list))
        config[key] = list.map((each: unknown, index) =>
          typeof each === 'string'
            ? checkText(`${path}/config/${key}/${String(index)}`, each)
            : each,
        );
    }
    if (step.type === 'email.verify' && setup.emailVerification === false)
      collect.error(
        path,
        'verification_off',
        'Turn on email verification in Settings → Email Services → Email Verification before using this step.',
      );
    if (setup.unavailableSteps.includes(step.type))
      collect.error(
        path,
        'step_unavailable',
        `${automationStepTypes[step.type].label} steps are not available yet.`,
        { suggestion: 'Remove this step, or use a step that is available.' },
      );
    const channel = MESSAGE_STEPS[step.type];
    if (channel !== undefined && !setup.channels[channel])
      collect.error(
        path,
        'no_provider',
        `Connect ${channel === 'email' ? 'a mailbox' : channel === 'sms' ? 'an SMS number' : 'WhatsApp'} before sending from this step.`,
      );
    if (automationStepTypes[step.type].group === 'ai' && !setup.ai)
      collect.error(path, 'no_ai_key', 'Add an AI key before using AI steps.');
    if (step.type === 'webhook.call' && !setup.webhooks)
      collect.error(
        path,
        'no_webhook_secret',
        'Create a webhook signing secret before sending from this step.',
      );
    if (step.type === 'webhook.call') {
      if (step.config.headers !== undefined)
        config['headers'] = checkWebhookHeaders(`${path}/config/headers`, step.config.headers);
      warnSecretInUrl(`${path}/config/url`, step.config.url);
    }
    // A transactional message, such as a reminder, tells; it asks for no reply.
    if (channel !== undefined && nextOf(step).length === 0 && config['purpose'] !== 'transactional')
      collect.warn(
        path,
        'no_follow_up',
        'This path ends right after a message. Add a wait and a check-in if you expect a reply.',
      );
    document.steps[id] = {
      ...step,
      config,
      typeVersion: automationStepTypes[step.type].version,
    } as AutomationStep;
  }
  // The touch of the event that started the run exists only for a run a form submission or
  // a booking started: anything else reads every such path as empty.
  if (
    readsArrival !== undefined &&
    !document.triggers.some((trigger) =>
      (attributionTriggers as readonly string[]).includes(trigger.type),
    )
  )
    collect.warn(
      readsArrival,
      'no_arrival',
      'This reads how the lead arrived (trigger.attribution), which only a run started by a form submission or a booking has. No trigger here is one of those, so it is always empty.',
    );
  // The answers and the page exist only for a run a form submission started.
  if (
    readsSubmission !== undefined &&
    !document.triggers.some((trigger) =>
      (submissionTriggers as readonly string[]).includes(trigger.type),
    )
  )
    collect.warn(
      readsSubmission,
      'no_submission',
      'This reads what was sent with a form (trigger.answers, trigger.pageUrl), which only a run started by a form submission has. No trigger here is one, so it is always empty.',
    );
  // A step that changes what a trigger listens for. The engine starts no run from a change
  // made in the chain that started it, so neither this workflow's own change nor a loop
  // through another workflow goes round; the author is told where it would have.
  const touches = automationTouches(document);
  const tagName = (id: string) => setup.tags.find((tag) => tag.id === id)?.name ?? id;
  const listening = (key: string) =>
    Math.max(
      0,
      document.triggers.findIndex((trigger) => triggerListens(trigger) === key),
    );
  const selfTriggered = touches.writes.filter((key) => touches.listens.includes(key));
  if (selfTriggered.length > 0 && document.settings.reEnrollment !== 'never')
    collect.warn(
      pointer('triggers', listening(selfTriggered[0] ?? '')),
      'self_trigger',
      `A step of this workflow ${selfTriggered.map((key) => touchWords(key, tagName)).join(' and ')}, which its trigger listens for. A run's own change never starts the workflow again, so this will not loop; to repeat on purpose, use a Go To with a wait.`,
    );
  // Through other workflows: this one's change starts another, whose changes, perhaps by way
  // of more, start this one again.
  if (own !== undefined) {
    const others = setup.automations.filter((each) => each.id !== own);
    const feeds = (writes: readonly string[], listens: readonly string[] | undefined) =>
      writes.some((key) => (listens ?? []).includes(key));
    const seen = new Set<string>();
    const queue: { readonly id: string; readonly path: readonly string[] }[] = others
      .filter((each) => feeds(touches.writes, each.listens))
      .map((each) => ({ id: each.id, path: [each.id] }));
    let loop: readonly string[] | undefined;
    while (loop === undefined && queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next.id)) continue;
      seen.add(next.id);
      const writes = named.get(next.id)?.writes ?? [];
      if (feeds(writes, touches.listens)) loop = next.path;
      else
        for (const each of others)
          if (!seen.has(each.id) && feeds(writes, each.listens))
            queue.push({ id: each.id, path: [...next.path, each.id] });
    }
    if (loop !== undefined) {
      const through = [document.name, ...loop.map(nameOf), document.name];
      collect.warn(
        pointer('triggers', 0),
        'automation_loop',
        `This workflow's changes start "${nameOf(loop[0] ?? '')}", whose changes start this one again: ${through.join(' → ')}. A change made in the chain that started a run never starts the same workflow again for the record, so it goes round once at most.`,
      );
    }
  }

  // A sending window that opens and closes at the same time is never open: every message
  // step would wait for ever. An end before the start is a window that runs past midnight.
  const window = document.settings.sendingWindow;
  if (window !== undefined && window.start === window.end)
    collect.error(
      pointer('settings', 'sendingWindow', 'end'),
      'empty_sending_window',
      `The sending window opens and closes at ${window.start}, so it is never open.`,
      {
        suggestion:
          'Give it an end after its start, or an end before its start for a window that runs past midnight.',
      },
    );
  for (const id of Object.keys(document.layout ?? {}))
    if (!stepIds.includes(id))
      collect.warn(
        pointer('layout', id),
        'unknown_layout_step',
        `The layout places ${id}, which is not a step.`,
      );

  return collect.errors.length === 0
    ? { valid: true, errors: [], warnings: collect.warnings, document }
    : { valid: false, errors: collect.errors, warnings: collect.warnings };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The document for another business or install: each reference by name, since ids mean
 * nothing elsewhere, to be resolved again when the import is validated. A reference that
 * can't be named exactly once here stays as written, with a warning. Works on unfinished
 * drafts too, and never changes its input.
 */
export function portableAutomation(
  input: Readonly<Record<string, unknown>>,
  setup: AutomationSetup,
): { document: Record<string, unknown>; warnings: AutomationIssue[] } {
  const warnings: AutomationIssue[] = [];
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const nameOf = (
    path: string,
    kind: Reference,
    given: string,
    list: readonly AutomationNamed[],
  ): string => {
    const byId = list.find((item) => item.id === given);
    if (byId !== undefined && list.filter((item) => same(item.name, byId.name)).length === 1)
      return byId.name;
    // Already a name: it goes out as written.
    if (byId === undefined && list.some((item) => same(item.name, given))) return given;
    warnings.push({
      path,
      code: 'not_portable',
      message:
        byId === undefined
          ? `There's no ${REFERENCE_NOUNS[kind]} "${given}" to name.`
          : `More than one ${REFERENCE_NOUNS[kind]} is named "${byId.name}", so it stays an id.`,
    });
    return given;
  };
  const portable = (
    path: string,
    node: unknown,
    references: Readonly<Record<string, Readonly<Record<string, Reference>> | undefined>>,
    hasStage: (type: string) => boolean,
    lists: Readonly<Record<string, Readonly<Record<string, Reference>> | undefined>> = {},
  ): unknown => {
    if (!isRecord(node) || typeof node['type'] !== 'string' || !isRecord(node['config']))
      return node;
    const config = { ...node['config'] };
    const given = node['config'];
    for (const [key, kind] of Object.entries(references[node['type']] ?? {})) {
      const value = given[key];
      if (typeof value === 'string')
        config[key] = nameOf(`${path}/config/${key}`, kind, value, REFERENCE_LISTS[kind](setup));
    }
    if (hasStage(node['type']) && typeof given['stage'] === 'string') {
      // A stage belongs to a pipeline: the one given, by id or name, else any pipeline.
      const pipeline = given['pipeline'];
      const pipelines =
        typeof pipeline === 'string'
          ? setup.pipelines.filter((item) => item.id === pipeline || same(item.name, pipeline))
          : setup.pipelines;
      config['stage'] = nameOf(
        `${path}/config/stage`,
        'stage',
        given['stage'],
        pipelines.flatMap((item) => item.stages),
      );
    }
    for (const [key, kind] of Object.entries(lists[node['type']] ?? {})) {
      const values = given[key];
      if (Array.isArray(values))
        config[key] = values.map((value: unknown, index) =>
          typeof value === 'string'
            ? nameOf(
                `${path}/config/${key}/${String(index)}`,
                kind,
                value,
                REFERENCE_LISTS[kind](setup),
              )
            : value,
        );
    }
    return { ...node, config };
  };
  const document: Record<string, unknown> = { ...input };
  if (Array.isArray(input['triggers']))
    document['triggers'] = input['triggers'].map((trigger: unknown, index) =>
      portable(
        pointer('triggers', index),
        trigger,
        TRIGGER_REFERENCES,
        (type) => type === 'deal.stage_changed',
        TRIGGER_REFERENCE_LISTS,
      ),
    );
  if (isRecord(input['steps']))
    document['steps'] = Object.fromEntries(
      Object.entries(input['steps']).map(([id, step]) => {
        const path = pointer('steps', id);
        const named = portable(
          path,
          step,
          STEP_REFERENCES,
          (type) => type === 'deal.create' || type === 'deal.move' || type === 'deal.find',
          STEP_REFERENCE_LISTS,
        );
        // A goal's events name what a trigger of their type names.
        if (
          !isRecord(named) ||
          named['type'] !== 'goal' ||
          !isRecord(named['config']) ||
          !Array.isArray(named['config']['events'])
        )
          return [id, named];
        const events = named['config']['events'].map((event: unknown, index) =>
          portable(
            `${path}/config/events/${String(index)}`,
            event,
            TRIGGER_REFERENCES,
            (type) => type === 'deal.stage_changed',
          ),
        );
        return [id, { ...named, config: { ...named['config'], events } }];
      }),
    );
  return { document, warnings };
}
