// The automation document (AUTOMATIONS.md section 2): one JSON document that the canvas,
// the steps view, the assistant and the API all read and write. Format version 1. This
// checks its shape only; references, reachability and loops are the validator's.
import * as z from 'zod';

import {
  attributionLeaves,
  attributionLeafWords,
  attributionPath,
  attributionScopes,
  attributionTriggers,
  type AttributionLeaf,
  type AttributionScope,
} from './automations-attribution.js';
import {
  SUBMISSION_PAGE_PATH,
  submissionAnswerPath,
  submissionTriggers,
} from './automations-submission.js';
import {
  automationOperatorValues,
  automationStepGroups,
  automationRetryableFailures,
  automationRetryableSteps,
  automationStepTypes,
  automationStopEvents,
  automationTriggerTypes,
  MAX_RUN_RETRIES,
  MAX_STEP_RETRIES,
  type AutomationBranches,
  type AutomationOutput,
  type AutomationStepType,
  type AutomationTriggerType,
} from './automations-catalog.js';
import {
  automationCondition,
  automationKey,
  isoDuration,
  timeOfDay,
} from './automations-values.js';

export const AUTOMATION_FORMAT_VERSION = 1;

const linearNext = automationKey
  .optional()
  .meta({ description: 'The next step; leave it out to end this path.' });
const branchNext = (names: readonly string[]) =>
  z
    .strictObject(Object.fromEntries(names.map((name) => [name, automationKey.optional()])))
    .optional()
    .meta({ description: `The step for each branch: ${names.join(', ')}.` });
const namedNext = z
  .record(automationKey, automationKey)
  .optional()
  .meta({ description: 'The step for each branch, by the names listed in config.' });

const nextFor = (branches: AutomationBranches) =>
  branches.kind === 'none'
    ? linearNext
    : branches.kind === 'fixed'
      ? branchNext(branches.names)
      : namedNext;

const stepCommon = {
  label: z.string().trim().min(1).max(80).optional(),
  notes: z.string().trim().max(1000).optional(),
  /** Added by the server on save, so old automations keep working after a type changes. */
  typeVersion: z.int().min(1).max(1000).optional(),
  /**
   * What the run does when this step fails: stop (the default), go on to the step's next,
   * or go to the step named.
   */
  onFailure: z
    .union([z.enum(['stop', 'continue']), z.strictObject({ goTo: automationKey })])
    .optional()
    .meta({
      description:
        'What the run does when this step fails: "stop" ends the run as failed (the default), "continue" goes on to next, and { "goTo": step } goes to the step named.',
    }),
  /** Tries again after a failure that can pass with time, before onFailure applies. */
  retry: z
    .strictObject({
      times: z.int().min(1).max(MAX_STEP_RETRIES),
      /** The wait before the first retry; one minute when left out. */
      wait: isoDuration.optional(),
      /** double: each wait is twice the last (the default). fixed: every wait is the same. */
      backoff: z.enum(['double', 'fixed']).optional(),
    })
    .optional()
    .meta({
      description:
        'Try the step again, up to times more, when it fails for a reason that can pass (see the catalog: failures.retryableReasons). wait is the time before the first retry (PT1M when left out, at most 24 hours); backoff double (the default) doubles it each time, fixed keeps it.',
    }),
};

// The config is a parameter so each step type's schema keeps its own config type:
// indexing the catalog with a generic type would widen it to every type's config.
function stepSchema<T extends AutomationStepType>(
  type: T,
  config: (typeof automationStepTypes)[T]['config'],
) {
  const branches: AutomationBranches = automationStepTypes[type].branches;
  const schema = z.strictObject({
    type: z.literal(type),
    config,
    next: nextFor(branches),
    ...stepCommon,
  });
  // A step in its type's older shape has that shape's branches and no others, as it had
  // when they were the type's only ones (a condition with one `if`: yes and no).
  const legacy = branches.kind === 'from_config' ? branches.legacy : undefined;
  if (legacy === undefined || branches.kind !== 'from_config') return schema;
  const field = branches.field;
  return schema.check((context) => {
    const step: { readonly config?: unknown; readonly next?: unknown } = context.value;
    const { config: given, next } = step;
    if (typeof given !== 'object' || given === null || field in given) return;
    if (typeof next !== 'object' || next === null) return;
    const unknown = Object.keys(next).filter((name) => !legacy.includes(name));
    if (unknown.length > 0)
      context.issues.push({
        code: 'custom',
        path: ['next'],
        input: next,
        message: `This step's branches are ${legacy.join(' and ')}, not ${unknown.join(', ')}.`,
      });
  });
}

