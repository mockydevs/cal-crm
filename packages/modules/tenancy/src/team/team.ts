import { createHash, randomBytes } from 'node:crypto';
import {
  defineCommand,
  type Command,
  type CommandContext,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  inviteMemberInput,
  invitationIdInput,
  membershipIdInput,
  permissionsOf,
  type Team,
  type TeamInvitation,
} from '@repo/contracts';
import { explainUniqueViolation, withTenant, type DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
} from '@repo/kernel';
import { sql, type Selectable } from 'kysely';
import type { DB } from '@repo/db';

export interface TeamPerson {
  readonly name: string;
  readonly email: string;
}
export type TeamPeople = (
  trx: DatabaseTransaction,
  ids: readonly string[],
) => Promise<ReadonlyMap<string, TeamPerson>>;
const token = () => randomBytes(32).toString('base64url');
const hashOf = (value: string) => createHash('sha256').update(value).digest();
export const scopeOf = (invocation: Invocation): 'agency' | 'business' =>
  invocation.context.businessId === undefined ? 'agency' : 'business';
export const workspace = (invocation: Invocation): string | null =>
  invocation.context.businessId ?? null;
const invitationIn = (trx: DatabaseTransaction, invocation: Invocation, id: string) =>
  trx
    .selectFrom('tenancy.invitations')
    .selectAll()
    .where('id', '=', parsePublicId('invitation', id) ?? '')
    .where(
      'business_id',
      invocation.context.businessId === undefined ? 'is' : '=',
      workspace(invocation),
    );
export type InvitationRow = Selectable<DB['tenancy.invitations']>;
async function asInvitation(trx: DatabaseTransaction, row: InvitationRow): Promise<TeamInvitation> {
  const role = await trx
    .selectFrom('tenancy.roles')
    .select('name')
    .where('id', '=', row.role_id)
    .executeTakeFirstOrThrow();
  return invitationDetails(row, role.name);
}
function invitationDetails(row: InvitationRow, roleName: string): TeamInvitation {
  return {
    id: toPublicId('invitation', row.id),
    email: row.email,
    roleId: toPublicId('role', row.role_id),
    roleName,
    expiresAt: row.expires_at.toISOString(),
    status:
      row.accepted_at !== null
        ? 'accepted'
        : row.revoked_at !== null
          ? 'revoked'
          : row.expires_at <= new Date()
            ? 'expired'
            : 'pending',
  };
}
const duplicate = explainUniqueViolation({
  invitations_one_pending_idx: () =>
    new ConflictError(
      'A pending invitation already exists for this email. Resend or revoke it first.',
    ),
});

/**
 * Invites someone to the workspace's team. Someone already on it is refused: accepting
 * would keep their role, so the invitation's role would be lost without a word.
 */
export function inviteCommand(
  people: TeamPeople,
): Command<typeof inviteMemberInput, { invitation: TeamInvitation; token: string }> {
  return defineCommand({
    name: 'team.invite',
    permission: 'team.manage',
    input: inviteMemberInput,
    handle: (trx, input, command) => createInvitation(trx, command, people, input, {}),
  });
}

/**
 * Writes the invitation every way of adding someone goes through: the bare invitation, and
 * Settings → Users' "Add user", whose details ride on it as its profile.
 */
export async function createInvitation(
  trx: DatabaseTransaction,
  command: CommandContext,
  people: TeamPeople,
  input: { readonly email: string; readonly roleId: string },
  profile: Readonly<Record<string, unknown>>,
): Promise<{ invitation: TeamInvitation; token: string; row: InvitationRow }> {
  const members = await trx
    .selectFrom('tenancy.memberships')
    .select('user_id')
    .where('business_id', command.context.businessId === undefined ? 'is' : '=', workspace(command))
    .execute();
  const team = await people(
    trx,
    members.map((member) => member.user_id),
  );
  if ([...team.values()].some((person) => person.email.toLowerCase() === input.email)) {
    throw new ConflictError(
      `${input.email} is already on the team. Remove them first to invite them with another role.`,
    );
  }
  const role = await trx
    .selectFrom('tenancy.roles')
    .select(['id', 'key', 'is_builtin'])
    .where('id', '=', parsePublicId('role', input.roleId) ?? '')
    .where('scope', '=', scopeOf(command))
    .executeTakeFirst();
  if (role === undefined) throw new NotFoundError('Role', input.roleId);
  if (role.is_builtin && role.key === 'owner')
    throw new ForbiddenError('Ownership is assigned separately. Choose another role.');
  const secret = token();
  const row = await trx
    .insertInto('tenancy.invitations')
    .values({
      agency_id: command.context.agencyId,
      business_id: workspace(command),
      role_id: role.id,
      email: input.email,
      token_hash: hashOf(secret),
      invited_by_user_id: command.context.userId ?? null,
      expires_at: sql<Date>`now() + interval '7 days'`,
      profile: JSON.stringify(profile),
    })
    .returningAll()
    .executeTakeFirstOrThrow()
    .catch(duplicate);
  await command.emit({
    type: 'team.invited',
    subject: { kind: 'invitation', id: row.id },
    payload: { email: row.email, roleId: row.role_id },
  });
  return { invitation: await asInvitation(trx, row), token: secret, row };
}

