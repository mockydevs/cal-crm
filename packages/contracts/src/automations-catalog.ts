// What an automation can use (AUTOMATIONS.md section 3): each trigger and step type with
// its config, the branches it can take and what it outputs for later steps. The document
// schema and the published catalog are both built from these definitions.
import * as z from 'zod';

import {
  automationCondition,
  automationKey,
  automationReference,
  conditionOperators,
  fieldPath,
  isoDuration,
  mergeText,
  resumeWindow,
  timeOfDay,
} from './automations-values.js';
import { noteDocumentFromText } from './note-text.js';
import { noteDocument } from './note-document.js';
import { DO_NOT_CONTACT_REASON_MAX, DO_NOT_CONTACT_REASON_MIN } from './do-not-contact-reason.js';
import type { OfferedDndChannel } from './contact-attributes.js';
import { MAX_CONTACT_FOLLOWERS } from './contact-details.js';
import {
  arrivalSessionSources,
  DEAL_SOURCE_ARRIVAL,
  MAX_TRIGGER_SOURCES,
} from './automations-attribution.js';
import { automationFieldWrite } from './automations-field-writes.js';
import { automationStepGroups } from './automations-step-groups.js';
import { webhookHeaders } from './automations-webhook-secrets.js';
import { scoreCalculations, scoreComparisons, SCORING_LIMITS } from './scoring-limits.js';
import { workflowEmailStepConfig, workflowMessagePurpose } from './workflow-email-content.js';

/** What a trigger or step makes available to later steps, as merge fields. */
export interface AutomationOutput {
  readonly key: string;
  readonly type: 'string' | 'number' | 'boolean' | 'id' | 'date';
  readonly description: string;
}

/** Which branch names a step's next can use. */
export type AutomationBranches =
  | { readonly kind: 'none' }
  | { readonly kind: 'fixed'; readonly names: readonly string[] }
  /** One branch per name listed in this config field. */
  | {
      readonly kind: 'from_config';
      readonly field: string;
      /** A branch such a step always has besides: the one taken when no named one is. */
      readonly fallback?: string;
      /** The branches of a step whose config has no such field: the type's older shape. */
      readonly legacy?: readonly string[];
    };

export { automationStepGroups };

interface StepDefinition {
  readonly group: (typeof automationStepGroups)[number];
  readonly version: number;
  readonly label: string;
  readonly description: string;
  readonly config: z.ZodType;
  readonly branches: AutomationBranches;
  readonly outputs: readonly AutomationOutput[];
}

interface TriggerDefinition {
  readonly label: string;
  readonly description: string;
  readonly config: z.ZodType;
  readonly outputs: readonly AutomationOutput[];
}

const none = { kind: 'none' } as const;

/** The most days a Task Reminder trigger may fire before or after a task's due time. */
export const MAX_TASK_REMINDER_DAYS = 365;

/** Which way do not disturb works: on what is sent to the contact, or on what they send. */
const dndDirection = z
  .enum(['outbound', 'inbound'])
  .optional()
  .meta({ description: 'outbound (left out) or inbound, which takes no channel.' });
/**
 * Every channel at once, or one: the contact page's channels (offeredDndChannels), written
 * out here so the automation pages do not load the contact's attributes with the catalog.
 * A test holds the two lists together.
 */
const dndChannelChoices = ['all', 'email', 'sms', 'call', 'webchat'] as const satisfies readonly (
  'all' | OfferedDndChannel
)[];
const dndChannel = z
  .enum(dndChannelChoices)
  .optional()
  .meta({ description: 'Outbound only: all, or one channel.' });
const INBOUND_IS_ONE_SETTING = 'Inbound do not disturb has no channels to choose.';

/** The team members a followers step names, by membership id or name, each once. */
const followerUsers = z
  .array(automationReference)
  .min(1)
  .max(MAX_CONTACT_FOLLOWERS)
  .meta({
    description: `1 to ${String(MAX_CONTACT_FOLLOWERS)} team members, by membership id or name.`,
  });
const sentMessage = [
  { key: 'messageId', type: 'id', description: 'The message sent.' },
] as const satisfies readonly AutomationOutput[];

const manualOutcome = [
  { key: 'outcome', type: 'string', description: 'completed or skipped.' },
] as const satisfies readonly AutomationOutput[];

const dateTarget = {
  field: fieldPath,
  offset: isoDuration.optional(),
  direction: z.enum(['before', 'after']).default('before'),
  time: timeOfDay.optional(),
};

// Named apart from the catalog below, which refers to them: a trigger can ask which of
// these events stopped a run.
const stopEvents = [
  'message.received',
  'form.submitted',
  'appointment.booked',
  'appointment.status_changed',
  'deal.stage_changed',
  'deal.closed',
  'field.changed',
  'tag.added',
] as const;
/** Events that can stop an automation for a contact (stopWhen): real events, not timers. */
export const automationStopEvents = stopEvents satisfies readonly AutomationTriggerType[];

// What a wait for an event can wait for: the stop events, and a trigger link being opened.
const waitEvents = [...stopEvents, 'trigger_link.clicked'] as const;
/** Events a wait.event step can wait for. */
export const automationWaitEvents = waitEvents satisfies readonly AutomationTriggerType[];

/** What a wait.until step does when its time has already passed: go on (the default) or end the run. */
export const automationPassedChoices = ['continue', 'end'] as const;

/**
 * What a wait.until step on a date field does while the field is empty: wait for a value
 * (the default, as ActiveCampaign's date wait does), go on at once, or end the run.
 */
export const automationEmptyChoices = ['wait', 'continue', 'end'] as const;

/** The most times a step is tried again after a failure that can pass with time. */
export const MAX_STEP_RETRIES = 5;

/** The longest wait before a step's first retry, in hours. */
export const MAX_RETRY_WAIT_HOURS = 24;

/** The most times a person may run one failed run again from its failed step. */
export const MAX_RUN_RETRIES = 5;

/**
 * The failures a step's retry applies to: each can pass with time, and each leaves nothing
 * of the failed attempt behind.
 */
export const automationRetryableFailures = [
  'conflict',
  'mailbox_unavailable',
  'number_unavailable',
] as const;

