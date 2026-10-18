// Request headers on a webhook.call step, and the business's named webhook secrets they can
// take a value from: an API key goes in a header, sealed in the vault, rather than in the
// URL, which the document, its versions and the run history all keep. A secret's value is
// written once and never read back.
import * as z from 'zod';

import { automationKey } from './automations-values.js';

/** The most headers one webhook step sends. */
export const MAX_WEBHOOK_HEADERS = 10;

/** The longest value a webhook secret may hold. */
export const MAX_WEBHOOK_SECRET_LENGTH = 4000;

/** The most webhook secrets one business keeps. */
export const MAX_WEBHOOK_SECRETS = 100;

/** An HTTP field name: a token (RFC 9110 section 5.6.2). */
const webhookHeaderName = z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,100}$/, {
  error: 'Not a header name.',
});

/** A business's webhook secret, by the name a header gives. */
export const webhookSecretName = automationKey;

export const webhookHeader = z.union([
  z.strictObject({
    name: webhookHeaderName,
    value: z
      .string()
      .min(1)
      .max(1000)
      // eslint-disable-next-line no-control-regex -- a line break would end the header.
      .regex(/^[^\r\n\u0000]*$/, { error: "A header's value can't hold a line break." }),
  }),
  z.strictObject({
    name: webhookHeaderName,
    secret: webhookSecretName,
  }),
]);
export type WebhookHeader = z.output<typeof webhookHeader>;

export const webhookHeaders = z.array(webhookHeader).max(MAX_WEBHOOK_HEADERS);
