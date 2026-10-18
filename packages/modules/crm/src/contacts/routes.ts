import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  countContacts,
  createContact,
  getContact,
  getContactNeighbours,
  listContacts,
  listTimeZones,
  parseInput,
  restoreContact,
  trashContact,
  updateContact,
  updateContactInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import {
  createContactCommand,
  readContact,
  restoreContactCommand,
  trashContactCommand,
  updateContactCommand,
} from './contacts.js';
import { readTimeZones } from './contact-settings.js';
import { readContactCount } from './count.js';
import type { FilterPeople } from './filters.js';
import { readContactNeighbours } from './neighbours.js';
import { readContactList } from './list.js';

// `people` says who a membership id names, for a filter by owner.
const list = (people?: FilterPeople) =>
  ({
    endpoint: listContacts,
    run: ({ invocation, query }, { db }) => {
      const parsed = parseInput(listContacts.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readContactList(trx, invocation, parsed, people),
      );
    },
  }) satisfies Route<typeof listContacts>;

// The number the list's chip shows: the same search and filters, counted.
const count = (people?: FilterPeople) =>
  ({
    endpoint: countContacts,
    run: ({ invocation, query }, { db }) => {
      const parsed = parseInput(countContacts.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readContactCount(trx, invocation, parsed, people),
      );
    },
  }) satisfies Route<typeof countContacts>;

// The contacts before and after one in a list, so a contact page can step through the list
// it was opened from after a reload.
const neighbours = (people?: FilterPeople) =>
  ({
    endpoint: getContactNeighbours,
    run: ({ invocation, params, query }, { db }) => {
      const { id } = parseInput(getContactNeighbours.params, params);
      const parsed = parseInput(getContactNeighbours.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readContactNeighbours(trx, invocation, id, parsed, people),
      );
    },
  }) satisfies Route<typeof getContactNeighbours>;

const create = {
  endpoint: createContact,
  command: createContactCommand,
  run: ({ invocation, body }, services) =>
    runCommand(services, createContactCommand, body, invocation),
} satisfies Route<typeof createContact>;

const read = {
  endpoint: getContact,
  run: ({ invocation, params }, { db }) => {
    const { id } = parseInput(getContact.params, params);
    return withTenant(db, invocation.context, (trx) => readContact(trx, invocation, id));
  },
} satisfies Route<typeof getContact>;

// The body's issues point into the body, as the caller sent it; the id comes from the path.
const update = {
  endpoint: updateContact,
  command: updateContactCommand,
  run: ({ invocation, params, body }, services) =>
    runCommand(
      services,
      updateContactCommand,
      { ...parseInput(updateContactInput, body), ...parseInput(updateContact.params, params) },
      invocation,
    ),
} satisfies Route<typeof updateContact>;

const trash = {
  endpoint: trashContact,
  command: trashContactCommand,
  run: ({ invocation, params }, services) =>
    runCommand(services, trashContactCommand, parseInput(trashContact.params, params), invocation),
} satisfies Route<typeof trashContact>;

const restore = {
  endpoint: restoreContact,
  command: restoreContactCommand,
  run: ({ invocation, params }, services) =>
    runCommand(
      services,
      restoreContactCommand,
      parseInput(restoreContact.params, params),
      invocation,
    ),
} satisfies Route<typeof restoreContact>;

// The names a contact's time zone can be: PostgreSQL's own list, which the picker shows.
const timeZones = {
  endpoint: listTimeZones,
  run: async ({ invocation }, { db }) => ({
    items: [...(await withTenant(db, invocation.context, (trx) => readTimeZones(trx)))],
  }),
} satisfies Route<typeof listTimeZones>;

/** The contact routes. `people` is the team, as the module that owns it answers. */
export function createContactRoutes(people?: FilterPeople): readonly ApiRoute[] {
  return [
    list(people),
    count(people),
    create,
    read,
    neighbours(people),
    update,
    trash,
    restore,
    timeZones,
  ];
}

/** The contact routes for a caller with no team to ask, such as a test of the list. */
export const contactRoutes: readonly ApiRoute[] = createContactRoutes();
