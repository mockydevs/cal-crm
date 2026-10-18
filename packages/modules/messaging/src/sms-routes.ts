import {
  requireBusiness,
  requirePermission,
  runCommand,
  type ApiRoute,
  type Route,
} from '@repo/commands';
import {
  connectSms,
  getSmsConnectionAttempt,
  listPhoneNumbers,
  listSmsConnections,
  listSmsProviderNumbers,
  parseInput,
  refreshSmsProviderNumbers,
  registerPhoneNumber,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import type { SealingVault } from '@repo/module-vault';

import {
  createConnectSmsCommand,
  readSmsConnectionAttempt,
  readSmsConnections,
} from './sms-connect.js';
import {
  readPhoneNumbers,
  readSmsProviderNumbers,
  refreshSmsNumbersCommand,
  registerPhoneNumberCommand,
} from './sms-numbers.js';
import { smsDeliveryAvailable } from './sms-webhook-url.js';

/**
 * The SMS settings API. The app's vault can only seal, so no route here can read a
 * credential back, and none calls Twilio: the worker does that.
 */
export function createSmsRoutes(vault: SealingVault, publicUrl: string): readonly ApiRoute[] {
  const connectCommand = createConnectSmsCommand(vault, publicUrl);
  // Said with the list, so Settings can say it before anyone connects anything.
  const unavailable = smsDeliveryAvailable(publicUrl)
    ? null
    : {
        code: 'public_address_unsuitable' as const,
        message:
          "Text messages can't be sent or received here: this install's public address must be a secure one (https, with no underscore in its name) for the provider to report to.",
      };
  const connect = {
    endpoint: connectSms,
    command: connectCommand,
    run: ({ invocation, body }, services) => runCommand(services, connectCommand, body, invocation),
  } satisfies Route<typeof connectSms>;
  const readAttempt = {
    endpoint: getSmsConnectionAttempt,
    async run({ invocation, params }, services) {
      await requirePermission(
        services,
        { name: 'sms.read_attempt', permission: 'sms.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      const { id } = parseInput(getSmsConnectionAttempt.params, params);
      return withTenant(services.db, invocation.context, (trx) =>
        readSmsConnectionAttempt(trx, id),
      );
    },
  } satisfies Route<typeof getSmsConnectionAttempt>;
  const connections = {
    endpoint: listSmsConnections,
    async run({ invocation }, services) {
      await requirePermission(
        services,
        { name: 'sms.list_connections', permission: 'sms.manage' },
        invocation,
      );
      const businessId = requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, async (trx) => ({
        data: await readSmsConnections(trx, businessId),
        unavailable,
      }));
    },
  } satisfies Route<typeof listSmsConnections>;
  const providerNumbers = {
    endpoint: listSmsProviderNumbers,
    async run({ invocation, params }, services) {
      await requirePermission(
        services,
        { name: 'sms.list_provider_numbers', permission: 'sms.manage' },
        invocation,
      );
      const businessId = requireBusiness(invocation.context);
      const { id } = parseInput(listSmsProviderNumbers.params, params);
      return withTenant(services.db, invocation.context, async (trx) => ({
        data: await readSmsProviderNumbers(trx, businessId, id),
      }));
    },
  } satisfies Route<typeof listSmsProviderNumbers>;
  const refresh = {
    endpoint: refreshSmsProviderNumbers,
    command: refreshSmsNumbersCommand,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        refreshSmsNumbersCommand,
        parseInput(refreshSmsProviderNumbers.params, params),
        invocation,
      ),
  } satisfies Route<typeof refreshSmsProviderNumbers>;
  const register = {
    endpoint: registerPhoneNumber,
    command: registerPhoneNumberCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, registerPhoneNumberCommand, body, invocation),
  } satisfies Route<typeof registerPhoneNumber>;
  const numbers = {
    endpoint: listPhoneNumbers,
    async run({ invocation }, services) {
      await requirePermission(
        services,
        { name: 'sms.list_numbers', permission: 'sms.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, async (trx) => ({
        data: await readPhoneNumbers(trx),
      }));
    },
  } satisfies Route<typeof listPhoneNumbers>;
  return [connect, readAttempt, connections, providerNumbers, refresh, register, numbers];
}
