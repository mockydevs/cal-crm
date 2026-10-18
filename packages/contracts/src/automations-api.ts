// The automation API (AUTOMATIONS.md section 5): drafts with versions, so no save silently
// overwrites another, JSON Patch edits, validation, and the catalog an AI or the builder
// reads before writing a document.
import * as z from 'zod';

import { automationStepGroups } from './automations-step-groups.js';
import { submissionAnswerKinds } from './automations-submission.js';
import { automationKey, isoDuration } from './automations-values.js';
import { MAX_PATCH_OPERATIONS } from './automations-patch.js';
import { defineEndpoint } from './endpoints.js';
import { publicId, recordId } from './ids.js';
import { timestamp } from './timestamps.js';

export const automationStatuses = ['draft', 'active', 'paused', 'archived'] as const;

const draftVersion = z
  .int()
  .min(1)
  .meta({ description: 'The version of the draft; each save adds one.' });
const baseDraftVersion = z.int().min(1).meta({
  description:
    'The draft version this change started from. If the draft has moved on since, the save is refused with 409 Conflict.',
});

/**
 * A draft may be unfinished, so any JSON object is kept; validation reports what's wrong
 * rather than refusing the save. Its format is served at GET /automations/schema.
 */
export const automationDraft = z.record(z.string(), z.unknown()).meta({
  id: 'AutomationDraft',
  description: 'An automation document, possibly unfinished (GET /automations/schema).',
});

export const automationIssue = z
  .looseObject({
    path: z.string().meta({ description: 'A JSON Pointer into the document.' }),
    code: z.string(),
    message: z.string(),
    suggestion: z.string().optional(),
  })
  .meta({ id: 'AutomationIssue' });

export const automationValidation = z
  .looseObject({
    valid: z.boolean(),
    errors: z.array(automationIssue),
    warnings: z.array(automationIssue),
  })
  .meta({ id: 'AutomationValidation', description: 'Errors block publishing; warnings never do.' });
export type AutomationValidationResponse = z.output<typeof automationValidation>;

export const automationSummary = z
  .looseObject({
    id: publicId('automation'),
    name: z.string(),
    description: z.string(),
    status: z.enum(automationStatuses),
    draftVersion,
    liveVersion: z.int().min(1).nullable(),
    lastRunAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    folderId: publicId('automation_folder')
      .nullable()
      .optional()
      .meta({ description: 'The folder it is in; null at the top level, and when it is deleted.' }),
    totalEnrolled: z.int().min(0).optional().meta({
      description: 'How many runs it has started, in every version it has had.',
    }),
    activeEnrolled: z.int().min(0).optional().meta({
      description: 'How many of those runs are running or waiting now.',
    }),
    deletedAt: timestamp.nullable().optional().meta({
      description:
        'When it was deleted; null when it is not. A deleted automation has the status archived.',
    }),
    purgeAt: timestamp.nullable().optional().meta({
      description: 'When a deleted automation is removed for good, with its versions and runs.',
    }),
  })
  .meta({ id: 'AutomationSummary' });
export type AutomationSummary = z.output<typeof automationSummary>;

export const automationLiveVersion = z
  .looseObject({
    id: publicId('automation_version'),
    version: z.int().min(1),
    changeSummary: z.string(),
    publishedAt: timestamp,
    document: automationDraft,
  })
  .meta({ id: 'AutomationLiveVersion' });

export const automation = automationSummary
  .extend({ draft: automationDraft, live: automationLiveVersion.nullable() })
  .meta({ id: 'Automation', description: 'The current draft and the live version.' });
export type Automation = z.output<typeof automation>;

export const automationDraftSaved = z
  .looseObject({ automation, validation: automationValidation })
  .meta({ id: 'AutomationDraftSaved', description: 'The saved draft and what validation found.' });
export type AutomationDraftSaved = z.output<typeof automationDraftSaved>;

/** An automation as one caller reads it: with what that caller may do to it. */
export const automationView = automation
  .extend({
    canManage: z.boolean().meta({ description: 'The caller may edit, check and test the draft.' }),
    canPublish: z.boolean().meta({ description: 'The caller may publish, pause and resume.' }),
  })
  .meta({ id: 'AutomationView' });
export type AutomationView = z.output<typeof automationView>;

export const automationList = z
  .looseObject({
    /** Whether the caller may create and edit drafts, so a screen can offer it or not. */
    canManage: z.boolean(),
    items: z.array(automationSummary),
    nextCursor: publicId('automation').nullable(),
  })
  .meta({ id: 'AutomationList' });
