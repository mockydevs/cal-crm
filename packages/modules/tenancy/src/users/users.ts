// Settings → Users: the people of a workspace as one list, and what the agency keeps about
// each. A person's sign-in account is auth's and is never written here; their details are
// the agency's (tenancy.user_profiles), and their role and default calendar are on their
// membership. Adding a person is an invitation that carries the details, which become the
// profile when it is accepted.
import { defineCommand, type Command, type Invocation, type Services } from '@repo/commands';
import {
  addUserInput,
  noteDocument,
  permissionsOf,
  updateUserInput,
  type ListUsersQuery,
  type NoteDocument,
  type User,
  type UserDetail,
  type UserList,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import {
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import {
  createInvitation,
  scopeOf,
  workspace,
  type InvitationRow,
  type TeamPeople,
} from '../team/team.js';

/** Refuses a file that cannot be a person's picture; the files module knows what a file is. */
export type CheckAvatar = (
  trx: DatabaseTransaction,
  agencyId: string,
  fileId: string,
) => Promise<void>;

interface ProfileRow {
  readonly user_id: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly phone_e164: string | null;
  readonly phone_extension: string | null;
  readonly avatar_file_id: string | null;
  readonly signature: unknown;
  readonly signature_enabled: boolean;
}
interface RoleRow {
  readonly id: string;
  readonly scope: string;
  readonly key: string;
  readonly name: string;
  readonly is_builtin: boolean;
  readonly permissions: readonly string[];
}
interface MembershipRow {
  readonly id: string;
  readonly user_id: string;
  readonly business_id: string | null;
  readonly role_id: string;
  readonly default_calendar_id: string | null;
}

// What an invitation carries of a person, as createInvitation stores it (stored ids).
const invitedProfile = z.looseObject({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phone: z.string().nullable().optional(),
  extension: z.string().nullable().optional(),
  avatarFileId: z.string().nullable().optional(),
  calendarId: z.string().nullable().optional(),
  signature: z.unknown().optional(),
  signatureEnabled: z.boolean().optional(),
});

const isOwnerRole = (role: RoleRow) => role.is_builtin && role.key === 'owner';
const canManage = (invocation: Invocation) =>
  invocation.permissions === 'all' || invocation.permissions.has('team.manage');

// A name kept in one piece, in two: the last word is the last name.
function splitName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  const at = trimmed.lastIndexOf(' ');
  return at === -1
    ? { firstName: trimmed, lastName: '' }
    : { firstName: trimmed.slice(0, at).trim(), lastName: trimmed.slice(at + 1) };
}

const signatureOf = (value: unknown): NoteDocument | null => {
  const parsed = noteDocument.safeParse(value);
  return parsed.success ? parsed.data : null;
};

interface Everyone {
  readonly roles: readonly RoleRow[];
  /** Every person of the workspace, in name order. */
  readonly people: readonly UserDetail[];
}

/**
 * Everyone the workspace's list shows: its members, in a business the agency's own team too,
 * and the people invited who have not joined. A team is tens of people, so it is read whole
 * and searched, filtered and paged from that.
 */
async function readEveryone(
  trx: DatabaseTransaction,
  invocation: Invocation,
  people: TeamPeople,
): Promise<Everyone> {
  const businessId = workspace(invocation);
  const manage = canManage(invocation);
  const roles = (
    await sql<RoleRow>`
      select id, scope, key, name, is_builtin, permissions from tenancy.roles order by name
    `.execute(trx)
  ).rows;
  const roleOf = (id: string): RoleRow => {
    const role = roles.find((each) => each.id === id);
    if (role === undefined) throw new Error('A membership names a role that is missing.');
    return role;
  };
  // Row-level security already keeps this to the agency, and inside a business to the
  // business's own memberships and the agency's (those with no business).
  const memberships = (
    await sql<MembershipRow>`
      select id, user_id, business_id, role_id, default_calendar_id
      from tenancy.memberships
      where business_id is null or business_id = ${businessId}
      order by id
    `.execute(trx)
  ).rows.filter((row) => businessId !== null || row.business_id === null);
  const invitations = await trx
    .selectFrom('tenancy.invitations')
    .selectAll()
    .where('business_id', businessId === null ? 'is' : '=', businessId)
    .where('accepted_at', 'is', null)
    .where('revoked_at', 'is', null)
    .orderBy('id')
    .execute();
  const userIds = memberships.map((row) => row.user_id);
  const accounts = await people(trx, userIds);
  const profiles = new Map(
    userIds.length === 0
      ? []
      : (
          await sql<ProfileRow>`
            select user_id, first_name, last_name, phone_e164, phone_extension, avatar_file_id,
                   signature, signature_enabled
            from tenancy.user_profiles where user_id = any(${userIds}::uuid[])
          `.execute(trx)
        ).rows.map((row) => [row.user_id, row]),
  );
  const callerOwns = memberships.some(
    (row) =>
      row.user_id === invocation.context.userId &&
      row.business_id === businessId &&
      isOwnerRole(roleOf(row.role_id)),
  );

  const members = memberships.map((row): UserDetail => {
    const role = roleOf(row.role_id);
    const account = accounts.get(row.user_id);
    const profile = profiles.get(row.user_id);
    const named =
      profile !== undefined && `${profile.first_name}${profile.last_name}`.trim() !== ''
        ? { firstName: profile.first_name, lastName: profile.last_name }
        : splitName(account?.name ?? '');
    const avatar = profile?.avatar_file_id;
    const here = row.business_id === businessId;
    const isSelf = row.user_id === invocation.context.userId;
    const isOwner = isOwnerRole(role);
    const id = toPublicId('membership', row.id);
    return {
      id,
      membershipId: id,
      invitationId: null,
      status: 'active',
      ...named,
      name: `${named.firstName} ${named.lastName}`.trim() || (account?.email ?? 'Unknown person'),
      email: account?.email ?? '',
      phone: profile?.phone_e164 ?? null,
      extension: profile?.phone_extension ?? null,
      avatarFileId: typeof avatar === 'string' ? toPublicId('file', avatar) : null,
      userType: row.business_id === null ? 'agency' : 'account',
      roleId: toPublicId('role', role.id),
      roleKey: role.key,
      roleName: role.name,
      isSelf,
      isOwner,
      // The agency's own team is managed at the agency, and an owner by an owner.
      canEdit: manage && here && (!isOwner || isSelf || callerOwns),
      canRemove: manage && here && !isSelf && !isOwner,
      calendarId:
        row.default_calendar_id === null ? null : toPublicId('calendar', row.default_calendar_id),
      signature: {
        enabled: profile?.signature_enabled ?? false,
        document: signatureOf(profile?.signature),
      },
    };
  });
  const invited = invitations.map((row): UserDetail =>
    invitedPerson(row, roleOf(row.role_id), manage),
  );
  const everyone = [...members, ...invited].toSorted(
    (left, right) =>
      left.name.toLowerCase().localeCompare(right.name.toLowerCase(), 'en') ||
      left.id.localeCompare(right.id),
  );
  return { roles, people: everyone };
}

function invitedPerson(row: InvitationRow, role: RoleRow, manage: boolean): UserDetail {
  const parsed = invitedProfile.safeParse(row.profile);
  const profile = parsed.success ? parsed.data : {};
  const firstName = profile.firstName ?? '';
  const lastName = profile.lastName ?? '';
  const id = toPublicId('invitation', row.id);
  return {
    id,
    membershipId: null,
    invitationId: id,
    status: row.expires_at <= new Date() ? 'invitation_expired' : 'invited',
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim() || row.email,
    email: row.email,
    phone: profile.phone ?? null,
    extension: profile.extension ?? null,
    avatarFileId:
      typeof profile.avatarFileId === 'string' ? toPublicId('file', profile.avatarFileId) : null,
    userType: row.business_id === null ? 'agency' : 'account',
    roleId: toPublicId('role', role.id),
    roleKey: role.key,
    roleName: role.name,
    isSelf: false,
    isOwner: false,
    // An invitation is not edited: it is revoked and sent again.
    canEdit: false,
    canRemove: manage,
    calendarId:
      typeof profile.calendarId === 'string' ? toPublicId('calendar', profile.calendarId) : null,
    signature: {
      enabled: profile.signatureEnabled ?? false,
      document: signatureOf(profile.signature),
    },
  };
}

const digits = (text: string) => text.replace(/\D/g, '');

function matches(person: User, query: ListUsersQuery): boolean {
  if (query.role !== undefined && person.roleId !== query.role) return false;
  if (query.type !== undefined && person.userType !== query.type) return false;
  if (query.q === undefined || query.q === '') return true;
  const wanted = query.q.toLowerCase();
  const number = digits(query.q);
  return (
    person.name.toLowerCase().includes(wanted) ||
    person.email.toLowerCase().includes(wanted) ||
    person.id.toLowerCase().includes(wanted) ||
    (number.length >= 3 && person.phone !== null && digits(person.phone).includes(number))
  );
}

const cursorOf = (person: User) => Buffer.from(person.id, 'utf8').toString('base64url');

/** A page of the workspace's people in name order, with the roles one of them can be given. */
export function readUsers(
  services: Services,
  invocation: Invocation,
  people: TeamPeople,
  query: ListUsersQuery,
): Promise<UserList> {
  return withTenant(services.db, invocation.context, async (trx) => {
    const everyone = await readEveryone(trx, invocation, people);
    const found = everyone.people.filter((person) => matches(person, query));
    // The page begins after the person the cursor names; one who has since left starts over.
    const after =
      query.after === undefined
        ? -1
        : found.findIndex((person) => cursorOf(person) === query.after);
    const page = found.slice(after + 1, after + 1 + query.limit);
    const last = page.at(-1);
    const scope = scopeOf(invocation);
    return {
      items: page.map(({ calendarId: _calendar, signature: _signature, ...person }) => person),
      total: found.length,
      next: last !== undefined && after + 1 + query.limit < found.length ? cursorOf(last) : null,
      roles: everyone.roles
        .filter((role) => role.scope === scope)
        .map((role) => ({
          id: toPublicId('role', role.id),
          name: role.name,
          key: role.key,
          isBuiltin: role.is_builtin,
          permissions: [
            ...permissionsOf(
              {
                scope,
                key: role.key,
                isBuiltin: role.is_builtin,
                permissions: [...role.permissions],
              },
              scope,
            ),
          ],
        })),
      canManage: canManage(invocation),
    };
  });
}

async function memberIn(
  trx: DatabaseTransaction,
  invocation: Invocation,
  people: TeamPeople,
  userId: string,
): Promise<UserDetail> {
  const everyone = await readEveryone(trx, invocation, people);
  const person = everyone.people.find((each) => each.membershipId === userId);
  if (person === undefined) throw new NotFoundError('User', userId);
  return person;
}

/** One person of the workspace, with their signature and default calendar. */
export function readUser(
  services: Services,
  invocation: Invocation,
  people: TeamPeople,
  userId: string,
): Promise<UserDetail> {
  return withTenant(services.db, invocation.context, (trx) =>
    memberIn(trx, invocation, people, userId),
  );
}

async function checkCalendar(
  trx: DatabaseTransaction,
  invocation: Invocation,
  calendarId: string | null,
): Promise<string | null> {
  if (calendarId === null) return null;
  const businessId = workspace(invocation);
  const stored = parsePublicId('calendar', calendarId);
  const found =
    businessId === null || stored === undefined
      ? undefined
      : await trx
          .selectFrom('calendar.calendars')
          .select('id')
          .where('id', '=', stored)
          .where('business_id', '=', businessId)
          .executeTakeFirst();
  if (found === undefined)
    throw new ValidationError([
      {
        path: '/calendarId',
        code: 'unknown_calendar',
        message:
          businessId === null
            ? 'A default calendar belongs to a business. Set it in the business.'
            : 'Choose one of this business’s calendars.',
      },
    ]);
  return found.id;
}

async function roleFor(
  trx: DatabaseTransaction,
  invocation: Invocation,
  roleId: string,
): Promise<RoleRow> {
  const { rows } = await sql<RoleRow>`
    select id, scope, key, name, is_builtin, permissions from tenancy.roles
    where id = ${parsePublicId('role', roleId) ?? null}::uuid and scope = ${scopeOf(invocation)}
  `.execute(trx);
  const [role] = rows;
  // A role named in the body is a choice, not the thing asked for: an unknown one is a
  // mistake in what was sent.
  if (role === undefined)
    throw new ValidationError([
      { path: '/roleId', code: 'unknown_role', message: 'Choose one of this workspace’s roles.' },
    ]);
  return role;
}

/**
 * Adds a person: an invitation that carries their details. Refusals are the invitation's
 * own (already on the team, the owner role, a pending invitation for the address).
 */
export function addUserCommand(
  people: TeamPeople,
  checkAvatar: CheckAvatar,
): Command<typeof addUserInput, { user: UserDetail; token: string }> {
  return defineCommand({
    name: 'team.add_user',
    permission: 'team.manage',
    input: addUserInput,
    audit: ({ email, roleId }) => ({ email, roleId }),
    async handle(trx, input, command) {
      const calendarId = await checkCalendar(trx, command, input.calendarId);
      if (input.avatarFileId !== null)
        await checkAvatar(trx, command.context.agencyId, input.avatarFileId);
      const role = await roleFor(trx, command, input.roleId);
      const created = await createInvitation(trx, command, people, input, {
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        extension: input.extension,
        avatarFileId:
          input.avatarFileId === null ? null : (parsePublicId('file', input.avatarFileId) ?? null),
        calendarId,
        signature: input.signature.document,
        signatureEnabled: input.signature.enabled,
      });
      return { user: invitedPerson(created.row, role, true), token: created.token };
    },
  });
}

const updateInput = z.strictObject({ userId: z.string(), details: updateUserInput });

/**
 * Changes a person's details, role and default calendar. Only a member of this very
 * workspace: the agency's own team is changed at the agency. An owner's role stays, as
 * does one's own, so nobody removes the last way in by mistake.
 */
export function updateUserCommand(
  people: TeamPeople,
  checkAvatar: CheckAvatar,
): Command<typeof updateInput, UserDetail> {
  return defineCommand({
    name: 'team.update_user',
    permission: 'team.manage',
    input: updateInput,
    audit: ({ userId, details }) => ({ userId, roleId: details.roleId }),
    async handle(trx, { userId, details: input }, command) {
      const businessId = workspace(command);
      const membershipId = parsePublicId('membership', userId);
      const { rows } = await sql<MembershipRow>`
        select id, user_id, business_id, role_id, default_calendar_id
        from tenancy.memberships
        where id = ${membershipId ?? null}::uuid
          and business_id is not distinct from ${businessId}::uuid
        for update
      `.execute(trx);
      const [membership] = rows;
      if (membership === undefined) {
        // Someone of the agency's own team, seen from a business, is real but not changed here.
        const seen = await memberIn(trx, command, people, userId);
        throw new ForbiddenError(
          `${seen.name} is on the agency's team. Change them in the agency's Users.`,
        );
      }
      const before = await memberIn(trx, command, people, userId);
      if (!before.canEdit) throw new ForbiddenError('Only an owner changes an owner.');
      const role = await roleFor(trx, command, input.roleId);
      if (role.id !== membership.role_id) {
        if (before.isOwner || isOwnerRole(role))
          throw new ForbiddenError('Ownership is assigned separately. Choose another role.');
        if (before.isSelf) throw new ForbiddenError("You can't change your own role.");
      }
      const calendarId = await checkCalendar(trx, command, input.calendarId);
      if (input.avatarFileId !== null && input.avatarFileId !== before.avatarFileId)
        await checkAvatar(trx, command.context.agencyId, input.avatarFileId);
      const avatar =
        input.avatarFileId === null ? null : (parsePublicId('file', input.avatarFileId) ?? null);
      const signature =
        input.signature.document === null ? null : JSON.stringify(input.signature.document);
      await sql`
        insert into tenancy.user_profiles
          (agency_id, user_id, first_name, last_name, phone_e164, phone_extension,
           avatar_file_id, signature, signature_enabled)
        values (${command.context.agencyId}, ${membership.user_id}, ${input.firstName},
          ${input.lastName}, ${input.phone}, ${input.extension}, ${avatar}::uuid,
          ${signature}::jsonb, ${input.signature.enabled})
        on conflict (agency_id, user_id) do update set
          first_name = excluded.first_name, last_name = excluded.last_name,
          phone_e164 = excluded.phone_e164, phone_extension = excluded.phone_extension,
          avatar_file_id = excluded.avatar_file_id, signature = excluded.signature,
          signature_enabled = excluded.signature_enabled
      `.execute(trx);
      await sql`
        update tenancy.memberships
        set role_id = ${role.id}, default_calendar_id = ${calendarId}::uuid
        where id = ${membership.id}
      `.execute(trx);
      await command.emit({
        type: 'team.user_updated',
        subject: { kind: 'membership', id: membership.id },
        payload: {
          userId: membership.user_id,
          ...(role.id === membership.role_id ? {} : { roleId: role.id }),
        },
      });
      return memberIn(trx, command, people, userId);
    },
  });
}
