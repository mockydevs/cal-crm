// Settings → Users: the people of a workspace as a list that is searched, filtered and
// paged, with what the agency keeps about each: the name in two parts, a phone, a picture,
// an email signature and, in a business, a default calendar. Adding a person sends an
// invitation that carries those details; nobody sets another person's password. The limits
// match tenancy.user_profiles.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { noteDocument } from './notes.js';
import { teamRole } from './team.js';

export const USER_LIMITS = {
  /** Characters in a first or a last name. */
  name: 100,
  /** Digits in a phone extension. */
  extension: 10,
  /** Bytes of a profile image. */
  avatarBytes: 2_500_000,
  /** The most people a page of the list holds. */
  page: 100,
} as const;

const namePart = (what: string) =>
  z
    .string()
    .trim()
    .min(1, { error: `Give the ${what} name.` })
    .max(USER_LIMITS.name, { error: 'Use at most 100 characters.' });
const phone = z
  .string()
  .trim()
  .regex(/^\+[1-9][0-9]{6,14}$/, {
    error: 'Write the number with + and the country code, digits only, such as +13055550123.',
  })
  .meta({ description: 'A phone number in E.164.', examples: ['+13055550123'] });
const extension = z
  .string()
  .trim()
  .regex(/^[0-9]{1,10}$/, { error: 'Use up to 10 digits.' });

/** A signature as the note document the app edits and renders, and whether mail carries it. */
export const userSignature = z
  .strictObject({
    enabled: z.boolean(),
    document: noteDocument.nullable(),
  })
  .meta({ id: 'UserSignature' });

const details = {
  firstName: namePart('first'),
  lastName: namePart('last'),
  phone: phone.nullable().default(null),
  extension: extension.nullable().default(null),
  avatarFileId: publicId('file')
    .nullable()
    .default(null)
    .meta({ description: 'An uploaded PNG, JPEG, GIF or WebP image of at most 2.5 MB.' }),
  roleId: publicId('role'),
  calendarId: publicId('calendar').nullable().default(null).meta({
    description: "The person's default calendar in this business. Always null at the agency.",
  }),
  signature: userSignature.default({ enabled: false, document: null }),
};
const extensionNeedsPhone = (input: { phone: string | null; extension: string | null }) =>
  input.extension === null || input.phone !== null;
const extensionIssue = { path: ['extension'], error: 'Give a phone number for the extension.' };

export const addUserInput = z
  .strictObject({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
    ...details,
  })
  .refine(extensionNeedsPhone, extensionIssue)
  .meta({
    id: 'AddUserInput',
    description:
      'The person is sent an invitation carrying these details, and sets their own password from it.',
  });
export const updateUserInput = z
  .strictObject(details)
  .refine(extensionNeedsPhone, extensionIssue)
  .meta({
    id: 'UpdateUserInput',
    description:
      "The person's details as a whole. The email address is the account's and is not part of it.",
  });

export const user = z
  .looseObject({
    id: z.string().meta({
      description: 'The membership id, or the invitation id of someone who has not accepted yet.',
      examples: ['mem_01h455vb4pex5vsknk084sn02q'],
    }),
    membershipId: publicId('membership').nullable(),
    invitationId: publicId('invitation').nullable(),
    status: z.enum(['active', 'invited', 'invitation_expired']),
    firstName: z.string(),
    lastName: z.string(),
    name: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    extension: z.string().nullable(),
    avatarFileId: publicId('file').nullable(),
    userType: z.enum(['agency', 'account']).meta({
      description:
        "agency: on the agency's own team, working in every business. account: this business's.",
    }),
    roleId: publicId('role'),
    roleKey: z.string(),
    roleName: z.string(),
    isSelf: z.boolean(),
    isOwner: z.boolean(),
    canEdit: z.boolean().meta({ description: 'Whether the caller may change this person here.' }),
    canRemove: z
      .boolean()
      .meta({ description: 'Whether the caller may remove this person from this workspace.' }),
  })
  .meta({ id: 'User' });
export type User = z.output<typeof user>;

export const userDetail = user
  .extend({
    calendarId: publicId('calendar').nullable(),
    signature: userSignature,
    deliveryFailed: z.boolean().optional().meta({
      description: 'Only on the answer to adding a person: the invitation email could not be sent.',
    }),
  })
  .meta({ id: 'UserDetail' });
export type UserDetail = z.output<typeof userDetail>;

export const listUsersQuery = z
  .strictObject({
    q: z
      .string()
      .trim()
      .max(200, { error: 'Use at most 200 characters.' })
      .optional()
      .meta({ description: 'Finds people by any part of their name, email or phone, or by id.' }),
    role: publicId('role').optional().meta({ description: 'Only people with this role.' }),
    type: z.enum(['agency', 'account']).optional(),
    limit: z.coerce.number().int().min(1).max(USER_LIMITS.page).default(20),
    after: z
      .string()
      .max(600)
      .optional()
      .meta({ description: 'Start after the previous page: its next, exactly as it was given.' }),
  })
  .meta({ id: 'ListUsersQuery' });
export type ListUsersQuery = z.output<typeof listUsersQuery>;

export const userList = z
  .looseObject({
    items: z.array(user),
    total: z.int().meta({ description: 'How many people match the filters, on every page.' }),
    next: z
      .string()
      .nullable()
      .meta({ description: 'Pass it as after to read the next page. Null on the last page.' }),
    roles: z
      .array(teamRole)
      .meta({ description: 'The roles a person of this workspace can be given.' }),
    canManage: z.boolean(),
  })
  .meta({ id: 'UserList' });
export type UserList = z.output<typeof userList>;

const group = 'Users';
const userParams = z.strictObject({ userId: publicId('membership') });

export const listUsers = defineEndpoint({
  operationId: 'listUsers',
  method: 'get',
  path: '/users',
  group,
  summary: 'Read the people of this workspace by name, a page at a time',
  query: listUsersQuery,
  response: {
    status: 200,
    description:
      "A page of people in name order, and how many match. In a business it includes the agency's own team, who work in every business, and people invited but not yet joined.",
    schema: userList,
  },
});
export const addUser = defineEndpoint({
  operationId: 'addUser',
  method: 'post',
  path: '/users',
  group,
  summary: 'Add a person: invite them with their details',
  body: addUserInput,
  response: {
    status: 201,
    description: 'The invited person. They join, with these details, when they accept.',
    schema: userDetail,
  },
});
export const getUser = defineEndpoint({
  operationId: 'getUser',
  method: 'get',
  path: '/users/{userId}',
  group,
  summary: 'Read one person of this workspace',
  params: userParams,
  response: { status: 200, description: 'The person as saved.', schema: userDetail },
});
export const updateUser = defineEndpoint({
  operationId: 'updateUser',
  method: 'put',
  path: '/users/{userId}',
  group,
  summary: "Change a person's details, role, default calendar or signature",
  params: userParams,
  body: updateUserInput,
  response: { status: 200, description: 'The person as saved.', schema: userDetail },
});

/** Every endpoint behind Settings → Users, beside the team's own for invitations and removal. */
export const userEndpoints = [listUsers, addUser, getUser, updateUser] as const;