/** How a run can have ended, for the automation.run_ended trigger. */
export const automationRunEndings = ['stopped', 'removed', 'completed', 'failed'] as const;

/** The most automations an automation.run_ended trigger may name. */
export const MAX_RUN_ENDED_AUTOMATIONS = 20;

/** The most automations a message.received trigger may name as the ones replied to. */
export const MAX_REPLIED_TO = 20;

/** The most automations a removal step may list, to remove from or to leave running. */
export const MAX_REMOVE_AUTOMATIONS = 20;

/** The most branches a condition may name; the branch none comes besides. */
export const MAX_CONDITION_BRANCHES = 10;

/** The branch a condition with named branches takes when none of them holds. */
export const CONDITION_FALLBACK = 'none';

/** Which of the matching deals a deal.find step takes. */
export const dealFindOrders = ['newest', 'oldest'] as const;

/** The statuses a deal.find step may ask for. */
export const dealFindStatuses = ['open', 'won', 'lost', 'any'] as const;

/** How a deal.find step compares a deal's value with a number. */
export const dealValueOperators = ['equals', 'greater_than', 'less_than'] as const;

// Said of every step that acts on a deal: which deal that is.
const DEAL_IN_HAND =
  "It acts on the opportunity found or created earlier in the run, or the opportunity the run is for; otherwise on the contact's one open opportunity, and it fails when the contact has none or several.";

/** The most team members an owner.assign step may share contacts between. */
export const MAX_ASSIGN_USERS = 20;

/**
 * Where an opportunity step takes the opportunity's source from: text with optional merge
 * fields, or how the lead arrived.
 */
export const dealSourceSetting = z.union([
  mergeText(200),
  z.strictObject({ from: z.literal(DEAL_SOURCE_ARRIVAL) }).meta({
    description:
      "From how they arrived: the lead source of the form submission or booking that started this run (trigger.attribution.source), else the contact's Source; a run with neither leaves the opportunity without one.",
  }),
]);

// The filters a trigger whose event comes with a touch can add (a form, a booking): the
// lead source and the session source of that touch.
const arrivalFilters = {
  sources: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(MAX_TRIGGER_SOURCES)
    .optional()
    .meta({
      description:
        'Only when the lead source of this submission or booking is one of these, such as ["Google Ads", "Facebook Ads"]; capitals do not matter. Left out, any.',
    }),
  sessionSources: z
    .array(z.enum(arrivalSessionSources))
    .min(1)
    .max(arrivalSessionSources.length)
    .optional()
    .meta({
      description:
        'Only when the session source of this submission or booking is one of these, such as ["paid_search"]. Left out, any.',
    }),
};

const onlyIfUnassigned = z.boolean().meta({
  description:
    'true: a contact that already has an owner is left alone, and the step says so. Left out or false: the owner is replaced.',
});

/** The most events a goal step may list; any one of them meets the goal. */
export const MAX_GOAL_EVENTS = 10;

/**
 * The most times a run visits one step, and the most step jobs a run takes in all. A run
 * that would pass either fails where it stands, so a path that leads back cannot run for
 * ever.
 */
export const MAX_STEP_VISITS = 100;
export const MAX_RUN_STEPS = 5000;

/**
 * The least time between two visits of one step in a run: a loop must wait at least this
 * long each time round. The validator refuses a loop whose waits can all end sooner, and
 * the engine holds a step it would visit again sooner until this has passed since its last
 * visit, so a loop whose wait ended at once (a condition already true, a date already past)
 * still goes round once an hour at most.
 */
export const LOOP_MIN_WAIT = 'PT1H';
export const LOOP_MIN_WAIT_MS = 3_600_000;

