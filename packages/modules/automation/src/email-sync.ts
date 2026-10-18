// "Sync edits to template" on a draft's Send email step.
//
// Turning it on makes the step a reference to the library template: the content the step
// held is gone and the template is not changed. Editing a syncing step's content is an edit
// of the template, made by messaging's own command inside this one's transaction, so the
// template's next revision and the draft's new provenance are saved together or not at
// all. Turning it off is the copy command (email-template-copy.ts), which captures the
// template's content into the step.
//
// Locks are taken in this order: the template's row first (messaging's update takes
// it), then the automation's.
import { defineCommand, requireBusiness, type Command } from '@repo/commands';
import {
  enableWorkflowEmailSyncInput,
  publicId,
  saveSyncedWorkflowEmailInput,
  type AutomationDraftSaved,
  type SyncedWorkflowEmailSaved,
} from '@repo/contracts';
import { ConflictError, NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';
import { readTemplate, type TemplateCommands } from '@repo/module-messaging';
import * as z from 'zod';

import { checkedDocument, createDraftCommands, lockedDraft, type ReadSetup } from './drafts.js';
import { keptEnvelope } from './email-template-copy.js';

const enableInput = enableWorkflowEmailSyncInput.extend({ id: publicId('automation') });
const saveInput = saveSyncedWorkflowEmailInput.extend({ id: publicId('automation') });

const notAnEmailStep = (): ValidationError =>
  new ValidationError([
    {
      path: '/step',
      code: 'invalid_email_action',
      message: 'Choose an existing Send email action.',
    },
  ]);

// The draft the builder holds, or the saved one, with the step it names.
function emailStepOf(
  given: unknown,
  stepKey: string,
): {
  readonly document: Record<string, unknown>;
  readonly steps: Record<string, unknown>;
  readonly step: Record<string, unknown> & { config: Record<string, unknown> };
} {
  const document = z.record(z.string(), z.unknown()).parse(checkedDocument(given, '/document'));
  const steps = z.record(z.string(), z.unknown()).safeParse(document['steps']);
  const step = z
    .looseObject({ type: z.literal('email.send'), config: z.record(z.string(), z.unknown()) })
    .safeParse(steps.success ? steps.data[stepKey] : undefined);
  if (!steps.success || !step.success) throw notAnEmailStep();
  return { document, steps: steps.data, step: step.data };
}

export interface EmailSyncCommands {
  readonly enable: Command<typeof enableInput, AutomationDraftSaved>;
  readonly save: Command<typeof saveInput, SyncedWorkflowEmailSaved>;
}

export function createEmailSyncCommands({
  setup,
  templates,
}: {
  setup: ReadSetup;
  /** Messaging's own template commands: a synced edit is an edit of the template. */
  templates: Pick<TemplateCommands, 'update'>;
}): EmailSyncCommands {
  const drafts = createDraftCommands({ setup });

  const enable = defineCommand({
    name: 'automation.enable_email_sync',
    permission: 'automations.manage',
    input: enableInput,
    audit: ({ id, baseDraftVersion, step, template, revision }) => ({
      automationId: id,
      baseDraftVersion,
      step,
      template,
      revision,
    }),
    async handle(trx, input, command): Promise<AutomationDraftSaved> {
      requireBusiness(command.context);
      const template = await readTemplate(trx, command, input.template);
      if (template.revision !== input.revision)
        throw new ConflictError('The selected template changed. Read it again before syncing.');
      if (template.archivedAt !== null)
        throw new ValidationError([
          {
            path: '/template',
            code: 'template_unavailable',
            message: 'Choose an active email template.',
          },
        ]);
      const current = await lockedDraft(trx, input.id, input.baseDraftVersion);
      const { document, steps, step } = emailStepOf(input.document ?? current.draft, input.step);
      const config = {
        ...keptEnvelope(step.config),
        // Only a step that already sent a template keeps a subject of its own: a subject
        // written with content of its own was that content's, and goes with it.
        ...(typeof step.config['subject'] === 'string' &&
        (step.config['mode'] === 'sync' || 'template' in step.config)
          ? { subject: step.config['subject'] }
          : {}),
        mode: 'sync',
        source: { id: template.id, revision: template.revision },
      };
      if (command.runChild === undefined) throw new Error('Canonical child runner missing.');
      return command.runChild(drafts.replace, {
        id: input.id,
        baseDraftVersion: input.baseDraftVersion,
        document: { ...document, steps: { ...steps, [input.step]: { ...step, config } } },
      });
    },
  });

  const save = defineCommand({
    name: 'automation.save_synced_email',
    permission: 'automations.manage',
    input: saveInput,
    // Which template and step, never the text.
    audit: ({ id, baseDraftVersion, step, revision }) => ({
      automationId: id,
      baseDraftVersion,
      step,
      revision,
    }),
    async handle(trx, input, command): Promise<SyncedWorkflowEmailSaved> {
      requireBusiness(command.context);
      // Read before any lock, to learn which template the step syncs with.
      const automationId = parsePublicId('automation', input.id);
      const unlocked =
        automationId === undefined
          ? undefined
          : await trx
              .selectFrom('automation.automations')
              .select('draft')
              .where('id', '=', automationId)
              .where('status', '<>', 'archived')
              .executeTakeFirst();
      if (unlocked === undefined) throw new NotFoundError('automation', input.id);
      const before = emailStepOf(input.document ?? unlocked.draft, input.step);
      const source = z
        .object({ mode: z.literal('sync'), source: z.object({ id: publicId('template') }) })
        .safeParse(before.step.config);
      if (!source.success)
        throw new ValidationError([
          {
            path: '/step',
            code: 'not_synced',
            message: 'This action does not sync with a template. Save its content in the draft.',
          },
        ]);
      const linked = await readTemplate(trx, command, source.data.source.id);
      if (command.runChild === undefined) throw new Error('Canonical child runner missing.');
      // The template's own command: its permission, its revision check, its cleaning.
      const template = await command.runChild(templates.update, {
        id: linked.id,
        revision: input.revision,
        name: linked.name,
        subject: input.subject,
        content: input.content,
        preheader: input.preheader ?? null,
      });
      const current = await lockedDraft(trx, input.id, input.baseDraftVersion);
      const { document, steps, step } = emailStepOf(input.document ?? current.draft, input.step);
      // The same step, still syncing with the same template, under the lock.
      if (step.config['mode'] !== 'sync')
        throw new ConflictError('This action stopped syncing. Read the draft again.');
      const config = {
        ...step.config,
        source: { id: template.id, revision: template.revision },
      };
      const saved = await command.runChild(drafts.replace, {
        id: input.id,
        baseDraftVersion: input.baseDraftVersion,
        document: { ...document, steps: { ...steps, [input.step]: { ...step, config } } },
      });
      return { saved, template };
    },
  });

  return { enable, save };
}