export type AutomationList = z.output<typeof automationList>;

export const createAutomationInput = z
  .strictObject({ document: automationDraft })
  .meta({ id: 'CreateAutomationInput' });
export const replaceAutomationDraftInput = z
  .strictObject({ baseDraftVersion, document: automationDraft })
  .meta({ id: 'ReplaceAutomationDraftInput' });

// RFC 6902 section 4. Members it doesn't know are ignored (section 4), so the object is loose.
export const jsonPatchOperation = z
  .looseObject({
    op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
    path: z.string().max(2000).meta({ description: 'A JSON Pointer (RFC 6901).' }),
    from: z.string().max(2000).optional(),
    value: z.unknown().optional(),
  })
  .meta({ id: 'JsonPatchOperation', description: 'One RFC 6902 operation.' });
export const patchAutomationDraftInput = z
  .strictObject({
    baseDraftVersion,
    patch: z.array(jsonPatchOperation).min(1).max(MAX_PATCH_OPERATIONS),
  })
  .meta({
    id: 'PatchAutomationDraftInput',
    description: 'Applied whole or not at all, in order, to the draft at baseDraftVersion.',
  });

export const validateAutomationInput = z
  .strictObject({ document: automationDraft })
  .meta({ id: 'ValidateAutomationInput' });

const named = z.looseObject({ id: z.string(), name: z.string() });
// AutomationCustomField in automations-validate.ts.
const customField = z.looseObject({
  key: z.string(),
  aliases: z.array(z.string()),
  type: z.string(),
  options: z.array(z.looseObject({ key: z.string(), label: z.string() })),
  label: z.string().optional().meta({
    description: 'What people call the field, as Settings shows it. Documents name it by key.',
  }),
  folder: named.nullable().optional().meta({
    description: 'The folder the field is kept in, in Settings; null when it is in none.',
  }),
});
export const automationSetup = z
  .looseObject({
    fields: z.looseObject({
      contact: z.array(customField),
      deal: z.array(customField),
    }),
    forms: z.array(
      named.extend({
        questions: z
          .array(
            z.looseObject({
              key: z.string(),
              label: z.string(),
              type: z.enum(submissionAnswerKinds),
              options: z.array(z.looseObject({ key: z.string(), label: z.string() })),
            }),
          )
          .optional()
          .meta({
            description:
              'The questions of the published form that have an answer, each read as trigger.answers.<key> by a run a submission of this form started: its kind, and for a choice question its choices by key. For a draft, the questions of the draft. Absent from a server older than this.',
          }),
        status: z.enum(['published', 'draft']).optional().meta({
          description:
            'Whether the form is published. A draft is listed so a trigger can name it and be told to publish it; it takes no submission until then. Archived forms are not listed. Absent from a server older than this: every form listed is published.',
        }),
      }),
    ),
    emailTemplates: z.array(named),
    whatsappTemplates: z.array(named),
    mailboxes: z.array(named),
    phoneNumbers: z.array(named),
    calendars: z.array(named),
    pipelines: z.array(named.extend({ stages: z.array(named) })),
    lostReasons: z.array(named),
    tags: z.array(named),
    users: z.array(named),
    automations: z.array(
      named.extend({
        starts: z.array(z.string()).optional().meta({
          description:
            'The automations its published version starts, by id; a start that would loop back is refused.',
        }),
        startsAfter: z.array(z.string()).optional().meta({
          description:
            'The automations whose runs ending start its published version (its automation.run_ended triggers), by id.',
        }),
        listens: z.array(z.string()).optional().meta({
          description:
            'What its published version listens for on a contact, as keys: field:<path>, tag_added:<tag id> or tag_removed:<tag id>.',
        }),
        writes: z.array(z.string()).optional().meta({
          description:
            'What its published version changes on a contact, as the same keys: a change one workflow makes that another listens for can start it.',
        }),
      }),
    ),
    triggerLinks: z
      .array(named.extend({ key: z.string() }))
      .optional()
      .meta({
        description:
          'The trigger links, each with the key a message writes as {{trigger_link.<key>}}.',
      }),
    values: z.array(z.string()),
    postalAddress: z.boolean().optional().meta({
      description:
        'Whether the business profile has a postal address (a street line), which a marketing email shows at its end. False: every Send email step is warned about it. Absent from a server older than this.',
    }),
    channels: z.looseObject({ email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() }),
    ai: z.boolean(),
    webhooks: z.boolean(),
    webhookSecrets: z.array(z.string()).optional().meta({
      description:
        "The names of the business's webhook secrets, which a webhook step's header may send. Never their values.",
    }),
    emailVerification: z.boolean().optional().meta({
      description:
        'Whether email verification is on, so an Email verification step can check an address. False: a document with one is refused. Absent from a server older than this.',
    }),
    unavailableSteps: z.array(z.string()).meta({
      description: 'Step types this install cannot run yet; a document that uses one is refused.',
    }),
    unavailableTriggers: z.array(z.string()).meta({
      description: 'Trigger types nothing fires yet; a document that uses one is refused.',
    }),
  })
  .meta({
    id: 'AutomationSetup',
    description: "This business's forms, templates, fields and more, which documents refer to.",
  });

