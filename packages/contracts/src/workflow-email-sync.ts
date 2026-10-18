// "Sync edits to template" on a workflow's Send email step. A step that syncs holds a
// reference to the library template and no content of its own: every send reads the
// template as it is then, so an edit made in the library reaches the step at once, and an
// edit made through the step is an edit of the template. Turning sync off is the existing
// copy operation (workflow-email-copy.ts): it captures the template's content into the
// step, which is independent from then on.
import * as z from 'zod';
import { automationDraft, automationDraftSaved } from './automations-api.js';
import { automationKey } from './automations-values.js';
import { emailContent, emailPreheader } from './email-content.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { messageTemplateRevision } from './message-template-revision.js';
import { messageTemplate } from './message-templates.js';

const draftTarget = {
  baseDraftVersion: z.int().min(1),
  step: automationKey,
  document: automationDraft.optional().meta({
    description:
      'The draft as the builder holds it, with unsaved changes and new steps. Left out, the saved draft.',
  }),
};

export const enableWorkflowEmailSyncInput = z
  .strictObject({
    ...draftTarget,
    template: publicId('template'),
    revision: messageTemplateRevision.meta({
      description: 'The template’s revision as it was read. A stale one returns 409.',
    }),
  })
  .meta({ id: 'EnableWorkflowEmailSyncInput' });

export const enableWorkflowEmailSync = defineEndpoint({
  operationId: 'enableWorkflowEmailSync',
  method: 'post',
  path: '/automations/{id}/draft/email-sync',
  summary: 'Make a workflow email action sync with a template',
  group: 'Automations',
  params: z.strictObject({ id: publicId('automation') }),
  body: enableWorkflowEmailSyncInput,
  response: {
    status: 200,
    description:
      'The revised draft. The action now sends the template as it is at each send; the content it held is gone, and the template is not changed. Its mailbox, From name, Reply-To, Cc, Bcc, attachments and own subject are kept.',
    schema: automationDraftSaved,
  },
});

export const saveSyncedWorkflowEmailInput = z
  .strictObject({
    ...draftTarget,
    revision: messageTemplateRevision.meta({
      description: 'The linked template’s revision as it was read. A stale one returns 409.',
    }),
    subject: z
      .string()
      .trim()
      .min(1, { error: 'Give the email a subject.' })
      .max(255)
      .regex(/^[^\r\n]*$/, { error: 'Keep the subject on one line.' }),
    content: emailContent,
    preheader: emailPreheader.nullable().optional(),
  })
  .meta({ id: 'SaveSyncedWorkflowEmailInput' });

export const syncedWorkflowEmailSaved = z
  .looseObject({ saved: automationDraftSaved, template: messageTemplate })
  .meta({ id: 'SyncedWorkflowEmailSaved' });
export type SyncedWorkflowEmailSaved = z.output<typeof syncedWorkflowEmailSaved>;

export const saveSyncedWorkflowEmail = defineEndpoint({
  operationId: 'saveSyncedWorkflowEmail',
  method: 'put',
  path: '/automations/{id}/draft/email-sync/content',
  summary: 'Edit the template a syncing workflow email action sends',
  group: 'Automations',
  params: z.strictObject({ id: publicId('automation') }),
  body: saveSyncedWorkflowEmailInput,
  response: {
    status: 200,
    description:
      'The template’s next revision and the revised draft, saved together or not at all. Every action that syncs with the template sends the new content from now on. Needs templates.manage as well as automations.manage.',
    schema: syncedWorkflowEmailSaved,
  },
});

// Which workflow actions use a template: the inventory the template screen shows.
export const templateWorkflowAction = z
  .looseObject({
    automation: z.looseObject({
      id: publicId('automation'),
      name: z.string(),
      status: z.string(),
    }),
    scope: z.enum(['draft', 'published']).meta({
      description:
        'draft: the automation’s draft. published: the version it runs now. Older versions that runs are still on are not listed.',
    }),
    version: publicId('automation_version').nullable(),
    step: z.string(),
    label: z.string().nullable(),
    mode: z.enum(['sync', 'copy', 'reference']).meta({
      description:
        'sync: sends the template as it is at each send. reference: an older step that does the same. copy: independent content that was copied from the template; a library edit does not reach it.',
    }),
    sourceRevision: messageTemplateRevision.nullable().meta({
      description: 'The template revision the action was copied from or last linked at.',
    }),
    current: z.boolean().nullable().meta({
      description:
        'For a copy: whether it was copied from the template as it is now. Null for sync and reference, which always send the current template.',
    }),
  })
  .meta({ id: 'TemplateWorkflowAction' });