// Every step type but the goal, whose events are the triggers' own and so come after them.
const stepTypesBeforeGoal = {
  'email.send': {
    group: 'messages',
    version: 1,
    label: 'Send email',
    description:
      'Send an email from a template or content written in the step, as plain or formatted text. Consent, quiet hours and sending limits apply.',
    config: workflowEmailStepConfig,
    branches: none,
    outputs: sentMessage,
  },
  'sms.send': {
    group: 'messages',
    version: 1,
    label: 'Send text',
    description: 'Send a text message. Consent, quiet hours and sending limits apply.',
    config: z.strictObject({
      message: mergeText(1600),
      /** The number to send from; left out, the business's only number is used. */
      number: automationReference.optional(),
      purpose: workflowMessagePurpose,
    }),
    branches: none,
    outputs: sentMessage,
  },
  'whatsapp.send': {
    group: 'messages',
    version: 1,
    label: 'Send WhatsApp message',
    description: 'Send an approved WhatsApp template. Consent and sending limits apply.',
    config: z.strictObject({ template: automationReference }),
    branches: none,
    outputs: sentMessage,
  },
  'team.notify': {
    group: 'messages',
    version: 1,
    label: 'Notify the team',
    description: "Notify the contact's owner, or everyone in the business, inside the app.",
    config: z.strictObject({
      message: mergeText(1000),
      /**
       * contact_owner tells the owner, and nobody when the contact has none;
       * owner_or_everyone tells the owner, or everyone when the contact has none.
       */
      to: z.enum(['contact_owner', 'everyone', 'owner_or_everyone']).default('contact_owner'),
    }),
    branches: none,
    outputs: [],
  },
  'manual.call': {
    group: 'messages',
    version: 1,
    label: 'Manual call',
    description:
      'Ask a person to call the contact. The run waits in the Manual Actions queue until the call is marked done or skipped.',
    config: z.strictObject({
      /** What to say or ask, shown to whoever places the call. */
      notes: mergeText(2000).optional(),
      /** Who places it; left out, the contact's owner, or anyone when there is none. */
      user: automationReference.optional(),
    }),
    branches: none,
    outputs: manualOutcome,
  },
  'manual.sms': {
    group: 'messages',
    version: 1,
    label: 'Manual text',
    description:
      'Ask a person to send the contact a text by hand. The run waits in the Manual Actions queue until it is marked done or skipped.',
    config: z.strictObject({
      message: mergeText(1600),
      /** Who sends it; left out, the contact's owner, or anyone when there is none. */
      user: automationReference.optional(),
    }),
    branches: none,
    outputs: manualOutcome,
  },
  wait: {
    group: 'timing',
    version: 1,
    label: 'Wait',
    description:
      'Wait for a length of time before the next step. With a resume window, the run goes on only inside it.',
    config: z.strictObject({ duration: isoDuration, resumeWindow: resumeWindow.optional() }),
    branches: none,
    outputs: [],
  },
  'wait.until': {
    group: 'timing',
    // Version 2 added ifEmpty, whose default is to wait for a value. A step stored at
    // version 1 goes on at once while its field is empty, as it always did. At any version
    // a change to the field while the run waits moves the wait.
    version: 2,
    label: 'Wait until',
    description:
      'Wait until a date field, or a time before or after it, such as 2 days before an event. When that time has already passed, the run goes on at once or ends there, whichever you choose.',
    config: z.union([
      z.strictObject({
        ...dateTarget,
        ifPassed: z.enum(automationPassedChoices).optional(),
        ifEmpty: z.enum(automationEmptyChoices).optional(),
        resumeWindow: resumeWindow.optional(),
      }),
      z.strictObject({
        at: z.iso.datetime({ offset: true }),
        ifPassed: z.enum(automationPassedChoices).optional(),
        resumeWindow: resumeWindow.optional(),
      }),
    ]),
    branches: none,
    outputs: [],
  },
  'wait.event': {
    group: 'timing',
    version: 1,
    label: 'Wait for an event',
    description:
      'Wait until something happens for the contact, such as a reply or a trigger link being opened, or until the timeout passes.',
    config: z.strictObject({
      event: z.enum(waitEvents),
      /** For message.received: only messages from the contact count. */
      from: z.literal('contact').optional(),
      /** For message.received: only a message on this channel counts. */
      channel: z.enum(['email', 'sms', 'whatsapp', 'webchat']).optional().meta({
        description: 'With message.received: only a message on this channel counts.',
      }),
      /** For trigger_link.clicked: only this trigger link counts; left out, any of them. */
      link: automationReference.optional().meta({
        description: 'With trigger_link.clicked: only this trigger link; left out, any of them.',
      }),
      timeout: isoDuration,
      resumeWindow: resumeWindow.optional(),
    }),
    branches: { kind: 'fixed', names: ['received', 'timed_out'] },
    outputs: [{ key: 'eventId', type: 'id', description: 'The event that arrived.' }],
  },
  'wait.condition': {
    group: 'timing',
    version: 1,
    label: 'Wait for a condition',
    description:
      "Wait until a condition on the contact holds, judged again each time the contact's fields or tags change, or until the timeout passes.",
    config: z.strictObject({
      if: automationCondition,
      timeout: isoDuration,
      resumeWindow: resumeWindow.optional(),
    }),
    branches: { kind: 'fixed', names: ['met', 'timed_out'] },
    outputs: [],
  },
  'wait.appointment': {
    group: 'timing',
    // Version 2 takes an appointment marked no-show or invalid as one that will not take
    // place, as a cancelled one always was: no reminder is sent for it. A step stored at
    // version 1 goes on waiting for such an appointment, as it always did.
    version: 2,
    label: 'Wait for an appointment',
    description:
      "Wait until the contact's appointment starts, or a time before or after it: the appointment that started the run, otherwise the contact's next one. A time that has already passed takes a path of its own, and so does a contact with no appointment or one that is cancelled, marked no-show or invalid. A rescheduled appointment moves the wait.",
    config: z.strictObject({
      offset: isoDuration.optional(),
      direction: z.enum(['before', 'after']).default('before'),
      resumeWindow: resumeWindow.optional(),
    }),
    branches: { kind: 'fixed', names: ['reached', 'passed', 'no_appointment'] },
    outputs: [
      { key: 'appointmentId', type: 'id', description: 'The appointment waited for.' },
      { key: 'startsAt', type: 'date', description: 'When that appointment starts.' },
    ],
  },
  condition: {
    group: 'logic',
    // Version 2 added named branches. The single condition is the first shape and stays
    // valid as it is: nothing rewrites a stored document.
    version: 2,
    label: 'If / else',
    description:
      'Take the first branch whose condition holds, in the order written; when none holds, take the branch kept for that. With a single condition, the branches are yes and no.',
    config: z.union([
      z.strictObject({ if: automationCondition }),
      z.strictObject({
        branches: z
          .array(
            z.strictObject({
              name: automationKey,
              /** What the branch is called on screen. */
              label: z.string().trim().min(1).max(80).optional(),
              if: automationCondition,
            }),
          )
          .min(1)
          .max(MAX_CONDITION_BRANCHES),
      }),
    ]),
    branches: {
      kind: 'from_config',
      field: 'branches',
      fallback: CONDITION_FALLBACK,
      legacy: ['yes', 'no'],
    },
    outputs: [],
  },
  goto: {
    group: 'logic',
    version: 1,
    label: 'Go to',
    description:
      'Jump to another step of this automation. It ends its path. A run visits one step 100 times at most.',
    config: z.strictObject({ target: automationKey }),
    branches: none,
    outputs: [],
  },
  split: {
    group: 'logic',
    version: 1,
    label: 'A/B split',
    description: 'Send each contact down one variant, by percentage.',
    config: z.strictObject({
      variants: z
        .array(z.strictObject({ name: automationKey, percent: z.int().min(1).max(99) }))
        .min(2)
        .max(5),
    }),
    branches: { kind: 'from_config', field: 'variants' },
    outputs: [{ key: 'variant', type: 'string', description: 'The variant taken.' }],
  },
  'contact.update': {
    group: 'records',
    // Version 2 added merge text as a value (so one field can be copied into another), the
    // computed values (now, date_add, math) and onlyIfEmpty. A fixed value is the first
    // shape and means what it always did.
    version: 2,
    label: 'Update contact',
    description:
      "Change one or more of the contact's fields. Each can take a value you type, a copy of another field, text with the contact's details filled in, the date the step runs, a date some days before or after another, or a sum. A field can be changed only when it is empty, if you choose. Either every field is changed or none is.",
    config: z.strictObject({
      fields: z.record(fieldPath, automationFieldWrite).meta({
        description:
          'The value for each field, by its path, such as { "contact.custom.lead_source_raw": "{{contact.custom.utm_source}}", "contact.custom.first_enquiry": { "set": { "op": "now" }, "onlyIfEmpty": true } }.',
      }),
    }),
    branches: none,
    outputs: [],
  },
  'deal.create': {
    group: 'records',
    // Version 2 added the source, which a step left without one takes from how the lead
    // arrived. A step stored at version 1 creates an opportunity without a source, as it
    // always did: nothing rewrites a stored document.
    version: 2,
    label: 'Create opportunity',
    description:
      "Create an opportunity for the contact in a pipeline stage. Its source is how the lead arrived (the lead source of the form submission or booking that started the run, else the contact's Source) unless you write one or choose none.",
    config: z.strictObject({
      pipeline: automationReference,
      stage: automationReference,
      name: mergeText(200).optional(),
      amount: z.number().min(0).optional(),
      /** Instead of a fixed amount: the contact's number field the amount is read from. */
      amountFrom: fieldPath.optional().meta({
        description:
          'A number field of the contact, such as contact.custom.budget: the deal takes its value as the amount when the step runs. Not together with amount. A field with nothing in it gives a deal without an amount.',
      }),
      source: dealSourceSetting.nullable().optional().meta({
        description:
          'Where the deal came from. Left out, or { "from": "arrival" }: how the lead arrived. Text with optional merge fields: that text. null: no source.',
      }),
    }),
    branches: none,
    outputs: [{ key: 'dealId', type: 'id', description: 'The deal created.' }],
  },
  'deal.move': {
    group: 'records',
    version: 1,
    label: 'Move opportunity',
    description: `Move an opportunity to another stage. ${DEAL_IN_HAND}`,
    config: z.strictObject({
      stage: automationReference,
      pipeline: automationReference.optional(),
    }),
    branches: none,
    outputs: [],
  },
  'deal.close': {
    group: 'records',
    version: 1,
    label: 'Close opportunity',
    description: `Close an opportunity as won, or as lost with a reason. ${DEAL_IN_HAND}`,
    config: z.union([
      z.strictObject({ outcome: z.literal('won') }),
      z.strictObject({ outcome: z.literal('lost'), lostReason: automationReference }),
    ]),
    branches: none,
    outputs: [],
  },
  'deal.find': {
    group: 'records',
    version: 1,
    label: 'Find opportunity',
    description:
      "Find one of the contact's opportunities: the newest or the oldest of those that pass every filter you add. When one is found, the steps that follow move, close and update that opportunity, and conditions and messages can read its name, stage, pipeline, status, value and custom fields. When none is found the run takes the other path and keeps the opportunity it already had, if any.",
    config: z.strictObject({
      which: z.enum(dealFindOrders).default('newest').meta({
        description: 'newest: the one created last (the default). oldest: the one created first.',
      }),
      pipeline: automationReference.optional().meta({
        description: 'Only deals in this pipeline, by id or name.',
      }),
      stage: automationReference.optional().meta({
        description: 'Only deals in this stage, by id or name.',
      }),
      status: z.enum(dealFindStatuses).optional().meta({
        description: 'Only open, won or lost deals; any, or left out, takes every status.',
      }),
      nameContains: z.string().trim().min(1).max(200).optional().meta({
        description: 'Only deals whose name contains this text, whatever its capitals.',
      }),
      value: z
        .strictObject({
          operator: z.enum(dealValueOperators),
          value: z.number().min(0),
        })
        .optional()
        .meta({
          description:
            'Only deals whose value compares so with a number, such as { "operator": "greater_than", "value": 1000 }. A deal without a value passes none.',
        }),
      customField: z
        .strictObject({
          field: fieldPath,
          equals: z.union([z.string().max(1000), z.number(), z.boolean()]),
        })
        .optional()
        .meta({
          description:
            'Only deals whose custom field holds this value, such as { "field": "deal.custom.service", "equals": "video" }.',
        }),
    }),
    branches: { kind: 'fixed', names: ['found', 'not_found'] },
    outputs: [
      { key: 'dealId', type: 'id', description: 'The deal found; absent when none passed.' },
    ],
  },
  'deal.update': {
    group: 'records',
    version: 1,
    label: 'Update opportunity',
    description: `Change an opportunity: its name, value, owner, expected close date, source or custom fields, or reopen one that was won or lost. Only what you choose is changed. ${DEAL_IN_HAND}`,
    config: z.strictObject({
      name: mergeText(200).optional(),
      amount: z.number().min(0).nullable().optional().meta({
        description:
          "The deal's value as a fixed number; null removes it. Not together with amountFrom.",
      }),
      amountFrom: fieldPath.optional().meta({
        description:
          'A number field of the contact, such as contact.custom.budget: the deal takes its value as the step runs. Not together with amount. A field with nothing in it leaves the value as it is.',
      }),
      owner: automationReference.nullable().optional().meta({
        description:
          "The team member who becomes the deal's owner, by membership id or name; null removes the owner.",
      }),
      expectedCloseDate: z
        .union([z.iso.date(), z.strictObject({ in: isoDuration })])
        .nullable()
        .optional()
        .meta({
          description:
            'When the deal is expected to close: a fixed date (2026-12-01), or { "in": "P30D" } for that long after the step runs, on the calendar of the automation\u2019s time zone; null removes it.',
        }),
      source: dealSourceSetting.nullable().optional().meta({
        description:
          'Where the deal came from: text with optional merge fields, or { "from": "arrival" } for how the lead arrived (a run with nothing to say of that leaves the source as it is); null removes it.',
      }),
      status: z.literal('open').optional().meta({
        description: 'open: reopen a deal that was won or lost. To close one, use deal.close.',
      }),
      fields: z
        .record(fieldPath, z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]))
        .optional()
        .meta({
          description:
            'Custom fields of the deal to set, by path, such as { "deal.custom.service": "video" }; null empties one.',
        }),
    }),
    branches: none,
    outputs: [{ key: 'dealId', type: 'id', description: 'The deal changed.' }],
  },
  'task.create': {
    group: 'records',
    version: 1,
    label: 'Create task',
    description: "Create a task for the contact's owner.",
    config: z.strictObject({
      title: mergeText(200),
      dueIn: isoDuration.optional(),
      notes: mergeText(2000).optional(),
    }),
    branches: none,
    outputs: [{ key: 'taskId', type: 'id', description: 'The task created.' }],
  },
  'note.create': {
    group: 'records',
    version: 1,
    label: 'Create note',
    description: 'Write a note on the record the run is for.',
    config: z.strictObject({
      text: mergeText(100000)
        .refine((text) => text.trim() !== '', { error: 'Write something in the note.' })
        .refine(
          (text) =>
            text.length <= 100000 && noteDocument.safeParse(noteDocumentFromText(text)).success,
          { error: 'Keep notes within 100,000 characters and 2,000 nodes.' },
        ),
    }),
    branches: none,
    outputs: [{ key: 'noteId', type: 'id', description: 'The note created.' }],
  },
  'owner.remove': {
    group: 'records',
    version: 1,
    label: 'Remove owner',
    description: 'Take the owner off the contact. The record of who owned it is kept.',
    config: z.strictObject({}),
    branches: none,
    outputs: [],
  },
  'dnd.set': {
    group: 'records',
    // Version 2 added the inbound direction, and calls and web chat beside email and text
    // messages. Every version 1 config is a version 2 config that means the same.
    version: 2,
    label: 'Set do not disturb',
    description:
      'Turn do not disturb on or off, with a reason: outbound, for every channel or one, or inbound, for what the contact sends in.',
    config: z
      .strictObject({
        direction: dndDirection,
        channel: dndChannel,
        action: z.enum(['enable', 'disable']),
        reason: mergeText(DO_NOT_CONTACT_REASON_MAX).trim().min(DO_NOT_CONTACT_REASON_MIN, {
          error: 'Say why, using 10 to 1,000 characters.',
        }),
      })
      .refine((config) => config.direction !== 'inbound' || config.channel === undefined, {
        path: ['channel'],
        error: INBOUND_IS_ONE_SETTING,
      })
      .refine((config) => config.direction === 'inbound' || config.channel !== undefined, {
        path: ['channel'],
        error: 'Choose every channel, or one channel.',
      }),
    branches: none,
    outputs: [],
  },
  'followers.add': {
    group: 'records',
    version: 1,
    label: 'Add contact followers',
    description: 'Make team members followers of the contact.',
    config: z.strictObject({ users: followerUsers }),
    branches: none,
    outputs: [],
  },
  'followers.remove': {
    group: 'records',
    version: 1,
    label: 'Remove contact followers',
    description: 'Take chosen team members, or every follower, off the contact.',
    config: z.union([
      z.strictObject({ users: followerUsers }),
      z.strictObject({
        all: z.literal(true).meta({ description: 'Every follower, former team members too.' }),
      }),
    ]),
    branches: none,
    outputs: [],
  },
  'score.modify': {
    group: 'records',
    version: 1,
    label: 'Modify Contact Engagement Score',
    description: 'Add or subtract engagement score points.',
    config: z.strictObject({
      calculation: z.enum(scoreCalculations),
      points: z.int().min(1).max(SCORING_LIMITS.points),
    }),
    branches: none,
    outputs: [
      {
        key: 'score',
        type: 'number',
        description: 'Score after change.',
      },
    ],
  },
  'email.verify': {
    group: 'records',
    version: 1,
    label: 'Email verification',
    description:
      "Check the contact's primary email address with the business's email verification. A valid, risky or invalid result recent enough, and from the mailbox while a provider is connected, is used as it is, at no cost. Skipped when the contact has no email address or the address is excluded from verification.",
    config: z.strictObject({
      address: z.literal('primary').default('primary').meta({
        description: "Which address is checked: the contact's primary email address.",
      }),
      maxAgeDays: z
        .int()
        .min(1, { error: 'Reuse results at least 1 day old.' })
        .max(365, { error: 'Reuse results at most 365 days old.' })
        .default(90)
        .meta({
          description:
            'A current result at most this many days old is used as it is, with no new check, whatever Re-verify after 90 days says. Left out, 90.',
        }),
    }),
    branches: none,
    outputs: [
      {
        key: 'status',
        type: 'string',
        description: 'valid, risky, invalid, unknown, unchecked or excluded.',
      },
      {
        key: 'depth',
        type: 'string',
        description:
          'mailbox when the provider checked the mailbox, domain when only the free checks ran; absent when nothing was checked.',
      },
    ],
  },
  'owner.assign': {
    group: 'records',
    // Version 2 added a team that takes turns (users) and onlyIfUnassigned. The single
    // user is the first shape and stays valid as it is: nothing rewrites a stored document.
    version: 2,
    label: 'Assign owner',
    description:
      'Make a team member the owner of the contact: one person, or several who take turns, each contact going to the member after the one the last contact went to. You can have a contact that already has an owner keep that owner.',
    config: z.union([
      z.strictObject({
        user: automationReference.meta({
          description: 'The one team member every contact goes to, by membership id or name.',
        }),
        onlyIfUnassigned: onlyIfUnassigned.optional(),
      }),
      z.strictObject({
        users: z.array(automationReference).min(1).max(MAX_ASSIGN_USERS).meta({
          description:
            'The team members who share the contacts in turn (round robin), by membership id or name, 1 to 20, each once. The turn is kept per step across runs and published versions; a member who has left the team is passed over.',
        }),
        onlyIfUnassigned: onlyIfUnassigned.optional(),
      }),
    ]),
    branches: none,
    outputs: [
      {
        key: 'membershipId',
        type: 'id',
        description:
          'The team member made the owner; absent when the contact kept the owner it had.',
      },
    ],
  },
  'tag.add': {
    group: 'records',
    version: 1,
    label: 'Add tag',
    description: 'Add a tag to the contact.',
    config: z.strictObject({ tag: automationReference }),
    branches: none,
    outputs: [],
  },
  'tag.remove': {
    group: 'records',
    version: 1,
    label: 'Remove tag',
    description: 'Remove a tag from the contact.',
    config: z.strictObject({ tag: automationReference }),
    branches: none,
    outputs: [],
  },
  'ai.ask': {
    group: 'ai',
    version: 1,
    label: 'Ask AI',
    description: 'Ask the AI a question; its answer feeds later steps.',
    config: z.strictObject({ prompt: mergeText(4000) }),
    branches: none,
    outputs: [{ key: 'answer', type: 'string', description: "The AI's answer." }],
  },
  'ai.classify': {
    group: 'ai',
    version: 1,
    label: 'Classify with AI',
    description: "Sort the contact's last reply into categories you name.",
    config: z.strictObject({
      categories: z.array(automationKey).min(2).max(10),
      instructions: mergeText(2000).optional(),
    }),
    branches: { kind: 'from_config', field: 'categories' },
    outputs: [{ key: 'category', type: 'string', description: 'The category chosen.' }],
  },
  'ai.draft_reply': {
    group: 'ai',
    version: 1,
    label: 'Draft a reply with AI',
    description:
      "Draft a reply to the contact, sent or held for review by the contact's autonomy setting.",
    config: z.strictObject({ instructions: mergeText(2000).optional() }),
    branches: none,
    outputs: [{ key: 'draftId', type: 'id', description: 'The draft written.' }],
  },
  'webhook.call': {
    group: 'connect',
    // Version 2 added headers. A step without them sends what it always did.
    version: 2,
    label: 'Call a webhook',
    description: 'Send a signed request to an outside app, with a timeout and retries.',
    config: z.strictObject({
      url: z
        .url({ protocol: /^https$/, error: 'Use an https:// address.' })
        .regex(/^https:\/\//, { error: 'Use an https:// address.' })
        .max(2000),
      method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
      body: mergeText(10000).optional(),
      headers: webhookHeaders.optional().meta({
        description: 'Headers: { name, value } or { name, secret } with a stored webhook secret.',
      }),
    }),
    branches: none,
    outputs: [{ key: 'status', type: 'number', description: "The response's HTTP status." }],
  },
  'automation.run': {
    group: 'connect',
    version: 1,
    label: 'Start another automation',
    description:
      'Enrol the contact in another automation, by its own rules: once if it enrols a contact once, and never twice at the same time. This automation goes on at once.',
    config: z.strictObject({ automation: automationReference }),
    branches: none,
    outputs: [
      {
        key: 'enrolmentId',
        type: 'id',
        description: 'The run it started; absent when nothing was started.',
      },
      {
        key: 'outcome',
        type: 'string',
        description: 'started, already_running, already_went_through, not_active or refused_loop.',
      },
    ],
  },
  'automation.remove': {
    group: 'connect',
    version: 1,
    label: 'Remove from automations',
    description:
      'End the runs the contact is in: this automation, the ones listed, every other one, or all of them. You can name automations whose runs are left going.',
    config: z.union([
      z.strictObject({ from: z.literal('current') }),
      z.strictObject({
        from: z.literal('automations'),
        automations: z.array(automationReference).min(1).max(MAX_REMOVE_AUTOMATIONS),
      }),
      z.strictObject({
        from: z.literal('all_others'),
        except: z.array(automationReference).max(MAX_REMOVE_AUTOMATIONS).optional(),
      }),
      z.strictObject({
        from: z.literal('all'),
        except: z.array(automationReference).max(MAX_REMOVE_AUTOMATIONS).optional(),
      }),
    ]),
    branches: none,
    outputs: [{ key: 'removed', type: 'number', description: 'How many runs it ended.' }],
  },
} as const satisfies Record<string, StepDefinition>;

