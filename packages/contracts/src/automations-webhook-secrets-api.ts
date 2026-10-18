// The API for a business's webhook secrets: kept apart from the step's headers, which the
// builder loads with the catalog, so the builder does not carry the endpoints.
import * as z from 'zod';

import { MAX_WEBHOOK_SECRET_LENGTH, webhookSecretName } from './automations-webhook-secrets.js';
import { defineEndpoint } from './endpoints.js';
import { timestamp } from './timestamps.js';

export const automationWebhookSecret = z
  .strictObject({
    name: webhookSecretName,
    rotatedAt: timestamp.meta({ description: 'When its value was last written.' }),
  })
  .meta({ id: 'AutomationWebhookSecret' });
export type AutomationWebhookSecret = z.output<typeof automationWebhookSecret>;

export const automationWebhookSecretList = z
  .strictObject({ items: z.array(automationWebhookSecret) })
  .meta({ id: 'AutomationWebhookSecretList' });
export type AutomationWebhookSecretList = z.output<typeof automationWebhookSecretList>;

export const putAutomationWebhookSecretInput = z
  .strictObject({
    value: z
      .string()
      .min(1)
      .max(MAX_WEBHOOK_SECRET_LENGTH)
      // eslint-disable-next-line no-control-regex -- it is sent as a header's value.
      .regex(/^[^\r\n\u0000]*$/, { error: "A secret can't hold a line break." })
      .meta({ description: 'The value, sealed in the vault. It is never shown again.' }),
  })
  .meta({ id: 'PutAutomationWebhookSecretInput' });

const secretParams = z.object({ name: webhookSecretName });

export const listAutomationWebhookSecrets = defineEndpoint({
  operationId: 'listAutomationWebhookSecrets',
  method: 'get',
  path: '/automations/webhook-secrets',
  summary: 'List the webhook secrets',
  group: 'Automations',
  response: {
    status: 200,
    description: 'The names of the secrets webhook headers can send, never their values.',
    schema: automationWebhookSecretList,
  },
});

export const putAutomationWebhookSecret = defineEndpoint({
  operationId: 'putAutomationWebhookSecret',
  method: 'put',
  path: '/automations/webhook-secrets/{name}',
  summary: 'Create or replace a webhook secret',
  group: 'Automations',
  params: secretParams,
  body: putAutomationWebhookSecretInput,
  response: {
    status: 200,
    description:
      'The secret, by name. Its value is sealed and can only be replaced, never read. Webhooks sent from now on carry the new value.',
    schema: automationWebhookSecret,
  },
});

export const deleteAutomationWebhookSecret = defineEndpoint({
  operationId: 'deleteAutomationWebhookSecret',
  method: 'delete',
  path: '/automations/webhook-secrets/{name}',
  summary: 'Delete a webhook secret',
  group: 'Automations',
  params: secretParams,
  response: {
    status: 204,
    description:
      'The secret is gone. A webhook step whose header names it fails, without sending, until one by that name is stored again.',
  },
});

export const automationWebhookSecretEndpoints = [
  listAutomationWebhookSecrets,
  putAutomationWebhookSecret,
  deleteAutomationWebhookSecret,
] as const;
