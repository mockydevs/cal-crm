import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  getContactConsent,
  getMessagingSettings,
  parseInput,
  recordContactConsent,
  updateMessagingSettings,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import type { ActorNames } from '@repo/module-crm';
import { readContactConsent } from './consent-read.js';
import { createRecordContactConsentCommand } from './consent-record.js';
import { readMessagingSettings, updateMessagingSettingsCommand } from './quiet-hours-settings.js';

/**
 * A contact's consent, and the business's quiet hours. Reading needs no permission beyond
 * being in the business, as reading the contact does; each answer says whether the
 * reader may change it.
 */
export function createConsentRoutes(actorNames: ActorNames = {}): readonly ApiRoute[] {
  const recordCommand = createRecordContactConsentCommand(actorNames);
  const read = {
    endpoint: getContactConsent,
    async run({ invocation, params }, services) {
      requireBusiness(invocation.context);
      const { id } = parseInput(getContactConsent.params, params);
      return withTenant(services.db, invocation.context, (trx) =>
        readContactConsent(trx, invocation, id, actorNames),
      );
    },
  } satisfies Route<typeof getContactConsent>;
  const record = {
    endpoint: recordContactConsent,
    command: recordCommand,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        recordCommand,
        {
          ...parseInput(recordContactConsent.body, body),
          id: parseInput(recordContactConsent.params, params).id,
        },
        invocation,
      ),
  } satisfies Route<typeof recordContactConsent>;
  const settings = {
    endpoint: getMessagingSettings,
    async run({ invocation }, services) {
      requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, (trx) =>
        readMessagingSettings(trx, invocation),
      );
    },
  } satisfies Route<typeof getMessagingSettings>;
  const updateSettings = {
    endpoint: updateMessagingSettings,
    command: updateMessagingSettingsCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, updateMessagingSettingsCommand, body, invocation),
  } satisfies Route<typeof updateMessagingSettings>;
  return [read, record, settings, updateSettings];
}