// discriminatedUnion needs at least one option; the catalogs are never empty.
function nonEmpty<T>(items: readonly T[]): [T, ...T[]] {
  const [first, ...rest] = items;
  if (first === undefined) throw new Error('An automation catalog is empty.');
  return [first, ...rest];
}

const stepTypes = Object.keys(automationStepTypes) as AutomationStepType[];
/** The schema of each step type, so a step's config narrows by its type. */
type StepSchemaOf = {
  [T in AutomationStepType]: ReturnType<typeof stepSchema<T>>;
}[AutomationStepType];
const triggerTypes = Object.keys(automationTriggerTypes) as AutomationTriggerType[];

export const automationStep = z
  .discriminatedUnion(
    'type',
    // Each element is the schema of its own type, which the mapped type states.
    nonEmpty(
      stepTypes.map((type) => stepSchema(type, automationStepTypes[type].config)) as StepSchemaOf[],
    ),
  )
  .meta({ id: 'AutomationStep' });

function triggerSchema<T extends AutomationTriggerType>(
  type: T,
  config: (typeof automationTriggerTypes)[T]['config'],
) {
  return z.strictObject({
    id: automationKey,
    type: z.literal(type),
    config,
    /** Only events that also match this start the automation. */
    if: automationCondition.optional(),
  });
}

type TriggerSchemaOf = {
  [T in AutomationTriggerType]: ReturnType<typeof triggerSchema<T>>;
}[AutomationTriggerType];

export const automationTrigger = z
  .discriminatedUnion(
    'type',
    nonEmpty(
      triggerTypes.map((type) =>
        triggerSchema(type, automationTriggerTypes[type].config),
      ) as TriggerSchemaOf[],
    ),
  )
  .meta({ id: 'AutomationTrigger' });

export const automationStop = z
  .discriminatedUnion('event', [
    z.strictObject({
      event: z.literal('message.received'),
      /** Who sent it: the contact, or someone on the team. */
      from: z.enum(['contact', 'team']).optional(),
      /**
       * Only a reply to this run's own messages: the run has sent the contact a message on
       * the channel the reply came in on. Left out, any message from the contact stops it.
       */
      repliedTo: z.literal('this_run').optional().meta({
        description:
          'this_run: stop only when this run has sent the contact a message on the channel the reply came in on. Left out, any message stops it.',
      }),
      if: automationCondition.optional(),
    }),
    ...automationStopEvents
      .filter((event) => event !== 'message.received')
      .map((event) =>
        z.strictObject({ event: z.literal(event), if: automationCondition.optional() }),
      ),
  ])
  .meta({ id: 'AutomationStop' });