const recordOutputs = (kind: string) =>
  [{ key: `${kind}Id`, type: 'id', description: `The ${kind} it happened to.` }] as const;

const documentOutputs = (kind: 'quote' | 'invoice') =>
  [{ key: 'documentId', type: 'id', description: `The ${kind}.` }] as const;

export const automationTriggerTypes = {
  'form.submitted': {
    label: 'Form submitted',
    description:
      'A form is submitted: the form named, or any form when none is. It can start only for leads that arrived from the lead sources or session sources you list.',
    config: z.strictObject({
      form: automationReference.optional().meta({
        description: 'Only this form, by id or name; left out, any form.',
      }),
      ...arrivalFilters,
    }),
    outputs: [{ key: 'submissionId', type: 'id', description: 'The submission.' }],
  },
  'message.received': {
    label: 'Message received',
    description: 'The contact sends a message.',
    config: z.strictObject({
      channel: z.enum(['email', 'sms', 'whatsapp', 'webchat']).optional(),
      /**
       * Only a reply to one of these automations: the contact's most recent automated
       * message on the same channel was sent by a run of one of them.
       */
      repliedTo: z.array(automationReference).min(1).max(MAX_REPLIED_TO).optional().meta({
        description:
          "Only replies to these automations: the contact's most recent automated message on the same channel was sent by one of them.",
      }),
    }),
    outputs: [{ key: 'messageId', type: 'id', description: 'The message received.' }],
  },
  'appointment.booked': {
    label: 'Appointment booked',
    description:
      'The contact books an appointment. It can start only for bookings that arrived from the lead sources or session sources you list.',
    config: z.strictObject({ calendar: automationReference.optional(), ...arrivalFilters }),
    outputs: recordOutputs('appointment'),
  },
  'appointment.status_changed': {
    label: 'Appointment status changed',
    description: "An appointment's status changes, such as to cancelled or no-show.",
    config: z.strictObject({
      calendar: automationReference.optional(),
      status: z.string().min(1).max(60).optional(),
    }),
    outputs: recordOutputs('appointment'),
  },
  'deal.stage_changed': {
    label: 'Opportunity stage changed',
    description: 'An opportunity moves to another stage.',
    config: z.strictObject({
      pipeline: automationReference.optional(),
      stage: automationReference.optional(),
    }),
    outputs: recordOutputs('deal'),
  },
  'deal.closed': {
    label: 'Opportunity closed',
    description: 'An opportunity is closed as won or lost.',
    config: z.strictObject({
      pipeline: automationReference.optional(),
      outcome: z.enum(['won', 'lost']).optional(),
    }),
    outputs: recordOutputs('deal'),
  },
  'contact.created': {
    label: 'Contact created',
    description: 'A new contact is added.',
    config: z.strictObject({}),
    outputs: [],
  },
  'field.changed': {
    label: 'Field changed',
    description: 'A field changes, optionally to a given value.',
    config: z.strictObject({
      field: fieldPath,
      to: z.union([z.string().max(1000), z.number(), z.boolean()]).optional(),
    }),
    outputs: [],
  },
  'contact.dnd_changed': {
    label: 'Contact DND',
    description:
      "A contact's do not disturb is turned on or off, however it was changed. Left out, a filter takes any.",
    config: z
      .strictObject({
        direction: dndDirection,
        flag: z.enum(['enabled', 'disabled']).optional(),
        channel: dndChannel,
      })
      .refine((config) => config.direction !== 'inbound' || config.channel === undefined, {
        path: ['channel'],
        error: INBOUND_IS_ONE_SETTING,
      }),
    outputs: [],
  },
  'contact.score_changed': {
    label: 'Contact Engagement Score',
    description: 'The engagement score matches a comparison.',
    config: z.strictObject({
      operator: z.enum(scoreComparisons),
      score: z.int().min(-SCORING_LIMITS.score).max(SCORING_LIMITS.score),
    }),
    outputs: [],
  },
  'tag.added': {
    label: 'Tag added',
    description: 'A tag is added to the contact.',
    config: z.strictObject({ tag: automationReference }),
    outputs: [],
  },
  'tag.removed': {
    label: 'Tag removed',
    description: 'A selected tag is removed from the contact.',
    config: z.strictObject({ tag: automationReference }),
    outputs: [],
  },
  'task.created': {
    label: 'Task created',
    description: 'A task is created for the contact.',
    config: z.strictObject({}),
    outputs: [],
  },
  'task.completed': {
    label: 'Task completed',
    description: 'A task for the contact is completed.',
    config: z.strictObject({}),
    outputs: [],
  },
  'task.reminder': {
    label: 'Task reminder',
    description: 'A task for the contact is due in, or was due, a number of days.',
    config: z
      .strictObject({
        before: z.int().min(0).max(MAX_TASK_REMINDER_DAYS).optional(),
        after: z.int().min(0).max(MAX_TASK_REMINDER_DAYS).optional(),
      })
      .refine((config) => config.before !== undefined || config.after !== undefined, {
        error: 'Choose days before, after, or both.',
      }),
    outputs: [],
  },
  'note.created': {
    label: 'Note added',
    description: 'A note is added to the contact.',
    config: z.strictObject({}),
    outputs: [],
  },
  'note.updated': {
    label: 'Note changed',
    description: 'A note on the contact is edited.',
    config: z.strictObject({}),
    outputs: [],
  },
  'trigger_link.clicked': {
    label: 'Trigger link clicked',
    description: 'The contact opens a trigger link from a message sent to them.',
    config: z.strictObject({ link: automationReference }),
    outputs: [{ key: 'linkId', type: 'id', description: 'The trigger link clicked.' }],
  },
  // Quotes, invoices and payments. Each starts for the document's contact. None takes a
  // filter yet: a workflow narrows by its own conditions.
  'quote.sent': {
    label: 'Quote sent',
    description: 'A quote is emailed to the contact.',
    config: z.strictObject({}),
    outputs: documentOutputs('quote'),
  },
  'quote.accepted': {
    label: 'Quote accepted',
    description: 'The contact, or someone on the team for them, accepts a quote.',
    config: z.strictObject({}),
    outputs: documentOutputs('quote'),
  },
  'quote.declined': {
    label: 'Quote declined',
    description: 'The contact, or someone on the team for them, declines a quote.',
    config: z.strictObject({}),
    outputs: documentOutputs('quote'),
  },
  'invoice.issued': {
    label: 'Invoice issued',
    description: 'An invoice for the contact is issued: it gets its number. Nothing is sent yet.',
    config: z.strictObject({}),
    outputs: documentOutputs('invoice'),
  },
  'invoice.sent': {
    label: 'Invoice sent',
    description: 'An invoice is emailed to the contact.',
    config: z.strictObject({}),
    outputs: documentOutputs('invoice'),
  },
  'invoice.paid': {
    label: 'Invoice paid',
    description: 'An invoice for the contact is paid in full.',
    config: z.strictObject({}),
    outputs: documentOutputs('invoice'),
  },
  'payment.recorded': {
    label: 'Payment recorded',
    description: 'A payment is recorded against an invoice for the contact, in part or in full.',
    config: z.strictObject({}),
    outputs: [{ key: 'paymentId', type: 'id', description: 'The payment, which is its receipt.' }],
  },
  'automation.run_ended': {
    label: 'Automation run ended',
    description:
      'A run of one of the automations named ends for the contact: stopped by one of its stop conditions, removed by another automation, completed or failed. A run cancelled because its automation was deleted does not count.',
    config: z.strictObject({
      automations: z.array(automationReference).min(1).max(MAX_RUN_ENDED_AUTOMATIONS),
      /** How the run ended; left out, any of them. */
      how: z
        .array(z.enum(automationRunEndings))
        .min(1)
        .max(automationRunEndings.length)
        .optional()
        .meta({ description: 'How the run ended; left out, any of these.' }),
      /** Only a run a stop condition ended, on one of these events. */
      stoppedBy: z.array(z.enum(stopEvents)).min(1).max(stopEvents.length).optional().meta({
        description:
          'Only a run one of its stop conditions ended, on one of these events, such as message.received.',
      }),
    }),
    outputs: [
      { key: 'runId', type: 'id', description: 'The run that ended.' },
      {
        key: 'reason',
        type: 'string',
        description:
          "Why it ended: a failure's code, stop:<event> or removed:<how>; absent when it completed.",
      },
      {
        key: 'step',
        type: 'string',
        description: 'The step a failed run failed at; absent otherwise.',
      },
    ],
  },
  'date.reached': {
    label: 'Date reached',
    description:
      'A date field comes round, such as a birthday, or a time before or after it. It comes round every year, or once only if you choose.',
    config: z.strictObject({
      ...dateTarget,
      repeat: z.enum(['yearly', 'never']).default('yearly'),
    }),
    outputs: [],
  },
  'webhook.received': {
    label: 'Webhook received',
    description: "An outside app calls this automation's webhook address.",
    config: z.strictObject({}),
    outputs: [{ key: 'body', type: 'string', description: 'The JSON body received.' }],
  },
  schedule: {
    label: 'Schedule',
    description: 'A repeating time, for every contact the automation is given.',
    config: z.union([
      z.strictObject({ every: z.literal('day'), at: timeOfDay }),
      z.strictObject({
        every: z.literal('week'),
        at: timeOfDay,
        weekday: z.enum([
          'monday',
          'tuesday',
          'wednesday',
          'thursday',
          'friday',
          'saturday',
          'sunday',
        ]),
      }),
      z.strictObject({ every: z.literal('month'), at: timeOfDay, day: z.int().min(1).max(28) }),
    ]),
    outputs: [],
  },
} as const satisfies Record<string, TriggerDefinition>;

