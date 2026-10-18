// Business Settings. The existing address JSON uses postal fields and a two-letter country
// code; files remain owned and served by the files module.
import * as z from 'zod';
import { createBusinessInput } from './businesses.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';

const addressLine = z.string().trim().max(200, { error: 'Use at most 200 characters.' });
export const businessAddress = z
  .strictObject({
    line1: addressLine,
    line2: addressLine,
    city: addressLine,
    region: addressLine,
    postalCode: z.string().trim().max(32),
    country: z
      .string()
      .regex(/^(?:[A-Z]{2})?$/, { error: 'Use a two-letter country code, such as KE.' }),
  })
  .meta({ id: 'BusinessAddress' });

export const updateBusinessProfileInput = createBusinessInput
  .omit({ slug: true })
  .extend({
    locale: createBusinessInput.shape.locale.unwrap(),
    address: businessAddress.nullable(),
    logoFileId: publicId('file').nullable(),
  })
  .meta({ id: 'UpdateBusinessProfileInput' });

export type UpdateBusinessProfileInput = z.infer<typeof updateBusinessProfileInput>;

export const businessProfile = updateBusinessProfileInput
  .extend({
    id: publicId('business'),
    canManage: z.boolean(),
  })
  .meta({ id: 'BusinessProfile' });
export type BusinessProfile = z.infer<typeof businessProfile>;

export const getBusinessProfile = defineEndpoint({
  operationId: 'getBusinessProfile',
  method: 'get',
  path: '/business-profile',
  summary: 'Get the current business profile',
  group: 'Businesses',
  response: {
    status: 200,
    description: 'The selected business and whether its profile may be changed.',
    schema: businessProfile,
  },
});
export const updateBusinessProfile = defineEndpoint({
  operationId: 'updateBusinessProfile',
  method: 'put',
  path: '/business-profile',
  summary: 'Update the current business profile',
  group: 'Businesses',
  body: updateBusinessProfileInput,
  response: { status: 200, description: 'The saved business profile.', schema: businessProfile },
});
