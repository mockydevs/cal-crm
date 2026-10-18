// Who is signed in, and where they can work: what the dashboard's shell and its business
// switcher read.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { permissions } from './permissions.js';

export const businessStatuses = ['active', 'suspended', 'archived'] as const;

export const businessSummary = z
  .looseObject({
    id: publicId('business'),
    name: z.string().meta({ examples: ['Harbor Lights Events'] }),
    slug: z
      .string()
      .meta({ description: 'Unique in the agency; the dashboard puts it in its address.' }),
    status: z.enum(businessStatuses),
    // Every answer of this server carries the two below. They are optional here only so
    // that an answer saved before they existed still reads.
    city: z
      .string()
      .nullable()
      .optional()
      .meta({
        description: "The town in the business profile's address; null when it has none.",
        examples: ['Mombasa'],
      }),
    region: z
      .string()
      .nullable()
      .optional()
      .meta({
        description:
          "The county, state or province in the business profile's address; null when it has none.",
        examples: ['Mombasa County'],
      }),
    // Optional for the same reason as the two above.
    timezone: z
      .string()
      .optional()
      .meta({
        description:
          "The business's time zone (IANA), from its profile: the calendar is drawn in it.",
        examples: ['America/New_York'],
      }),
  })
  .meta({ id: 'BusinessSummary', description: 'A business you may enter.' });

export type BusinessSummary = z.infer<typeof businessSummary>;

export const me = z
  .looseObject({
    user: z.looseObject({
      name: z.string().meta({ examples: ['Dana Brooks'] }),
      email: z.string().meta({ examples: ['dana@harborlights.example'] }),
    }),
    agency: z.looseObject({
      name: z.string().meta({ examples: ['Bluebird Digital'] }),
      slug: z.string(),
    }),
    agencyStaff: z.boolean().meta({
      description:
        'Whether you work for the agency itself, and so may enter all of its businesses.',
    }),
    businesses: z.array(businessSummary).meta({
      description: "The businesses you may enter, by name: all of the agency's for agency staff.",
    }),
    business: publicId('business')
      .nullable()
      .meta({ description: 'The business this request works in; null at the agency.' }),
  })
  .meta({ id: 'Me', description: 'Who is signed in, and where they can work.' });

export type Me = z.infer<typeof me>;

export const getMe = defineEndpoint({
  operationId: 'getMe',
  method: 'get',
  path: '/me',
  summary: 'Who you are, and where you can work',
  group: 'Account',
  response: { status: 200, description: 'You, your agency and your businesses.', schema: me },
});

export const myPermissions = z
  .looseObject({
    business: publicId('business')
      .nullable()
      .meta({ description: 'The business this request works in; null at the agency.' }),
    permissions: z.array(z.enum(permissions)).meta({
      description:
        'What this request may change where it works, in the order of the permission catalog. It is for showing and hiding only: every command checks its own permission, whatever this says.',
    }),
  })
  .meta({ id: 'MyPermissions', description: 'What you may change here.' });

export type MyPermissions = z.infer<typeof myPermissions>;

export const getMyPermissions = defineEndpoint({
  operationId: 'getMyPermissions',
  method: 'get',
  path: '/me/permissions',
  summary: 'What you may change in this business, or at the agency',
  group: 'Account',
  response: {
    status: 200,
    description: 'The permissions of your role, or of the API key, where this request works.',
    schema: myPermissions,
  },
});