export const resendInvitationCommand = defineCommand({
  name: 'team.resend_invitation',
  permission: 'team.manage',
  input: invitationIdInput,
  async handle(trx, input, command) {
    const link = await invitationIn(trx, command, input.id).forUpdate().executeTakeFirst();
    if (link === undefined) throw new NotFoundError('Invitation', input.id);
    if (link.accepted_at !== null || link.revoked_at !== null)
      throw new ConflictError('Only a pending or expired invitation can be resent.');
    const secret = token();
    const row = await trx
      .updateTable('tenancy.invitations')
      .set({ token_hash: hashOf(secret), expires_at: sql<Date>`now() + interval '7 days'` })
      .where('id', '=', link.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await command.emit({
      type: 'team.invitation_resent',
      subject: { kind: 'invitation', id: row.id },
    });
    return { invitation: await asInvitation(trx, row), token: secret };
  },
});

export const revokeInvitationCommand = defineCommand({
  name: 'team.revoke_invitation',
  permission: 'team.manage',
  input: invitationIdInput,
  async handle(trx, input, command) {
    const link = await invitationIn(trx, command, input.id).forUpdate().executeTakeFirst();
    if (link === undefined) throw new NotFoundError('Invitation', input.id);
    if (link.accepted_at !== null)
      throw new ConflictError('This invitation was accepted. Remove the membership instead.');
    await trx
      .updateTable('tenancy.invitations')
      .set({ revoked_at: sql<Date>`now()` })
      .where('id', '=', link.id)
      .execute();
    await command.emit({
      type: 'team.invitation_revoked',
      subject: { kind: 'invitation', id: link.id },
    });
    return undefined;
  },
});

export const removeMemberCommand = defineCommand({
  name: 'team.remove_member',
  permission: 'team.manage',
  input: membershipIdInput,
  async handle(trx, input, command) {
    const member = await trx
      .selectFrom('tenancy.memberships as m')
      .innerJoin('tenancy.roles as r', 'r.id', 'm.role_id')
      .select(['m.id', 'm.user_id', 'r.key', 'r.is_builtin'])
      .where('m.id', '=', parsePublicId('membership', input.id) ?? '')
      .where(
        'm.business_id',
        command.context.businessId === undefined ? 'is' : '=',
        workspace(command),
      )
      .forUpdate('m')
      .executeTakeFirst();
    if (member === undefined) throw new NotFoundError('Membership', input.id);
    if (member.user_id === command.context.userId)
      throw new ForbiddenError("You can't remove yourself.");
    if (member.is_builtin && member.key === 'owner')
      throw new ForbiddenError('Transfer ownership before removing an owner.');
    await trx.deleteFrom('tenancy.memberships').where('id', '=', member.id).execute();
    await command.emit({
      type: 'team.member_removed',
      subject: { kind: 'membership', id: member.id },
      payload: { userId: member.user_id },
    });
    return undefined;
  },
});

/** Exact workspace filters matter: scoped RLS also makes agency-wide rows visible. */
export function readTeam(
  services: Services,
  invocation: Invocation,
  people: TeamPeople,
): Promise<Team> {
  return withTenant(services.db, invocation.context, async (trx) => {
    const scope = scopeOf(invocation);
    const roles = await trx
      .selectFrom('tenancy.roles')
      .selectAll()
      .where('scope', '=', scope)
      .orderBy('name')
      .execute();
    const members = await trx
      .selectFrom('tenancy.memberships')
      .selectAll()
      .where(
        'business_id',
        invocation.context.businessId === undefined ? 'is' : '=',
        workspace(invocation),
      )
      .orderBy('created_at')
      .execute();
    const invitations = await trx
      .selectFrom('tenancy.invitations')
      .selectAll()
      .where(
        'business_id',
        invocation.context.businessId === undefined ? 'is' : '=',
        workspace(invocation),
      )
      .orderBy('created_at', 'desc')
      .execute();
    const names = await people(
      trx,
      members.map((each) => each.user_id),
    );
    return {
      roles: roles.map((row) => ({
        id: toPublicId('role', row.id),
        name: row.name,
        key: row.key,
        isBuiltin: row.is_builtin,
        permissions: [
          ...permissionsOf(
            { scope, key: row.key, isBuiltin: row.is_builtin, permissions: row.permissions },
            scope,
          ),
        ],
      })),
      members: members.map((row) => {
        const role = roles.find((each) => each.id === row.role_id);
        if (role === undefined) throw new Error('Membership role is missing.');
        const person = names.get(row.user_id);
        return {
          id: toPublicId('membership', row.id),
          name: person?.name ?? 'Unknown person',
          email: person?.email ?? '',
          roleId: toPublicId('role', row.role_id),
          roleName: role.name,
          isSelf: row.user_id === invocation.context.userId,
          isOwner: role.is_builtin && role.key === 'owner',
        };
      }),
      invitations: invitations.map((row) => {
        const role = roles.find((each) => each.id === row.role_id);
        if (role === undefined) throw new Error('Invitation role is missing.');
        return invitationDetails(row, role.name);
      }),
      canManage: invocation.permissions === 'all' || invocation.permissions.has('team.manage'),
    };
  });
}