export type AutomationTriggerType = keyof typeof automationTriggerTypes;

/**
 * The events that can meet a goal: those of the triggers that tell of something happening
 * to the contact. Each is filtered as its trigger is.
 */
export const automationGoalEvents = [
  'form.submitted',
  'trigger_link.clicked',
  'tag.added',
  'tag.removed',
  'appointment.booked',
  'appointment.status_changed',
  'message.received',
  'deal.stage_changed',
  'deal.closed',
  'field.changed',
] as const satisfies readonly AutomationTriggerType[];

function goalEvent<T extends AutomationTriggerType, C extends z.ZodType>(type: T, config: C) {
  return z.strictObject({ type: z.literal(type), config });
}

/** One event of a goal: a trigger's type with that trigger's own filters. */
export const automationGoalEvent = z.discriminatedUnion('type', [
  goalEvent('form.submitted', automationTriggerTypes['form.submitted'].config),
  goalEvent('trigger_link.clicked', automationTriggerTypes['trigger_link.clicked'].config),
  goalEvent('tag.added', automationTriggerTypes['tag.added'].config),
  goalEvent('tag.removed', automationTriggerTypes['tag.removed'].config),
  goalEvent('appointment.booked', automationTriggerTypes['appointment.booked'].config),
  goalEvent(
    'appointment.status_changed',
    automationTriggerTypes['appointment.status_changed'].config,
  ),
  // Any message from the contact on the channel: which automation it answers is not asked.
  goalEvent(
    'message.received',
    z.strictObject({ channel: z.enum(['email', 'sms', 'whatsapp', 'webchat']).optional() }),
  ),
  goalEvent('deal.stage_changed', automationTriggerTypes['deal.stage_changed'].config),
  goalEvent('deal.closed', automationTriggerTypes['deal.closed'].config),
  goalEvent('field.changed', automationTriggerTypes['field.changed'].config),
]);

