import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

export const teamRole = z
  .looseObject({
    id: publicId('role'),
    name: z.string(),
    key: z.string(),
    permissions: z.array(z.string()),
    isBuiltin: z.boolean(),
  })
  .meta({ id: 'TeamRole' });
export const teamMember = z
  .looseObject({
    id: publicId('membership'),
    name: z.string(),
    email: z.string(),
    roleId: publicId('role'),
    roleName: z.string(),
    isSelf: z.boolean(),
    isOwner: z.boolean(),
  })
  .meta({ id: 'TeamMember' });
export const teamInvitation = z
  .looseObject({
    id: publicId('invitation'),
    email: z.string(),
    roleId: publicId('role'),
    roleName: z.string(),
    expiresAt: timestamp,
    status: z.enum(['pending', 'expired', 'accepted', 'revoked']),
    deliveryFailed: z.boolean().optional(),
  })
  .meta({ id: 'TeamInvitation' });
export const team = z
  .looseObject({
    members: z.array(teamMember),
    roles: z.array(teamRole),
    invitations: z.array(teamInvitation),
    canManage: z.boolean(),
  })
  .meta({ id: 'Team' });
export type Team = z.infer<typeof team>;
export type TeamInvitation = z.infer<typeof teamInvitation>;
export const inviteMemberInput = z
  .strictObject({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
    roleId: publicId('role'),
  })
  .meta({ id: 'InviteMemberInput' });
export const invitationIdInput = z.strictObject({ id: publicId('invitation') });
export const membershipIdInput = z.strictObject({ id: publicId('membership') });
export const listTeam = defineEndpoint({
  operationId: 'listTeam',
  method: 'get',
  path: '/team',
  summary: 'List the team and roles',
  group: 'Team',
  response: {
    status: 200,
    description: 'Members, roles and invitations in this workspace.',
    schema: team,
  },
});
export const inviteMember = defineEndpoint({
  operationId: 'inviteMember',
  method: 'post',
  path: '/team/invitations',
  summary: 'Invite a team member',
  group: 'Team',
  body: inviteMemberInput,
  response: {
    status: 201,
    description: 'The pending invitation; its link is delivered by email.',
    schema: teamInvitation,
  },
});
export const resendInvitation = defineEndpoint({
  operationId: 'resendInvitation',
  method: 'post',
  path: '/team/invitations/{id}/resend',
  summary: 'Resend an invitation',
  group: 'Team',
  params: invitationIdInput,
  response: {
    status: 200,
    description: 'The invitation with a fresh seven-day link.',
    schema: teamInvitation,
  },
});
export const revokeInvitation = defineEndpoint({
  operationId: 'revokeInvitation',
  method: 'delete',
  path: '/team/invitations/{id}',
  summary: 'Revoke an invitation',
  group: 'Team',
  params: invitationIdInput,
  response: { status: 204, description: 'The link no longer works.' },
});
export const removeTeamMember = defineEndpoint({
  operationId: 'removeTeamMember',
  method: 'delete',
  path: '/team/members/{id}',
  summary: 'Remove a team member',
  group: 'Team',
  params: membershipIdInput,
  response: { status: 204, description: 'The person no longer belongs to this workspace.' },
});
