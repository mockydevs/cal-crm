// The contact page's own routes: one read, and a command for each change. The server passes
// the lookups of the modules that own the team, people's names and sending (details.ts).
import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  addContactAddress,
  addContactAddressInput,
  addContactFollowers,
  assignContactOwner,
  assignContactOwnerInput,
  contactFollowersInput,
  getContactAttribution,
  getContactDetails,
  parseInput,
  removeContactAddress,
  removeContactAddressInput,
  removeContactFollowers,
  setContactDnd,
  setContactDndInput,
  updateContactAddress,
  updateContactAddressInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import {
  addContactAddressCommand,
  removeContactAddressCommand,
  updateContactAddressCommand,
} from './addresses.js';
import { readContactAttribution } from '../attribution/touches.js';
import { readContactDetails, type ContactDetailOptions } from './details.js';
import { setContactDndCommand } from './dnd.js';
import {
  addContactFollowersCommand,
  assignContactOwnerCommand,
  removeContactFollowersCommand,
} from './people.js';

export function contactDetailRoutes(options: ContactDetailOptions): readonly ApiRoute[] {
  const assignOwner = assignContactOwnerCommand(options);
  const addFollowers = addContactFollowersCommand(options);
  const removeFollowers = removeContactFollowersCommand(options);
  const addAddress = addContactAddressCommand(options);
  const updateAddress = updateContactAddressCommand(options);
  const removeAddress = removeContactAddressCommand(options);
  const setDnd = setContactDndCommand(options);

  const read = {
    endpoint: getContactDetails,
    run: ({ invocation, params }, { db }) => {
      const { id } = parseInput(getContactDetails.params, params);
      return withTenant(db, invocation.context, (trx) =>
        readContactDetails(trx, invocation, id, options),
      );
    },
  } satisfies Route<typeof getContactDetails>;

  // Each body is checked as the API documents it, so its issues point into the body as the
  // caller sent it; the ids come from the path.
  const owner = {
    endpoint: assignContactOwner,
    command: assignOwner,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        assignOwner,
        {
          ...parseInput(assignContactOwnerInput, body),
          ...parseInput(assignContactOwner.params, params),
        },
        invocation,
      ),
  } satisfies Route<typeof assignContactOwner>;

  const follow = {
    endpoint: addContactFollowers,
    command: addFollowers,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        addFollowers,
        {
          ...parseInput(contactFollowersInput, body),
          ...parseInput(addContactFollowers.params, params),
        },
        invocation,
      ),
  } satisfies Route<typeof addContactFollowers>;

  const unfollow = {
    endpoint: removeContactFollowers,
    command: removeFollowers,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        removeFollowers,
        {
          ...parseInput(contactFollowersInput, body),
          ...parseInput(removeContactFollowers.params, params),
        },
        invocation,
      ),
  } satisfies Route<typeof removeContactFollowers>;

  // A contact's addresses, one at a time (addresses.ts).
  const add = {
    endpoint: addContactAddress,
    command: addAddress,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        addAddress,
        {
          ...parseInput(addContactAddressInput, body),
          ...parseInput(addContactAddress.params, params),
        },
        invocation,
      ),
  } satisfies Route<typeof addContactAddress>;

  const change = {
    endpoint: updateContactAddress,
    command: updateAddress,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        updateAddress,
        {
          ...parseInput(updateContactAddressInput, body),
          ...parseInput(updateContactAddress.params, params),
        },
        invocation,
      ),
  } satisfies Route<typeof updateContactAddress>;

  const remove = {
    endpoint: removeContactAddress,
    command: removeAddress,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        removeAddress,
        {
          ...parseInput(removeContactAddressInput, body),
          ...parseInput(removeContactAddress.params, params),
        },
        invocation,
      ),
  } satisfies Route<typeof removeContactAddress>;

  // Do not disturb, for every channel or for some (dnd.ts).
  const dnd = {
    endpoint: setContactDnd,
    command: setDnd,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        setDnd,
        { ...parseInput(setContactDndInput, body), ...parseInput(setContactDnd.params, params) },
        invocation,
      ),
  } satisfies Route<typeof setContactDnd>;

  // Where the contact first and last came from, for the page's Attribution section.
  const attribution = {
    endpoint: getContactAttribution,
    run: ({ invocation, params }, { db }) => {
      const { id } = parseInput(getContactAttribution.params, params);
      return withTenant(db, invocation.context, (trx) =>
        readContactAttribution(trx, invocation, id),
      );
    },
  } satisfies Route<typeof getContactAttribution>;

  return [read, attribution, owner, follow, unfollow, add, change, remove, dnd];
}