export type AutomationGoalEvent = z.output<typeof automationGoalEvent>;

export const automationStepTypes = {
  ...stepTypesBeforeGoal,
  goal: {
    group: 'logic',
    version: 1,
    label: 'Goal',
    description:
      'When one of these events happens for the contact, the run comes straight to this step from wherever it is, and goes on from here. A run that reaches the step first goes on anyway, waits here for the goal, or ends.',
    config: z.strictObject({
      events: z.array(automationGoalEvent).min(1).max(MAX_GOAL_EVENTS),
      /** What a run does that reaches this step before the goal is met. */
      otherwise: z.enum(['continue', 'wait', 'end']).default('continue'),
    }),
    branches: none,
    outputs: [
      {
        key: 'eventId',
        type: 'id',
        description: 'The event that met the goal; absent when it was not met.',
      },
    ],
  },
} as const satisfies Record<string, StepDefinition>;

export type AutomationStepType = keyof typeof automationStepTypes;

/**
 * The steps a retry may be put on: those that change a record or queue a message, whose
 * refused attempt is rolled back whole. A webhook has retries of its own.
 */
export const automationRetryableSteps = [
  'email.send',
  'sms.send',
  'contact.update',
  'tag.add',
  'tag.remove',
  'owner.assign',
  'owner.remove',
  'deal.create',
  'deal.move',
  'deal.close',
  'deal.update',
  'task.create',
  'note.create',
  'dnd.set',
  'followers.add',
  'followers.remove',
] as const satisfies readonly AutomationStepType[];

