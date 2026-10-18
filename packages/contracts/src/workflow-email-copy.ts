import * as z from 'zod';
import { automationDraft, automationDraftSaved } from './automations-api.js';
import { automationKey } from './automations-values.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { messageTemplateRevisionInput } from './message-templates.js';

export const copyWorkflowEmailTemplateInput = messageTemplateRevisionInput.extend({
  baseDraftVersion: z.int().min(1),
  step: automationKey,
  template: publicId('template'),
  document: automationDraft.optional(),
});

export const copyWorkflowEmailTemplate = defineEndpoint({
  operationId: 'copyWorkflowEmailTemplate',
  method: 'post',
  path: '/automations/{id}/draft/email-template-copy',
  summary: 'Copy an email template into a workflow action',
  group: 'Automations',
  params: z.strictObject({ id: publicId('automation') }),
  body: copyWorkflowEmailTemplateInput,
  response: {
    status: 200,
    description: 'The revised draft with independent email content.',
    schema: automationDraftSaved,
  },
});

export const workflowEmailCopyEndpoints = [copyWorkflowEmailTemplate] as const;
