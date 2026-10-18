import { defineCommand, requireBusiness, type Command } from '@repo/commands';
import {
  copyWorkflowEmailTemplateInput,
  publicId,
  type AutomationDraftSaved,
} from '@repo/contracts';
import { ConflictError, ValidationError } from '@repo/kernel';
import { readTemplate } from '@repo/module-messaging';
import * as z from 'zod';
import { checkedDocument, createDraftCommands, lockedDraft, type ReadSetup } from './drafts.js';

const input = copyWorkflowEmailTemplateInput.extend({
  id: publicId('automation'),
});

/** The keys of a Send email step's config that are not content, and survive a change of content. */
export const EMAIL_ENVELOPE_KEYS = [
  'mailbox',
  'fromName',
  'replyTo',
  'cc',
  'bcc',
  'attachments',
] as const;

export const keptEnvelope = (config: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(
    EMAIL_ENVELOPE_KEYS.flatMap((key) => (config[key] === undefined ? [] : [[key, config[key]]])),
  );

/** Copies a selected library revision; subsequent library edits cannot change this draft. */
export function createEmailTemplateCopyCommand({
  setup,
}: {
  setup: ReadSetup;
}): Command<typeof input, AutomationDraftSaved> {
  const drafts = createDraftCommands({ setup });
  return defineCommand({
    name: 'automation.copy_email_template',
    permission: 'automations.manage',
    input,
    audit: ({ id, baseDraftVersion, step, template, revision }) => ({
      automationId: id,
      baseDraftVersion,
      step,
      template,
      revision,
    }),
    async handle(trx, input, command) {
      requireBusiness(command.context);
      const template = await readTemplate(trx, command, input.template);
      if (template.revision !== input.revision)
        throw new ConflictError('The selected template changed. Read it again before copying.');
      if (template.archivedAt !== null)
        throw new ValidationError([
          {
            path: '/template',
            code: 'template_unavailable',
            message: 'Choose an active email template.',
          },
        ]);
      const current = await lockedDraft(trx, input.id, input.baseDraftVersion);
      const document = z
        .record(z.string(), z.unknown())
        .parse(checkedDocument(input.document ?? current.draft, '/document'));
      const steps = z.record(z.string(), z.unknown()).safeParse(document['steps']);
      const step = z
        .looseObject({
          type: z.literal('email.send'),
          config: z.record(z.string(), z.unknown()),
        })
        .safeParse(steps.success ? steps.data[input.step] : undefined);
      if (!steps.success || !step.success)
        throw new ValidationError([
          {
            path: '/step',
            code: 'invalid_email_action',
            message: 'Choose an existing Send email action.',
          },
        ]);
      const config = {
        // What the step says besides its content stays the step's own.
        ...keptEnvelope(step.data.config),
        mode: 'copy',
        source: { id: template.id, revision: template.revision },
        subject: template.subject,
        body: template.body,
        ...(template.content.format === 'html'
          ? {
              html: template.content.html,
              ...(template.preheader === null ? {} : { preheader: template.preheader }),
            }
          : {}),
      };
      if (command.runChild === undefined) throw new Error('Canonical child runner missing.');
      return command.runChild(drafts.replace, {
        id: input.id,
        baseDraftVersion: input.baseDraftVersion,
        document: { ...document, steps: { ...steps.data, [input.step]: { ...step.data, config } } },
      });
    },
  });
}
