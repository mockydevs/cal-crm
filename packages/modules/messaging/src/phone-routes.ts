import {
  requireBusiness,
  requirePermission,
  runCommand,
  type ApiRoute,
  type Route,
} from '@repo/commands';
import {
  getPhoneNumberSettings,
  getPhoneSystemSettings,
  listCallingSetups,
  listPhoneSystemNumbers,
  listPhoneSystemMembers,
  parseInput,
  setUpCalling,
  updatePhoneNumberSettings,
  updatePhoneSystemSettings,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import {
  readPhoneNumberSettings,
  readPhoneSystemNumbers,
  readPhoneSystemMembers,
  readPhoneSystemSettings,
  updatePhoneNumberSettingsCommand,
  updatePhoneSystemSettingsCommand,
} from './phone-settings.js';
import { readCallingSetups, setUpCallingCommand } from './voice-setup.js';

/**
 * Settings → Phone System. Reading needs phone.manage too: a number's routing
 * holds the outside numbers its calls are forwarded to, which can be someone's own phone.
 */
export function createPhoneSystemRoutes(): readonly ApiRoute[] {
  const members = {
    endpoint: listPhoneSystemMembers,
    async run({ invocation, query }, services) {
      await requirePermission(
        services,
        { name: 'phone.list_members', permission: 'phone.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, (trx) =>
        readPhoneSystemMembers(
          trx,
          invocation.context,
          parseInput(listPhoneSystemMembers.query, query),
        ),
      );
    },
  } satisfies Route<typeof listPhoneSystemMembers>;
  const settings = {
    endpoint: getPhoneSystemSettings,
    async run({ invocation }, services) {
      await requirePermission(
        services,
        { name: 'phone.read_settings', permission: 'phone.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, (trx) =>
        readPhoneSystemSettings(trx, invocation),
      );
    },
  } satisfies Route<typeof getPhoneSystemSettings>;
  const updateSettings = {
    endpoint: updatePhoneSystemSettings,
    command: updatePhoneSystemSettingsCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, updatePhoneSystemSettingsCommand, body, invocation),
  } satisfies Route<typeof updatePhoneSystemSettings>;
  const numbers = {
    endpoint: listPhoneSystemNumbers,
    async run({ invocation }, services) {
      await requirePermission(
        services,
        { name: 'phone.list_numbers', permission: 'phone.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, async (trx) => ({
        data: await readPhoneSystemNumbers(trx, invocation),
      }));
    },
  } satisfies Route<typeof listPhoneSystemNumbers>;
  const numberSettings = {
    endpoint: getPhoneNumberSettings,
    async run({ invocation, params }, services) {
      await requirePermission(
        services,
        { name: 'phone_number.read_settings', permission: 'phone.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      const { id } = parseInput(getPhoneNumberSettings.params, params);
      return withTenant(services.db, invocation.context, (trx) =>
        readPhoneNumberSettings(trx, invocation, id),
      );
    },
  } satisfies Route<typeof getPhoneNumberSettings>;
  const updateNumberSettings = {
    endpoint: updatePhoneNumberSettings,
    command: updatePhoneNumberSettingsCommand,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        updatePhoneNumberSettingsCommand,
        {
          ...parseInput(updatePhoneNumberSettings.body, body),
          id: parseInput(updatePhoneNumberSettings.params, params).id,
        },
        invocation,
      ),
  } satisfies Route<typeof updatePhoneNumberSettings>;
  const callingSetups = {
    endpoint: listCallingSetups,
    async run({ invocation }, services) {
      await requirePermission(
        services,
        { name: 'phone.list_calling_setups', permission: 'phone.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, (trx) => readCallingSetups(trx));
    },
  } satisfies Route<typeof listCallingSetups>;
  const setUp = {
    endpoint: setUpCalling,
    command: setUpCallingCommand,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        setUpCallingCommand,
        parseInput(setUpCalling.params, params),
        invocation,
      ),
  } satisfies Route<typeof setUpCalling>;
  return [
    members,
    settings,
    updateSettings,
    numbers,
    numberSettings,
    updateNumberSettings,
    callingSetups,
    setUp,
  ];
}
