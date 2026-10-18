// What the workflow list and a workflow's tabs ask of the automation API beyond its draft:
// folders, the Deleted list with restore, how many each automation, trigger and step has
// enrolled or run, and the execution logs.
import * as z from 'zod';

import {
  automation,
  automationRunStep,
  automationRunSummary,
  automationStepNamed,
} from './automations-api.js';
import { defineEndpoint } from './endpoints.js';
import { publicId, recordId } from './ids.js';
import { timestamp } from './timestamps.js';

/** How deep folders nest: a folder at the top level is at depth 1. */
export const AUTOMATION_FOLDER_MAX_DEPTH = 5;

/** The most folders one business keeps, so the whole tree is one small answer. */
export const AUTOMATION_FOLDER_LIMIT = 500;

/** How many days a deleted automation stays in the Deleted list before it is removed. */
export const AUTOMATION_DELETED_DAYS = 30;

const folderName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .meta({ description: 'Unlike any other folder in the same place, whatever its capitals.' });
const folderRevision = z.int().min(1).meta({
  description:
    'The revision this change started from. If the folder has changed since, the change is refused with 409 Conflict.',
});

export const automationFolder = z
  .looseObject({
    id: publicId('automation_folder'),
    parentId: publicId('automation_folder')
      .nullable()
      .meta({ description: 'The folder it is in; null at the top level.' }),
    name: z.string(),
    revision: z.int().min(1).meta({ description: 'Adds one each time it is renamed or moved.' }),
    automationCount: z.int().min(0).meta({
      description: 'Automations directly in it, not counting those in folders inside it.',
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'AutomationFolder' });
export type AutomationFolder = z.output<typeof automationFolder>;

export const automationFolderList = z
  .looseObject({
    /** Whether the caller may create, rename, move and delete folders. */
    canManage: z.boolean(),
    items: z.array(automationFolder),
  })
  .meta({
    id: 'AutomationFolderList',
    description: 'Every folder of the business, by name; the tree is read from each parentId.',
  });
export type AutomationFolderList = z.output<typeof automationFolderList>;

export const createAutomationFolderInput = z
  .strictObject({
    name: folderName,
    parentId: publicId('automation_folder').nullable().default(null),
  })
  .meta({ id: 'CreateAutomationFolderInput' });

export const updateAutomationFolderInput = z
  .strictObject({
    revision: folderRevision,
    name: folderName.optional(),
    parentId: publicId('automation_folder')
      .nullable()
      .optional()
      .meta({ description: 'Where to move it: another folder, or null for the top level.' }),
  })
  .meta({
    id: 'UpdateAutomationFolderInput',
    description: 'A new name, a new place, or both; a member left out stays as it is.',
  });

const folderParams = z.object({ id: publicId('automation_folder') });
const automationParams = z.object({ id: publicId('automation') });

export const listAutomationFolders = defineEndpoint({
  operationId: 'listAutomationFolders',
  method: 'get',
  path: '/automation-folders',
  summary: 'List automation folders',
  group: 'Automations',
  response: {
    status: 200,
    description: `Every folder, at most ${String(AUTOMATION_FOLDER_LIMIT)}, each with how many automations are in it.`,
    schema: automationFolderList,
  },
});

export const createAutomationFolder = defineEndpoint({
  operationId: 'createAutomationFolder',
  method: 'post',
  path: '/automation-folders',
  summary: 'Create an automation folder',
  group: 'Automations',
  body: createAutomationFolderInput,
  response: {
    status: 201,
    description: `The new folder. Folders nest at most ${String(AUTOMATION_FOLDER_MAX_DEPTH)} deep.`,
    schema: automationFolder,
  },
});

export const updateAutomationFolder = defineEndpoint({
  operationId: 'updateAutomationFolder',
  method: 'patch',
  path: '/automation-folders/{id}',
  summary: 'Rename or move an automation folder',
  group: 'Automations',
  params: folderParams,
  body: updateAutomationFolderInput,
  response: {
    status: 200,
    description:
      'The folder as it is now. A folder cannot be moved into itself or a folder inside it.',
    schema: automationFolder,
  },
});

export const deleteAutomationFolder = defineEndpoint({
  operationId: 'deleteAutomationFolder',
  method: 'delete',
  path: '/automation-folders/{id}',
  summary: 'Delete an automation folder',
  group: 'Automations',
  params: folderParams,
  response: {
    status: 204,
    description:
      'The folder is gone. The automations and folders that were in it are now one level up; none is deleted.',
  },
});

export const moveAutomationInput = z
  .strictObject({
    folderId: publicId('automation_folder')
      .nullable()
      .meta({ description: 'The folder to put it in, or null for the top level.' }),
  })
  .meta({ id: 'MoveAutomationInput' });

export const moveAutomation = defineEndpoint({
  operationId: 'moveAutomation',
  method: 'put',
  path: '/automations/{id}/folder',
  summary: 'Move an automation to a folder',
  group: 'Automations',
  params: automationParams,
  body: moveAutomationInput,
  response: { status: 200, description: 'The automation, in its new place.', schema: automation },
});

export const deleteAutomation = defineEndpoint({
  operationId: 'deleteAutomation',
  method: 'delete',
  path: '/automations/{id}',
  summary: 'Delete an automation',
  group: 'Automations',
  params: automationParams,
  response: {
    status: 200,
    description: `The automation, in the Deleted list (status archived) for ${String(AUTOMATION_DELETED_DAYS)} days. Nothing new starts it, and every run still going is cancelled and takes no further step.`,
    schema: automation,
  },
});

export const restoreAutomation = defineEndpoint({
  operationId: 'restoreAutomation',
  method: 'post',
  path: '/automations/{id}/restore',
  summary: 'Restore a deleted automation',
  group: 'Automations',
  params: automationParams,
  response: {
    status: 200,
    description:
      'The automation, at the top level and not running: paused if it was ever published, else a draft. The runs cancelled when it was deleted stay cancelled.',
    schema: automation,
  },
});

const count = z.int().min(0);

export const automationRunCounts = z
  .looseObject({
    enrolled: count.meta({ description: 'Runs started.' }),
    active: count.meta({ description: 'Runs running or waiting now.' }),
    completed: count,
    exited: count.meta({ description: 'Runs a stop condition ended.' }),
    failed: count,
    cancelled: count.meta({ description: 'Runs ended because the automation was deleted.' }),
  })
  .meta({ id: 'AutomationRunCounts' });
export type AutomationRunCounts = z.output<typeof automationRunCounts>;

export const automationStepCounts = z
  .looseObject({
    entered: count.meta({ description: 'Times a run reached the step.' }),
    completed: count.meta({
      description: 'Times the step finished and the run went on or ended well.',
    }),
    failed: count,
    waiting: count.meta({ description: 'Runs waiting at the step now.' }),
    skipped: count.meta({
      description: 'Waits cut short because the run was stopped or cancelled in them.',
    }),
  })
  .meta({ id: 'AutomationStepCounts' });
export type AutomationStepCounts = z.output<typeof automationStepCounts>;

export const automationStats = z
  .looseObject({
    automationId: publicId('automation'),
    liveVersion: z.int().min(1).nullable(),
    runs: z.looseObject({
      allTime: automationRunCounts,
      live: automationRunCounts.nullable(),
    }),
    triggers: z.array(
      z.looseObject({
        trigger: z.string().meta({ description: 'The trigger’s id in the document.' }),
        type: z.string().nullable(),
        inLiveVersion: z.boolean(),
        allTime: z.looseObject({ enrolled: count }),
        live: z.looseObject({ enrolled: count }).nullable(),
      }),
    ),
    steps: z.array(
      automationStepNamed.extend({
        inLiveVersion: z.boolean(),
        allTime: automationStepCounts,
        live: automationStepCounts.nullable(),
      }),
    ),
  })
  .meta({
    id: 'AutomationStats',
    description:
      'How many runs, and how many visits to each step, for the live version and for every version there has been. live is null when nothing is published. A step or trigger no longer in the live version keeps its all-time numbers.',
  });
export type AutomationStats = z.output<typeof automationStats>;

export const getAutomationStats = defineEndpoint({
  operationId: 'getAutomationStats',
  method: 'get',
  path: '/automations/{id}/stats',
  summary: 'Read an automation’s statistics',
  group: 'Automations',
  params: automationParams,
  response: {
    status: 200,
    description: 'Runs, triggers and steps, each for the live version and for all time.',
    schema: automationStats,
  },
});

/** One step taken by one run, as the execution logs list it. */
export const automationStepRunEntry = automationRunStep
  .extend({
    id: publicId('automation_step_run'),
    runId: publicId('automation_enrolment'),
    version: z.int().min(1),
    label: z
      .string()
      .nullable()
      .meta({ description: 'The label its author gave the step, if any.' }),
    record: automationRunSummary.shape.record,
  })
  .meta({ id: 'AutomationStepRunEntry' });
export type AutomationStepRunEntry = z.output<typeof automationStepRunEntry>;

export const automationStepRunList = z
  .looseObject({
    items: z.array(automationStepRunEntry),
    nextCursor: publicId('automation_step_run').nullable(),
  })
  .meta({ id: 'AutomationStepRunList' });
export type AutomationStepRunList = z.output<typeof automationStepRunList>;

export const listAutomationStepRuns = defineEndpoint({
  operationId: 'listAutomationStepRuns',
  method: 'get',
  path: '/automations/{id}/step-runs',
  summary: 'List the steps an automation’s runs took',
  group: 'Automations',
  params: automationParams,
  query: z.strictObject({
    status: automationRunStep.shape.status.optional(),
    step: z.string().min(1).max(63).optional().meta({
      description: 'Only this step, by its key in the document.',
    }),
    type: z.string().min(1).max(60).optional().meta({
      description: 'Only steps of this type, such as email.send.',
    }),
    from: z.iso.datetime({ offset: true }).optional().meta({
      description: 'Only steps that began at or after this moment.',
    }),
    to: z.iso.datetime({ offset: true }).optional().meta({
      description: 'Only steps that began before this moment.',
    }),
    record: recordId.optional().meta({ description: 'Only steps of runs for this record.' }),
    after: publicId('automation_step_run').optional(),
  }),
  response: {
    status: 200,
    description:
      'The execution logs: newest first by when each step began, 50 at a time, each with its record, its run and what it did.',
    schema: automationStepRunList,
  },
});

/**
 * Why an automation did not start for a record when an event it listens for came. Each is a
 * fact the match recorded, never a guess.
 */
export const automationTriggerEvaluationReasons = [
  /** The event did not pass one of the trigger's own filters, such as its form or its tag. */
  'filter_mismatch',
  /** The trigger's `if` condition did not hold for the record. */
  'condition_false',
  /** The record was in the automation already, and is in it once at a time. */
  'already_enrolled',
  /** The record has been through the automation, which takes a record once. */
  'reentry_not_allowed',
  /** The automation was paused. */
  'paused',
  /** The event was about no record, so there was nobody to start for. */
  'contact_missing',
  /** A rule that cannot be switched off stopped it, such as "an imported contact starts nothing". */
  'stopped_by_rule',
  /** Starting it would have closed a loop between automations whose runs start one another. */
  'refused_loop',
] as const;
export type AutomationTriggerEvaluationReason = (typeof automationTriggerEvaluationReasons)[number];

/** How long a trigger evaluation is kept, in days. */
export const TRIGGER_EVALUATION_DAYS = 30;

export const automationTriggerEvaluation = z
  .looseObject({
    id: z.uuid(),
    evaluatedAt: timestamp,
    eventId: z.uuid().meta({ description: 'The event that was matched.' }),
    eventType: z.string().meta({ examples: ['tag.assigned'] }),
    trigger: z
      .looseObject({
        id: z.string(),
        type: z
          .string()
          .nullable()
          .meta({ description: 'Null when the live version no longer has it.' }),
      })
      .nullable()
      .meta({ description: 'The trigger that was judged; null when none was.' }),
    recordId: recordId.nullable().meta({
      description: 'The record the automation did not start for; null when the event had none.',
    }),
    reason: z.enum(automationTriggerEvaluationReasons),
    detail: z
      .looseObject({
        filter: z.string().optional().meta({
          description: 'filter_mismatch: the filter that did not pass, by its key in the trigger.',
        }),
        expected: z.unknown().optional().meta({ description: 'What the filter wanted.' }),
        actual: z.unknown().optional().meta({ description: 'What the event had.' }),
        values: z.record(z.string(), z.unknown()).optional().meta({
          description: 'condition_false: the values the condition compared, by field path.',
        }),
        rule: z.string().optional().meta({ description: 'stopped_by_rule: which rule.' }),
        queued: z.boolean().optional().meta({
          description:
            'already_enrolled: true when the automation lets a record in again, so the record goes through once more when its running run ends.',
        }),
        after: z.string().optional().meta({
          description:
            'The run, by id, after which the record was to go through again and could not.',
        }),
      })
      .meta({ description: 'What was compared, in plain values.' }),
    explanation: z.string().meta({
      description: 'The reason in words, made from the reason and the detail and nothing else.',
      examples: ["The trigger's tag filter wanted tag_…, and the event had tag_…."],
    }),
  })
  .meta({
    id: 'AutomationTriggerEvaluation',
    description:
      'One time an event the automation listens for came and the automation did not start for the record, with why.',
  });
export type AutomationTriggerEvaluation = z.output<typeof automationTriggerEvaluation>;

export const automationTriggerEvaluationList = z
  .looseObject({
    items: z.array(automationTriggerEvaluation),
    nextCursor: z.uuid().nullable(),
  })
  .meta({ id: 'AutomationTriggerEvaluationList' });
export type AutomationTriggerEvaluationList = z.output<typeof automationTriggerEvaluationList>;

export const listAutomationTriggerEvaluations = defineEndpoint({
  operationId: 'listAutomationTriggerEvaluations',
  method: 'get',
  path: '/automations/{id}/trigger-evaluations',
  summary: 'List the times an automation did not start, and why',
  group: 'Automations',
  params: automationParams,
  query: z.strictObject({
    contactId: recordId.optional().meta({ description: 'Only evaluations for this record.' }),
    from: z.iso.datetime({ offset: true }).optional().meta({
      description: 'Only evaluations made at or after this moment.',
    }),
    to: z.iso.datetime({ offset: true }).optional().meta({
      description: 'Only evaluations made before this moment.',
    }),
    after: z.uuid().optional().meta({ description: 'Continue after this evaluation.' }),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  response: {
    status: 200,
    description:
      'Newest first. Each is one event the live version listened for that did not start the automation for a record, with the reason and what was compared. Kept 30 days. A start that did happen is not here: it is a run.',
    schema: automationTriggerEvaluationList,
  },
});

export const automationContactExplanation = z
  .looseObject({
    automationId: publicId('automation'),
    automationName: z.string(),
    automationStatus: z.enum(['draft', 'active', 'paused', 'archived']),
    recordId,
    state: z.enum(['has_run', 'not_started', 'nothing_on_record']).meta({
      description:
        'has_run: the record has at least one run of the automation (see run). not_started: it has none, and at least one evaluation says why an event did not start it. nothing_on_record: neither a run nor an evaluation in the days evaluations are kept.',
    }),
    runs: z.int().min(0).meta({ description: 'How many runs of the automation the record has.' }),
    run: automationRunSummary.nullable().meta({
      description:
        "The record's latest run: its status, the step it is at (currentAction) and why it ended (exitReason).",
    }),
    ended: z.string().nullable().meta({
      description: 'Why the latest run ended, in words; null while it is going, or with no run.',
    }),
    evaluations: z.array(automationTriggerEvaluation).meta({
      description: 'The latest evaluations for the record, newest first, five at most.',
    }),
    evaluationsKeptDays: z.int(),
    summary: z.string().meta({
      description:
        'The facts above in words. It states only what is on record, and says so when nothing is.',
    }),
  })
  .meta({ id: 'AutomationContactExplanation' });
export type AutomationContactExplanation = z.output<typeof automationContactExplanation>;

export const explainAutomationContact = defineEndpoint({
  operationId: 'explainAutomationContact',
  method: 'get',
  path: '/automations/{id}/explain-contact',
  summary: 'Say what an automation did, or did not do, for one contact',
  group: 'Automations',
  params: automationParams,
  query: z.strictObject({
    contactId: recordId.meta({ description: 'The contact (or other record) asked about.' }),
  }),
  response: {
    status: 200,
    description:
      'From facts only: whether the record has a run of the automation (its status, where it is, why it ended), and, when it has none, the most recent times an event did not start it and why. Never a guess: with nothing on record it says so.',
    schema: automationContactExplanation,
  },
});

/** Every operation above, in the order the API reference lists them. */
export const automationManageEndpoints = [
  listAutomationFolders,
  createAutomationFolder,
  updateAutomationFolder,
  deleteAutomationFolder,
  moveAutomation,
  deleteAutomation,
  restoreAutomation,
  getAutomationStats,
  listAutomationStepRuns,
  listAutomationTriggerEvaluations,
  explainAutomationContact,
] as const;
