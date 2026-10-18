// The opportunity dialog's own routes: one read of who a deal is with and whose it is, a
// command for each change, and a contact's deals. The server passes the lookups of the
// modules that own the team and people's names (details.ts).
import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  addDealFollowers,
  assignContactOwnerInput,
  assignDealOwner,
  bulkUpdateDeals,
  contactFollowersInput,
  getDealDetails,
  listContactDeals,
  listDealBulkActions,
  parseInput,
  removeDealFollowers,
  setDealContacts,
  setDealContactsInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import { bulkDealsCommand, readDealBulkActions } from './bulk.js';
import { readContactDealList } from './contact-deals.js';
import { setDealContactsCommand } from './contacts.js';
import { readDealDetails, type DealPeopleOptions } from './details.js';
import {
  addDealFollowersCommand,
  assignDealOwnerCommand,
  removeDealFollowersCommand,
} from './people.js';

export function dealPeopleRoutes(options: DealPeopleOptions): readonly ApiRoute[] {
  const assignOwner = assignDealOwnerCommand(options);
  const addFollowers = addDealFollowersCommand(options);
  const removeFollowers = removeDealFollowersCommand(options);
  const setContacts = setDealContactsCommand(options);

  const read = {
    endpoint: getDealDetails,
    run: ({ invocation, params }, { db }) => {
      const { id } = parseInput(getDealDetails.params, params);
      return withTenant(db, invocation.context, (trx) =>
        readDealDetails(trx, invocation, id, options),
      );
    },
  } satisfies Route<typeof getDealDetails>;

  // Each body is checked as the API documents it, so its issues point into the body as the
  // caller sent it; the id comes from the path.
  const owner = {
    endpoint: assignDealOwner,
    command: assignOwner,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        assignOwner,
        {
          ...parseInput(assignContactOwnerInput, body),
          ...parseInput(assignDealOwner.params, params),
        },
        invocation,
      ),
  } satisfies Route<typeof assignDealOwner>;

  const follow = {
    endpoint: addDealFollowers,
    command: addFollowers,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        addFollowers,
        {
          ...parseInput(contactFollowersInput, body),
          ...parseInput(addDealFollowers.params, params),
        },
        invocation,
      ),
  } satisfies Route<typeof addDealFollowers>;

  const unfollow = {
    endpoint: removeDealFollowers,
    command: removeFollowers,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        removeFollowers,
        {
          ...parseInput(contactFollowersInput, body),
          ...parseInput(removeDealFollowers.params, params),
        },
        invocation,
      ),
  } satisfies Route<typeof removeDealFollowers>;

  const contacts = {
    endpoint: setDealContacts,
    command: setContacts,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        setContacts,
        {
          ...parseInput(setDealContactsInput, body),
          ...parseInput(setDealContacts.params, params),
        },
        invocation,
      ),
  } satisfies Route<typeof setDealContacts>;

  const contactDeals = {
    endpoint: listContactDeals,
    run: ({ invocation, params, query }, { db }) => {
      const { id } = parseInput(listContactDeals.params, params);
      return withTenant(db, invocation.context, (trx) =>
        readContactDealList(trx, invocation, id, parseInput(listContactDeals.query, query)),
      );
    },
  } satisfies Route<typeof listContactDeals>;

  // One change to many deals at once, and the list of those that were run.
  const bulkCommand = bulkDealsCommand(options);
  const bulk = {
    endpoint: bulkUpdateDeals,
    command: bulkCommand,
    run: ({ invocation, body }, services) => runCommand(services, bulkCommand, body, invocation),
  } satisfies Route<typeof bulkUpdateDeals>;

  const bulkActions = {
    endpoint: listDealBulkActions,
    run: ({ invocation, query }, { db }) =>
      withTenant(db, invocation.context, (trx) =>
        readDealBulkActions(trx, invocation, parseInput(listDealBulkActions.query, query), options),
      ),
  } satisfies Route<typeof listDealBulkActions>;

  return [read, owner, follow, unfollow, contacts, contactDeals, bulk, bulkActions];
}