// AutomationOutput and AutomationBranches in automations-catalog.ts.
const output = z.looseObject({
  key: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'id', 'date']),
  description: z.string(),
});
const branches = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('none') }),
  z.looseObject({ kind: z.literal('fixed'), names: z.array(z.string()) }),
  z.looseObject({ kind: z.literal('from_config'), field: z.string() }),
]);
export const automationCatalogResponse = z
  .looseObject({
    formatVersion: z.int(),
    triggers: z.array(
      z.looseObject({
        type: z.string(),
        label: z.string(),
        description: z.string(),
        config: z.record(z.string(), z.unknown()),
        outputs: z.array(output),
      }),
    ),
    stopEvents: z.array(z.string()),
    steps: z.array(
      z.looseObject({
        type: z.string(),
        group: z.enum(automationStepGroups),
        version: z.int(),
        label: z.string(),
        description: z.string(),
        config: z.record(z.string(), z.unknown()),
        branches,
        outputs: z.array(output),
      }),
    ),
    stepGroups: z.array(z.enum(automationStepGroups)),
    operators: z.array(
      z.looseObject({ operator: z.string(), value: z.enum(['value', 'none', 'duration']) }),
    ),
    attribution: z
      .looseObject({
        prefixes: z.record(z.string(), z.string()).meta({
          description:
            'The start of each path: first and latest read the contact’s first and latest touch, trigger the touch of the event that started the run.',
        }),
        leaves: z.array(
          z.looseObject({
            key: z.string(),
            type: z.enum(['text', 'single_choice', 'boolean', 'datetime']),
            label: z.string(),
            description: z.string(),
            options: z.array(z.looseObject({ key: z.string(), label: z.string() })),
          }),
        ),
        triggers: z.array(z.string()).meta({
          description: 'The triggers whose runs can read trigger.attribution.',
        }),
        sources: z
          .array(z.looseObject({ key: z.string(), label: z.string() }))
          .optional()
          .meta({
            description:
              'The built-in lead sources: the leaf "source" holds a label of one (such as Google Ads), or the text an address carried in source=; "sourceKey" holds the key.',
          }),
      })
      .optional()
      .meta({
        description:
          'Where a contact came from, as conditions and merge fields read it: a prefix and a leaf, such as trigger.attribution.source. Read-only; a click id is never given, only whether one is held. Absent from a server older than lead sources.',
      }),
    submission: z
      .looseObject({
        page: z.string().meta({
          description: 'The path of the page a form was sent from, without its query.',
        }),
        answers: z.string().meta({
          description:
            'The start of the path of an answer: a question’s key follows it, such as trigger.answers.budget.',
        }),
        triggers: z.array(z.string()).meta({
          description: 'The triggers whose runs have a submission to read.',
        }),
      })
      .optional()
      .meta({
        description:
          'What a run a form submission started reads of that submission, in conditions and merge fields: its answers by question key (a hidden question that read a query parameter among them) and the page it was sent from. Read-only. The questions of each form are in setup.forms. Absent from a server older than this.',
      }),
    failures: z
      .looseObject({
        maxRetries: z.int().meta({ description: 'The most a step retry may ask for in times.' }),
        maxRunRetries: z.int().meta({
          description: 'The most times one failed run may be run again by hand.',
        }),
        retryableSteps: z.array(z.string()).meta({
          description: 'The step types a retry may be put on.',
        }),
        retryableReasons: z.array(z.string()).meta({
          description:
            'The failure codes a retry applies to; a step that fails for another reason is not tried again.',
        }),
      })
      .optional()
      .meta({
        description: 'What a step retry covers. Absent from a server older than failure handling.',
      }),
    setup: automationSetup,
  })
  .meta({ id: 'AutomationCatalog' });

