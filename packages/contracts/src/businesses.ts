// Businesses: the agency's clients, each with its own contacts, deals and settings. The
// limits match tenancy.businesses.
import { isCurrencyCode, isTimeZone } from '@repo/kernel';
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { businessStatuses } from './me.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** A business's address in the dashboard: lower-case letters, digits and hyphens. */
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const business = z
  .looseObject({
    id: publicId('business'),
    name: z.string().meta({ examples: ['Harbor Lights Events'] }),
    slug: z.string().meta({ examples: ['harbor-lights-events'] }),
    status: z.enum(businessStatuses),
    timezone: z.string().meta({ examples: ['America/New_York'] }),
    currency: z.string().meta({ examples: ['USD'] }),
    locale: z.string().meta({ examples: ['en'] }),
    createdAt: timestamp,
  })
  .meta({ id: 'Business', description: 'A business of the agency.' });

export type Business = z.infer<typeof business>;

export const createBusinessInput = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1, { error: 'Give the business a name.' })
      .max(200, { error: 'Use at most 200 characters.' }),
    slug: z
      .string()
      .regex(SLUG, {
        error:
          'Use lower-case letters, digits and hyphens, up to 63, starting and ending with a letter or digit.',
      })
      .optional()
      .meta({
        description: "Its address in the dashboard; made from the name when it's left out.",
      }),
    timezone: z
      .string()
      .refine(isTimeZone, { error: "This isn't a time zone, such as America/New_York." })
      .meta({ examples: ['America/New_York'] }),
    currency: z
      .string()
      .refine(isCurrencyCode, { error: "This isn't a currency code, such as USD." })
      .meta({ examples: ['USD'] }),
    locale: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, {
        error: "This isn't a language tag, such as en or en-GB.",
      })
      .default('en'),
  })
  .meta({ id: 'CreateBusinessInput' });

export type CreateBusinessInput = z.input<typeof createBusinessInput>;

export const createBusiness = defineEndpoint({
  operationId: 'createBusiness',
  method: 'post',
  path: '/businesses',
  summary: 'Create a business',
  group: 'Businesses',
  body: createBusinessInput,
  response: {
    status: 201,
    description:
      'The new business, with what every business starts with: contacts, companies and deals, how they link, and a sales pipeline. Agency staff only, at the agency.',
    schema: business,
  },
});
