import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  addUser,
  getUser,
  listUsers,
  parseInput,
  updateUser,
  updateUserInput,
} from '@repo/contracts';
import { ForbiddenError } from '@repo/kernel';

import type { TeamPeople } from '../team/team.js';
import {
  addUserCommand,
  readUser,
  readUsers,
  updateUserCommand,
  type CheckAvatar,
} from './users.js';

/** Settings → Users. Removing someone and an invitation's own actions stay the team's. */
export function userRoutes(options: {
  readonly people: TeamPeople;
  readonly checkAvatar: CheckAvatar;
  readonly sendInvitation: ((email: string, token: string) => Promise<boolean>) | undefined;
}): ApiRoute[] {
  const send = options.sendInvitation;
  const addPerson = addUserCommand(options.people, options.checkAvatar);
  const updatePerson = updateUserCommand(options.people, options.checkAvatar);
  const list = {
    endpoint: listUsers,
    run: ({ invocation, query }, services) =>
      readUsers(services, invocation, options.people, parseInput(listUsers.query, query)),
  } satisfies Route<typeof listUsers>;
  const add = {
    endpoint: addUser,
    command: addPerson,
    async run({ invocation, body }, services) {
      if (send === undefined)
        throw new ForbiddenError('Email delivery must be configured before adding people.');
      const result = await runCommand(services, addPerson, body, invocation);
      return {
        ...result.user,
        deliveryFailed: !(await send(result.user.email, result.token)),
      };
    },
  } satisfies Route<typeof addUser>;
  const read = {
    endpoint: getUser,
    run: ({ invocation, params }, services) =>
      readUser(services, invocation, options.people, parseInput(getUser.params, params).userId),
  } satisfies Route<typeof getUser>;
  const update = {
    endpoint: updateUser,
    command: updatePerson,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        updatePerson,
        {
          userId: parseInput(updateUser.params, params).userId,
          details: parseInput(updateUserInput, body),
        },
        invocation,
      ),
  } satisfies Route<typeof updateUser>;
  return [list, add, read, update];
}