const automationParams = z.object({ id: publicId('automation') });

export const getAutomationSchema = defineEndpoint({
  operationId: 'getAutomationSchema',
  method: 'get',
  path: '/automations/schema',
  summary: 'Read the JSON Schema of the automation document',
  group: 'Automations',
  response: {
    status: 200,
    description: 'A JSON Schema (draft 2020-12) for documents in format version 1.',
    schema: z.record(z.string(), z.unknown()),
  },
});

export const getAutomationCatalog = defineEndpoint({
  operationId: 'getAutomationCatalog',
  method: 'get',
  path: '/automations/catalog',
  summary: 'Read the triggers, steps and this business’s setup',
  group: 'Automations',
  response: {
    status: 200,
    description: 'Each trigger and step with its config schema, and what documents can refer to.',
    schema: automationCatalogResponse,
  },
});

export const listAutomations = defineEndpoint({
  operationId: 'listAutomations',
  method: 'get',
  path: '/automations',
  summary: 'List automations',
  group: 'Automations',
  query: z.strictObject({
    status: z.enum(automationStatuses).optional().meta({
      description:
        'Only automations in this status. archived is the Deleted list; without it, deleted automations are left out.',
    }),
    folder: z
      .union([publicId('automation_folder'), z.literal('root')])
      .optional()
      .meta({ description: 'Only those in this folder, or at the top level (root).' }),
    q: z.string().trim().min(1).max(120).optional().meta({
      description: 'Only those whose name contains this, in every folder unless one is named.',
    }),
    after: publicId('automation').optional(),
  }),
  response: {
    status: 200,
    description:
      'Newest first, 50 at a time, each with its status, its folder, its last run and how many it has enrolled.',
    schema: automationList,
  },
});

export const getAutomation = defineEndpoint({
  operationId: 'getAutomation',
  method: 'get',
  path: '/automations/{id}',
  summary: 'Read an automation',
  group: 'Automations',
  params: automationParams,
  response: {
    status: 200,
    description: 'The current draft, the live version, and what the caller may do.',
    schema: automationView,
  },
});

export const createAutomation = defineEndpoint({
  operationId: 'createAutomation',
  method: 'post',
  path: '/automations',
  summary: 'Create an automation draft',
  group: 'Automations',
  body: createAutomationInput,
  response: {
    status: 201,
    description: 'The new draft, at draft version 1, and what validation found.',
    schema: automationDraftSaved,
  },
});

export const replaceAutomationDraft = defineEndpoint({
  operationId: 'replaceAutomationDraft',
  method: 'put',
  path: '/automations/{id}/draft',
  summary: 'Replace an automation draft',
  group: 'Automations',
  params: automationParams,
  body: replaceAutomationDraftInput,
  response: { status: 200, description: 'The saved draft.', schema: automationDraftSaved },
});

export const patchAutomationDraft = defineEndpoint({
  operationId: 'patchAutomationDraft',
  method: 'patch',
  path: '/automations/{id}/draft',
  summary: 'Edit an automation draft with JSON Patch',
  group: 'Automations',
  params: automationParams,
  body: patchAutomationDraftInput,
  response: { status: 200, description: 'The saved draft.', schema: automationDraftSaved },
});

export const validateAutomationDocument = defineEndpoint({
  operationId: 'validateAutomation',
  method: 'post',
  path: '/automations/validate',
  summary: 'Check an automation document without saving it',
  group: 'Automations',
  body: validateAutomationInput,
  response: {
    status: 200,
    description: 'Each problem at its JSON Pointer, with a fix to try.',
    schema: automationValidation,
  },
});

export const publishAutomationInput = z
  .strictObject({
    baseDraftVersion,
    changeSummary: z
      .string()
      .trim()
      .max(500)
      .default('')
      .meta({ description: 'What changed, for the version history.' }),
  })
  .meta({ id: 'PublishAutomationInput' });

export const publishAutomation = defineEndpoint({
  operationId: 'publishAutomation',
  method: 'post',
  path: '/automations/{id}/publish',
  summary: 'Make the draft the new live version',
  group: 'Automations',
  params: automationParams,
  body: publishAutomationInput,
  response: {
    status: 200,
    description:
      'The automation with its new live version. A draft with errors is refused with each one; a paused automation stays paused.',
    schema: automation,
  },
});