const weekday = z.enum([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

export const automationSettings = z
  .strictObject({
    /** never: a contact goes through once. after_finished: again once their last run ended. */
    reEnrollment: z.enum(['never', 'after_finished']).default('never'),
    /** Whose time zone waits, dates and the sending window use. */
    timezone: z.enum(['contact', 'business']).default('business'),
    /** When messages may go out; others wait for the next opening. */
    sendingWindow: z
      .strictObject({ days: z.array(weekday).min(1).max(7), start: timeOfDay, end: timeOfDay })
      .optional(),
  })
  .meta({ id: 'AutomationSettings' });

export const automationDocument = z
  .strictObject({
    $schema: z.string().max(500).optional(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).default(''),
    /**
     * What starts it. None is allowed: such an automation runs only when another one
     * starts it (automation.run), and the validator says so in a warning.
     */
    triggers: z.array(automationTrigger).max(20),
    /** Events that end the automation for the contact at any point (goals). */
    stopWhen: z.array(automationStop).max(20).default([]),
    start: automationKey,
    steps: z.record(automationKey, automationStep),
    settings: automationSettings.prefault({}),
    /** Optional canvas positions; they never change behaviour. */
    layout: z.record(automationKey, z.strictObject({ x: z.number(), y: z.number() })).optional(),
  })
  // No id: the served schema's root is the document itself, not a reference to it.
  .meta({ title: 'Automation document, format version 1' });

export type AutomationDocument = z.output<typeof automationDocument>;
export type AutomationDocumentInput = z.input<typeof automationDocument>;
export type AutomationStep = z.output<typeof automationStep>;
export type AutomationTrigger = z.output<typeof automationTrigger>;

type JsonSchema = z.core.JSONSchema.BaseSchema;

const jsonSchemaOptions = {
  target: 'draft-2020-12',
  io: 'input',
  cycles: 'ref',
  reused: 'inline',
} as const;

/** The JSON Schema each install serves at GET /automations/schema. */
export function automationJsonSchema(): JsonSchema {
  return z.toJSONSchema(automationDocument, jsonSchemaOptions);
}

/** The published catalog: what each trigger, step and operator takes and gives. */
export interface AutomationCatalog {
  readonly formatVersion: number;
  readonly triggers: readonly {
    readonly type: AutomationTriggerType;
    readonly label: string;
    readonly description: string;
    readonly config: JsonSchema;
    readonly outputs: readonly AutomationOutput[];
  }[];
  readonly stopEvents: readonly AutomationTriggerType[];
  readonly steps: readonly {
    readonly type: AutomationStepType;
    readonly group: (typeof automationStepGroups)[number];
    readonly version: number;
    readonly label: string;
    readonly description: string;
    readonly config: JsonSchema;
    readonly branches: AutomationBranches;
    readonly outputs: readonly AutomationOutput[];
  }[];
  readonly stepGroups: readonly (typeof automationStepGroups)[number][];
  readonly operators: readonly {
    readonly operator: string;
    readonly value: 'value' | 'none' | 'duration';
  }[];
  /**
   * Where a contact came from, as conditions and merge fields read it: a path is a prefix
   * and a leaf, such as trigger.attribution.source. Read-only.
   */
  readonly attribution: {
    /** The touch each prefix reads: the first, the latest, and the one that started the run. */
    readonly prefixes: Readonly<Record<AttributionScope, string>>;
    readonly leaves: readonly (AttributionLeaf & {
      readonly label: string;
      readonly description: string;
    })[];
    /** The triggers whose runs have a touch of their own under trigger.attribution. */
    readonly triggers: readonly AutomationTriggerType[];
  };
  /**
   * What a run a form submission started reads of that submission: the page it was sent
   * from, and its answers, each by its question's key after `answers`. Read-only.
   */
  readonly submission: {
    readonly page: string;
    readonly answers: string;
    readonly triggers: readonly AutomationTriggerType[];
  };
  /** What a step's retry may be put on, and what it retries. */
  readonly failures: {
    /** The most times a step is tried again. */
    readonly maxRetries: number;
    /** The most times a person may run one failed run again. */
    readonly maxRunRetries: number;
    readonly retryableSteps: readonly AutomationStepType[];
    /** The failure codes a retry applies to; any other fails the step at once. */
    readonly retryableReasons: readonly string[];
  };
}

/**
 * Everything an automation can use, without the business's own forms, templates and
 * fields, which the API adds: each type's config as JSON Schema, its branches and outputs.
 */
export function automationCatalog(): AutomationCatalog {
  return {
    formatVersion: AUTOMATION_FORMAT_VERSION,
    triggers: triggerTypes.map((type) => {
      const definition = automationTriggerTypes[type];
      return {
        type,
        label: definition.label,
        description: definition.description,
        config: z.toJSONSchema(definition.config, jsonSchemaOptions),
        outputs: definition.outputs,
      };
    }),
    stopEvents: automationStopEvents,
    steps: stepTypes.map((type) => {
      const definition = automationStepTypes[type];
      return {
        type,
        group: definition.group,
        version: definition.version,
        label: definition.label,
        description: definition.description,
        config: z.toJSONSchema(definition.config, jsonSchemaOptions),
        branches: definition.branches,
        outputs: definition.outputs,
      };
    }),
    stepGroups: automationStepGroups,
    operators: Object.entries(automationOperatorValues).map(([operator, value]) => ({
      operator,
      value,
    })),
    attribution: {
      prefixes: Object.fromEntries(
        attributionScopes.map((scope) => [scope, attributionPath(scope, 'source').slice(0, -7)]),
      ) as Record<AttributionScope, string>,
      leaves: attributionLeaves.map((leaf) => ({
        ...leaf,
        ...attributionLeafWords[leaf.key],
      })),
      triggers: attributionTriggers,
    },
    submission: {
      page: SUBMISSION_PAGE_PATH,
      answers: submissionAnswerPath(''),
      triggers: submissionTriggers,
    },
    failures: {
      maxRetries: MAX_STEP_RETRIES,
      maxRunRetries: MAX_RUN_RETRIES,
      retryableSteps: automationRetryableSteps,
      retryableReasons: automationRetryableFailures,
    },
  };
}