export type TemplateWorkflowAction = z.output<typeof templateWorkflowAction>;

export const templateWorkflowActionList = z
  .looseObject({
    items: z.array(templateWorkflowAction),
    nextCursor: publicId('automation').nullable(),
  })
  .meta({ id: 'TemplateWorkflowActionList' });
export type TemplateWorkflowActionList = z.output<typeof templateWorkflowActionList>;

export const listTemplateWorkflowActions = defineEndpoint({
  operationId: 'listTemplateWorkflowActions',
  method: 'get',
  path: '/message-templates/{id}/workflow-actions',
  summary: 'Read the workflow email actions that use a template',
  group: 'Message templates',
  params: z.strictObject({ id: publicId('template') }),
  query: z.strictObject({
    after: publicId('automation').optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  response: {
    status: 200,
    description:
      'The Send email actions, in the drafts and the running versions of up to `limit` automations in id order, that sync with, refer to or were copied from this template.',
    schema: templateWorkflowActionList,
  },
});

// What one Send email step has done (the action's Statistics tab), from the step's runs
// and the messages they queued. Opens and clicks are not measured yet: null, never zero.
export const workflowEmailSkipReasons = [
  'no_consent',
  'unsubscribed',
  'do_not_contact',
  'suppressed',
  'bounced_before',
  'complained',
  'no_email_address',
  'contact_removed',
  'no_time_zone',
  'mailbox_unavailable',
  'unsubscribe_unavailable',
  'other',
] as const;
export type WorkflowEmailSkipReason = (typeof workflowEmailSkipReasons)[number];

export const workflowEmailStepStatistics = z
  .looseObject({
    step: z.string(),
    from: z.iso.datetime().nullable(),
    to: z.iso.datetime().nullable(),
    total: z.int().meta({ description: 'Visits to the step that tried to send an email.' }),
    waiting: z.int().meta({
      description: 'Queued or held (quiet hours, daily limits, sending pace) and not yet sent.',
    }),
    sent: z.int().meta({ description: 'Accepted by the mail server, bounced later or not.' }),
    delivered: z.int().nullable().meta({
      description:
        'Null: a mail server accepting an email is not proof it reached the inbox, and nothing here measures that.',
    }),
    bounced: z.int().meta({ description: 'Sent, then returned by a bounce report.' }),
    failed: z.int().meta({
      description:
        'Not sent because something was wrong: the mail server refused it, its delivery is unknown, the template or a merge value was missing, or a file could not be attached.',
    }),
    skipped: z.looseObject({
      total: z.int(),
      reasons: z.array(z.looseObject({ reason: z.enum(workflowEmailSkipReasons), count: z.int() })),
    }),
    unsubscribed: z.int().meta({
      description: 'Contacts who used the unsubscribe link of an email this step sent.',
    }),
    opened: z.null().meta({ description: 'Opens are not measured yet.' }),
    clicked: z.null().meta({ description: 'Clicks are not measured yet.' }),
  })
  .meta({ id: 'WorkflowEmailStepStatistics' });
export type WorkflowEmailStepStatistics = z.output<typeof workflowEmailStepStatistics>;

export const getWorkflowEmailStepStatistics = defineEndpoint({
  operationId: 'getWorkflowEmailStepStatistics',
  method: 'get',
  path: '/automations/{id}/steps/{step}/email-statistics',
  summary: 'Read what one Send email action has sent',
  group: 'Automations',
  params: z.strictObject({ id: publicId('automation'), step: automationKey }),
  query: z.strictObject({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  }),
  response: {
    status: 200,
    description:
      'Counts for the step across every version of the automation, for visits that began in the range.',
    schema: workflowEmailStepStatistics,
  },
});

export const workflowEmailSyncEndpoints = [
  enableWorkflowEmailSync,
  saveSyncedWorkflowEmail,
  listTemplateWorkflowActions,
  getWorkflowEmailStepStatistics,
] as const;