/**
 * The branches a step of this type has with this config, in order, or nothing for a step
 * that only leads on. One way of naming them for the validator, the engine and the editor.
 */
export function automationBranchNames(
  type: AutomationStepType,
  config: unknown,
): readonly string[] | undefined {
  const branches: AutomationBranches = automationStepTypes[type].branches;
  if (branches.kind === 'none') return undefined;
  if (branches.kind === 'fixed') return branches.names;
  const listed: unknown =
    typeof config === 'object' && config !== null
      ? (config as Readonly<Record<string, unknown>>)[branches.field]
      : undefined;
  if (!Array.isArray(listed)) return branches.legacy ?? [];
  const names = listed.flatMap((item: unknown) =>
    typeof item === 'string'
      ? [item]
      : typeof item === 'object' && item !== null && 'name' in item && typeof item.name === 'string'
        ? [item.name]
        : [],
  );
  return branches.fallback === undefined ? names : [...names, branches.fallback];
}

/** What each condition operator compares its field with. */
export const automationOperatorValues = {
  equals: 'value',
  not_equals: 'value',
  includes: 'value',
  excludes: 'value',
  starts_with: 'value',
  greater_than: 'value',
  less_than: 'value',
  is_set: 'none',
  is_empty: 'none',
  before: 'value',
  after: 'value',
  within_last: 'duration',
  within_next: 'duration',
} as const satisfies Record<(typeof conditionOperators)[number], 'value' | 'none' | 'duration'>;
