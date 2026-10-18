// The routes of duplicate contacts: the deduplication preferences, the lookup, Manage
// Duplicates' groups and Reject, and a contact's possible duplicates. Reading contacts needs
// no permission, as a contact's own page doesn't; the groups of the whole business are
// Manage Duplicates', which GoHighLevel gives admins only (contacts.merge).
import { requirePermission, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  findDuplicateContact,
  getDuplicateSettings,
  listDuplicateGroups,
  listPossibleDuplicates,
  parseInput,
  rejectDuplicateGroup,
  updateDuplicateSettings,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import {
  findDuplicateContact as findHolder,
  readDuplicateGroups,
  readPossibleDuplicates,
  rejectDuplicateGroupCommand,
} from './duplicates.js';
import { readDuplicateSettings, updateDuplicateSettingsCommand } from './duplicate-settings.js';

const readSettings = {
  endpoint: getDuplicateSettings,
  run: ({ invocation }, { db }) =>
    withTenant(db, invocation.context, (trx) => readDuplicateSettings(trx, invocation)),
} satisfies Route<typeof getDuplicateSettings>;

const updateSettings = {
  endpoint: updateDuplicateSettings,
  command: updateDuplicateSettingsCommand,
  run: ({ invocation, body }, services) =>
    runCommand(services, updateDuplicateSettingsCommand, body, invocation),
} satisfies Route<typeof updateDuplicateSettings>;

const lookup = {
  endpoint: findDuplicateContact,
  run: ({ invocation, query }, { db }) => {
    const parsed = parseInput(findDuplicateContact.query, query);
    return withTenant(db, invocation.context, (trx) => findHolder(trx, invocation, parsed));
  },
} satisfies Route<typeof findDuplicateContact>;

// Seeing every group is Manage Duplicates: a refusal is audited as a command's is.
const groups = {
  endpoint: listDuplicateGroups,
  async run({ invocation, query }, services) {
    await requirePermission(
      services,
      { name: 'contact_duplicates.list', permission: 'contacts.merge' },
      invocation,
    );
    const parsed = parseInput(listDuplicateGroups.query, query);
    return withTenant(services.db, invocation.context, (trx) =>
      readDuplicateGroups(trx, invocation, parsed),
    );
  },
} satisfies Route<typeof listDuplicateGroups>;

const reject = {
  endpoint: rejectDuplicateGroup,
  command: rejectDuplicateGroupCommand,
  run: async ({ invocation, body }, services) => {
    await runCommand(services, rejectDuplicateGroupCommand, body, invocation);
  },
} satisfies Route<typeof rejectDuplicateGroup>;

const possible = {
  endpoint: listPossibleDuplicates,
  run: ({ invocation, params }, { db }) => {
    const { id } = parseInput(listPossibleDuplicates.params, params);
    return withTenant(db, invocation.context, (trx) => readPossibleDuplicates(trx, invocation, id));
  },
} satisfies Route<typeof listPossibleDuplicates>;

export const contactDuplicateRoutes: readonly ApiRoute[] = [
  readSettings,
  updateSettings,
  lookup,
  groups,
  reject,
  possible,
];