export const pauseAutomation = defineEndpoint({
  operationId: 'pauseAutomation',
  method: 'post',
  path: '/automations/{id}/pause',
  summary: 'Stop new enrolments',
  group: 'Automations',
  params: automationParams,
  response: {
    status: 200,
    description: 'The paused automation. Contacts already in it carry on.',
    schema: automation,
  },
});

export const resumeAutomation = defineEndpoint({
  operationId: 'resumeAutomation',
  method: 'post',
  path: '/automations/{id}/resume',
  summary: 'Restart new enrolments',
  group: 'Automations',
  params: automationParams,
  response: { status: 200, description: 'The active automation.', schema: automation },
});

const versionNumber = z.coerce.number().int().min(1);

export const automationVersionSummary = z
  .looseObject({
    id: publicId('automation_version'),
    version: z.int().min(1),
    changeSummary: z.string(),
    publishedAt: timestamp,
    publishedByKind: z.string(),
  })
  .meta({ id: 'AutomationVersionSummary' });

export const automationVersion = automationVersionSummary
  .extend({ document: automationDraft })
  .meta({ id: 'AutomationVersion', description: 'A published version; it never changes.' });
export type AutomationVersion = z.output<typeof automationVersion>;

export const automationVersionList = z
  .looseObject({
    items: z.array(automationVersionSummary),
    nextCursor: z.int().min(1).nullable(),
  })
  .meta({ id: 'AutomationVersionList' });
export type AutomationVersionList = z.output<typeof automationVersionList>;

export const automationVersionDiff = z
  .looseObject({
    from: z.int().min(1),
    to: z.int().min(1),
    patch: z.array(jsonPatchOperation),
  })
  .meta({
    id: 'AutomationVersionDiff',
    description: 'The JSON Patch (RFC 6902) that turns version from into version to.',
  });
export type AutomationVersionDiff = z.output<typeof automationVersionDiff>;

export const listAutomationVersions = defineEndpoint({
  operationId: 'listAutomationVersions',
  method: 'get',
  path: '/automations/{id}/versions',
  summary: 'List published versions',
  group: 'Automations',
  params: automationParams,
  query: z.strictObject({
    after: versionNumber
      .optional()
      .meta({ description: 'Continue with the versions before this number.' }),
  }),
  response: {
    status: 200,
    description: 'Newest first, 50 at a time.',
    schema: automationVersionList,
  },
});

export const getAutomationVersion = defineEndpoint({
  operationId: 'getAutomationVersion',
  method: 'get',
  path: '/automations/{id}/versions/{version}',
  summary: 'Read a published version',
  group: 'Automations',
  params: z.object({ id: publicId('automation'), version: versionNumber }),
  response: {
    status: 200,
    description: 'The version and its document.',
    schema: automationVersion,
  },
});

export const diffAutomationVersions = defineEndpoint({
  operationId: 'diffAutomationVersions',
  method: 'get',
  path: '/automations/{id}/versions/{from}/diff/{to}',
  summary: 'Compare two published versions',
  group: 'Automations',
  params: z.object({ id: publicId('automation'), from: versionNumber, to: versionNumber }),
  response: {
    status: 200,
    description: 'What changed from one version to the other, as JSON Patch.',
    schema: automationVersionDiff,
  },
});

const traceStep = z.looseObject({
  step: z.string(),
  type: z.string(),
  kind: z.enum(['would_send', 'would_change', 'waited', 'branched', 'moved', 'ended']),
  at: timestamp,
  branch: z.string().optional(),
  explanation: z.string(),
  email: z
    .looseObject({
      subject: z.string(),
      firstLine: z.string().meta({
        description: 'The first line of the text that has words, cut at 200 characters.',
      }),
      missingValues: z.array(z.string()).meta({
        description:
          'Merge fields with no value for this contact. A real send stops on them (missing_values), and the test run fails the step as it would.',
      }),
    })
    .optional()
    .meta({
      description: 'A Send email step: the email filled in for this contact, as a send would.',
    }),
});
const traceOutcome = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('completed') }),
  z.looseObject({ kind: z.literal('stopped'), event: z.string(), at: timestamp }),
  z.looseObject({ kind: z.literal('failed'), step: z.string(), error: z.string() }),
  z.looseObject({ kind: z.literal('limit'), steps: z.int() }),
]);

const sampleValue = z.union([
  z.string().max(1000),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string().max(1000), z.number()])).max(100),
  z.null(),
]);

