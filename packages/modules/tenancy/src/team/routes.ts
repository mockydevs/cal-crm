import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  listTeam,
  inviteMember,
  resendInvitation,
  revokeInvitation,
  removeTeamMember,
  parseInput,
} from '@repo/contracts';
import { ForbiddenError } from '@repo/kernel';
import {
  inviteCommand,
  resendInvitationCommand,
  revokeInvitationCommand,
  removeMemberCommand,
  readTeam,
  type TeamPeople,
} from './team.js';

export function teamRoutes(options: {
  readonly people: TeamPeople;
  readonly sendInvitation: ((email: string, token: string) => Promise<boolean>) | undefined;
}): ApiRoute[] {
  const send = options.sendInvitation;
  const invitePerson = inviteCommand(options.people);
  const list = {
    endpoint: listTeam,
    run: ({ invocation }, services) => readTeam(services, invocation, options.people),
  } satisfies Route<typeof listTeam>;
  const invite = {
    endpoint: inviteMember,
    command: invitePerson,
    async run({ invocation, body }, services) {
      if (send === undefined)
        throw new ForbiddenError('Email delivery must be configured before inviting people.');
      const result = await runCommand(services, invitePerson, body, invocation);
      return {
        ...result.invitation,
        deliveryFailed: !(await send(result.invitation.email, result.token)),
      };
    },
  } satisfies Route<typeof inviteMember>;
  const resend = {
    endpoint: resendInvitation,
    command: resendInvitationCommand,
    async run({ invocation, params }, services) {
      if (send === undefined)
        throw new ForbiddenError('Email delivery must be configured before resending invitations.');
      const result = await runCommand(
        services,
        resendInvitationCommand,
        parseInput(resendInvitation.params, params),
        invocation,
      );
      return {
        ...result.invitation,
        deliveryFailed: !(await send(result.invitation.email, result.token)),
      };
    },
  } satisfies Route<typeof resendInvitation>;
  const revoke = {
    endpoint: revokeInvitation,
    command: revokeInvitationCommand,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        revokeInvitationCommand,
        parseInput(revokeInvitation.params, params),
        invocation,
      ),
  } satisfies Route<typeof revokeInvitation>;
  const remove = {
    endpoint: removeTeamMember,
    command: removeMemberCommand,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        removeMemberCommand,
        parseInput(removeTeamMember.params, params),
        invocation,
      ),
  } satisfies Route<typeof removeTeamMember>;
  return [list, invite, resend, revoke, remove];
}
