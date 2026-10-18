// The agency's own settings, which agency staff change outside any business
// (DATABASE.md section 3.2). They live on tenancy.agencies.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';

export const twoFactorRequirement = z
  .strictObject({
    required: z.boolean().meta({
      description:
        "Whether the agency's staff must sign in with two factors: a code from an authenticator app as well as their password or a sign-in link. A passkey counts as both.",
    }),
  })
  .meta({
    id: 'TwoFactorRequirement',
    description:
      "Whether the agency requires two-factor sign-in of its staff. Until they've set it up, the API answers them with 403.",
  });

export type TwoFactorRequirement = z.infer<typeof twoFactorRequirement>;

export const getTwoFactorRequirement = defineEndpoint({
  operationId: 'getTwoFactorRequirement',
  method: 'get',
  path: '/agency/two-factor-requirement',
  summary: 'Whether the agency requires two-factor sign-in',
  group: 'Agency',
  response: { status: 200, description: "The agency's requirement.", schema: twoFactorRequirement },
});

export const setTwoFactorRequirement = defineEndpoint({
  operationId: 'setTwoFactorRequirement',
  method: 'put',
  path: '/agency/two-factor-requirement',
  summary: 'Require two-factor sign-in of the agency’s staff, or stop',
  group: 'Agency',
  body: twoFactorRequirement,
  response: {
    status: 200,
    description: 'The requirement, as saved.',
    schema: twoFactorRequirement,
  },
});