export const createAutomationTestRunInput = z
  .strictObject({
    contactId: publicId('contact').optional().meta({
      description: 'A real contact whose values the run reads; nothing about them changes.',
    }),
    values: z.record(z.string().max(200), sampleValue).default({}).meta({
      description: "Sample values by field path, used instead of or on top of the contact's.",
    }),
    events: z
      .array(z.strictObject({ event: z.string().max(100), after: isoDuration }))
      .max(50)
      .default([])
      .meta({ description: 'Simulated events, such as message.received after P1D.' }),
    start: z.iso.datetime({ offset: true }).optional(),
  })
  .meta({ id: 'CreateAutomationTestRunInput' });

export const automationTestRun = z
  .looseObject({
    id: publicId('automation_test_run'),
    draftVersion: z.int().min(1),
    status: z.enum(['running', 'passed', 'failed']),
    contactId: publicId('contact').nullable(),
    steps: z.array(traceStep),
    outcome: traceOutcome.nullable(),
    createdAt: timestamp,
  })
  .meta({
    id: 'AutomationTestRun',
    description: 'A dry run of the draft: what each step would do. Nothing was sent or changed.',
  });
export type AutomationTestRun = z.output<typeof automationTestRun>;

export const createAutomationTestRun = defineEndpoint({
  operationId: 'createAutomationTestRun',
  method: 'post',
  path: '/automations/{id}/test-runs',
  summary: 'Test the draft without sending anything',
  group: 'Automations',
  params: automationParams,
  body: createAutomationTestRunInput,
  response: {
    status: 201,
    description: 'The step-by-step trace, with time fast-forwarded.',
    schema: automationTestRun,
  },
});

export const getAutomationTestRun = defineEndpoint({
  operationId: 'getAutomationTestRun',
  method: 'get',
  path: '/automations/{id}/test-runs/{runId}',
  summary: 'Read a test run',
  group: 'Automations',
  params: z.object({ id: publicId('automation'), runId: publicId('automation_test_run') }),
  response: { status: 200, description: 'The step-by-step trace.', schema: automationTestRun },
});

export const automationRunStatuses = [
  'running',
  'waiting',
  'completed',
  'exited',
  'failed',
  'cancelled',
] as const;

/** A step as a list names it: its key, and its type and label in the version that ran. */
export const automationStepNamed = z
  .looseObject({
    step: z.string(),
    type: z.string().nullable().meta({ description: 'The step type, such as email.send.' }),
    label: z.string().nullable().meta({ description: 'The label its author gave it, if any.' }),
  })
  .meta({ id: 'AutomationStepNamed' });

export const automationRunSummary = z
  .looseObject({
    id: publicId('automation_enrolment'),
    automationId: publicId('automation'),
    automationName: z.string().meta({ description: "The automation's name now." }),
    version: z.int().min(1),
    status: z.enum(automationRunStatuses),
    recordId: z.string().meta({ description: 'The record the run is for, such as a contact.' }),
    record: z
      .looseObject({ id: recordId, name: z.string(), trashed: z.boolean() })
      .meta({ description: 'The record the run is for, as it is named now.' }),
    currentStep: z.string().nullable(),
    exitReason: z.string().nullable(),
    wakeAt: timestamp.nullable(),
    startedAt: timestamp,
    finishedAt: timestamp.nullable(),
    trigger: z
      .looseObject({
        id: z.string(),
        type: z
          .string()
          .nullable()
          .meta({ description: 'Null when the version no longer has it.' }),
      })
      .nullable()
      .optional()
      .meta({ description: 'The trigger that enrolled the record; null when none is on record.' }),
    startedBy: z
      .looseObject({
        runId: publicId('automation_enrolment'),
        automationId: publicId('automation'),
        step: z.string(),
      })
      .nullable()
      .optional()
      .meta({
        description:
          'The run, and its step, that started this one from another automation; null when a trigger enrolled the record.',
      }),
    currentAction: automationStepNamed.nullable().optional().meta({
      description:
        'The step the run is at: the one it waits at, or the one it runs next. Null once the run has ended.',
    }),
    revision: z.string().optional().meta({
      description:
        'Changes each time the run moves. Send it back when continuing the run, and a run that moved in between is refused.',
    }),
    continuable: z
      .looseObject({
        branches: z.array(z.string()).meta({
          description:
            'The branches to choose between when continuing; empty for a wait that has none.',
        }),
      })
      .nullable()
      .optional()
      .meta({
        description:
          'Present when the run waits in a wait step a person may end early (POST /automation-runs/{runId}/continue). Null for a run that is not waiting, or waits for something else: a manual action, a webhook, a held message, a retry or its goal.',
      }),
  })
  .meta({ id: 'AutomationRunSummary' });

export const automationRunStep = z
  .looseObject({
    step: z.string(),
    type: z.string().nullable().meta({ description: 'The step type, such as condition.' }),
    status: z.enum(['running', 'succeeded', 'failed', 'skipped', 'waiting']),
    input: z.record(z.string(), z.unknown()).meta({
      description:
        'What the step was given: its settings in the version that ran and, for a condition, the values it compared.',
    }),
    output: z.record(z.string(), z.unknown()).meta({
      description: 'What the step produced, such as the message it queued or when its wait ends.',
    }),
    branch: z.string().nullable(),
    explanation: z.string(),
    error: z.unknown().nullable(),
    attempt: z.int().min(1),
    startedAt: timestamp,
    finishedAt: timestamp.nullable(),
  })
  .meta({
    id: 'AutomationRunStep',
    description: 'One step taken: what it was given, the branch it took, and why.',
  });

export const automationRun = automationRunSummary
  .extend({ steps: z.array(automationRunStep) })
  .meta({ id: 'AutomationRun' });
export type AutomationRun = z.output<typeof automationRun>;

export const automationRunList = z
  .looseObject({
    items: z.array(automationRunSummary),
    nextCursor: publicId('automation_enrolment').nullable(),
  })
  .meta({ id: 'AutomationRunList' });
export type AutomationRunList = z.output<typeof automationRunList>;

export const listAutomationRuns = defineEndpoint({
  operationId: 'listAutomationRuns',
  method: 'get',
  path: '/automations/{id}/runs',
  summary: 'List real runs',
  group: 'Automations',
  params: automationParams,
  query: z.strictObject({
    status: z.enum(automationRunStatuses).optional(),
    from: z.iso.datetime({ offset: true }).optional().meta({
      description: 'Only runs that started at or after this moment.',
    }),
    to: z.iso.datetime({ offset: true }).optional().meta({
      description: 'Only runs that started before this moment.',
    }),
    record: recordId.optional().meta({ description: 'Only runs for this record.' }),
    trigger: automationKey.optional().meta({
      description: 'Only runs this trigger enrolled, by the trigger’s id in the document.',
    }),
    after: publicId('automation_enrolment').optional(),
  }),
  response: {
    status: 200,
    description:
      'The enrollment history: newest first by when each run started, 50 at a time, each with the trigger that enrolled it and the step it is at.',
    schema: automationRunList,
  },
});

export const getAutomationRun = defineEndpoint({
  operationId: 'getAutomationRun',
  method: 'get',
  path: '/automation-runs/{runId}',
  summary: 'Read a real run',
  group: 'Automations',
  params: z.object({ runId: publicId('automation_enrolment') }),
  response: {
    status: 200,
    description: 'Each step taken, the branch it took and why.',
    schema: automationRun,
  },
});

export const retryAutomationRun = defineEndpoint({
  operationId: 'retryAutomationRun',
  method: 'post',
  path: '/automation-runs/{runId}/retry',
  summary: 'Run a failed run again from the step that failed',
  group: 'Automations',
  params: z.object({ runId: publicId('automation_enrolment') }),
  response: {
    status: 200,
    description:
      'The run, running again at the step it failed at, on the version it began on. Refused with 409 when the run did not fail, its automation was deleted or published again since, the contact is gone or already back in the automation, or it has been retried five times.',
    schema: automationRun,
  },
});

export const continueAutomationRunInput = z
  .strictObject({
    branch: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .meta({
        description:
          'The branch the run takes. Required for a wait that ends down one of several branches: wait.event (received, timed_out), wait.condition (met, timed_out), wait.appointment (reached, passed, no_appointment). Left out for wait and wait.until, which have none.',
        examples: ['timed_out'],
      }),
    revision: z.string().max(40).optional().meta({
      description:
        "The run's revision as it was read. Given, a run that has moved since is refused with 409.",
    }),
  })
  .meta({ id: 'ContinueAutomationRunInput' });

export const continueAutomationRun = defineEndpoint({
  operationId: 'continueAutomationRun',
  method: 'post',
  path: '/automation-runs/{runId}/continue',
  summary: "End a waiting run's wait now",
  group: 'Automations',
  params: z.object({ runId: publicId('automation_enrolment') }),
  body: continueAutomationRunInput,
  response: {
    status: 200,
    description:
      "The run, going on from its wait: a wait for a time wakes at once, and a wait with branches takes the branch named, whatever its resume window. The step in the run's history says who continued it. Refused with 409 when the run is not waiting in a wait step (it ended, runs, or waits for a manual action, a webhook, a held message, a retry or its goal) or has moved since the revision given; with 422 when the branch is missing or is not one of the step's.",
    schema: automationRun,
  },
});

export const listRecordAutomationRuns = defineEndpoint({
  operationId: 'listRecordAutomationRuns',
  method: 'get',
  path: '/records/{id}/automation-runs',
  summary: "List a record's automation runs",
  group: 'Automations',
  params: z.object({ id: recordId }),
  query: z.strictObject({
    status: z.enum(automationRunStatuses).optional(),
    after: publicId('automation_enrolment').optional(),
  }),
  response: {
    status: 200,
    description: 'Every automation the record has been through, newest first, 50 at a time.',
    schema: automationRunList,
  },
});

/** Names an exported automation, so an import can tell it from any other JSON. */
export const AUTOMATION_EXPORT_FORMAT = 'crm.automation';

export const automationExport = z
  .looseObject({
    format: z.literal(AUTOMATION_EXPORT_FORMAT),
    formatVersion: z.literal(1),
    exportedAt: timestamp,
    document: automationDraft,
    warnings: z.array(automationIssue).meta({
      description: 'References that could not be named, and so stay ids that only work here.',
    }),
  })
  .meta({
    id: 'AutomationExport',
    description:
      'An automation to move to another business or install: its references are names, resolved again on import.',
  });
export type AutomationExport = z.output<typeof automationExport>;

// Loose, so an export can be sent back as it came; only these members are read.
export const importAutomationInput = z
  .looseObject({
    format: z.literal(AUTOMATION_EXPORT_FORMAT),
    formatVersion: z.literal(1),
    document: automationDraft,
  })
  .meta({ id: 'ImportAutomationInput' });

export const exportAutomation = defineEndpoint({
  operationId: 'exportAutomation',
  method: 'get',
  path: '/automations/{id}/export',
  summary: 'Export an automation',
  group: 'Automations',
  params: automationParams,
  query: z.strictObject({
    source: z
      .enum(['draft', 'live'])
      .default('draft')
      .meta({ description: 'The current draft, or the live version.' }),
  }),
  response: {
    status: 200,
    description: 'The document with each reference by name.',
    schema: automationExport,
  },
});

export const importAutomation = defineEndpoint({
  operationId: 'importAutomation',
  method: 'post',
  path: '/automations/import',
  summary: 'Import an automation as a new draft',
  group: 'Automations',
  body: importAutomationInput,
  response: {
    status: 201,
    description:
      'The new draft, never live, and what validation found, such as names this business lacks.',
    schema: automationDraftSaved,
  },
});

export const automationWebhookSigning = z
  .strictObject({
    configured: z.boolean().meta({
      description: 'Whether this business has a signing secret, so its webhook steps can send.',
    }),
    rotatedAt: timestamp.nullable(),
  })
  .meta({ id: 'AutomationWebhookSigning' });
export type AutomationWebhookSigning = z.output<typeof automationWebhookSigning>;

export const rotatedAutomationWebhookSecret = z
  .strictObject({
    secret: z.string().meta({
      description:
        'The new signing secret. It is shown this once and cannot be read again, only replaced.',
    }),
    rotatedAt: timestamp,
  })
  .meta({ id: 'RotatedAutomationWebhookSecret' });
export type RotatedAutomationWebhookSecret = z.output<typeof rotatedAutomationWebhookSecret>;

export const getAutomationWebhookSigning = defineEndpoint({
  operationId: 'getAutomationWebhookSigning',
  method: 'get',
  path: '/automations/webhook-signing',
  summary: 'See whether webhooks can be signed',
  group: 'Automations',
  response: {
    status: 200,
    description: 'Whether a signing secret exists and when it last changed. Never the secret.',
    schema: automationWebhookSigning,
  },
});

export const rotateAutomationWebhookSecret = defineEndpoint({
  operationId: 'rotateAutomationWebhookSecret',
  method: 'post',
  path: '/automations/webhook-signing/rotate',
  summary: 'Create or replace the webhook signing secret',
  group: 'Automations',
  response: {
    status: 200,
    description:
      'The new secret, once. Webhooks sent from now on are signed with it, so give it to receivers first.',
    schema: rotatedAutomationWebhookSecret,
  },
});
