import {
  requireBusiness,
  requirePermission,
  runCommand,
  type ApiRoute,
  type Route,
} from '@repo/commands';
import {
  connectMailbox,
  discoverMailboxServers,
  getMailboxConnectionAttempt,
  listMailboxes,
  mailbox,
  mailboxDiscovery,
  parseInput,
  requestMailboxCheck,
  getMailboxSetup,
  getMailboxSetupAlerts,
  getMailboxSendingSettings,
  updateMailboxSendingSettings,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { discoverMailbox, type MailboxDiscoveryOptions } from '@repo/mail';
import type { SealingVault } from '@repo/module-vault';
import { createConnectMailboxCommand, readMailboxConnectionAttempt } from './attempts.js';
import { requestMailboxCheckCommand, readMailboxSetup } from './check-runs.js';
import { readMailboxAlerts } from './check-alerts.js';
import { readMailboxSendingSettings, updateMailboxSendingCommand } from './mailbox-settings.js';

export function createMailboxRoutes(
  vault: SealingVault,
  discovery: MailboxDiscoveryOptions = {},
): readonly ApiRoute[] {
  const command = createConnectMailboxCommand(vault);
  const connect = {
    endpoint: connectMailbox,
    command,
    run: ({ invocation, body }, services) => runCommand(services, command, body, invocation),
  } satisfies Route<typeof connectMailbox>;
  const read = {
    endpoint: getMailboxConnectionAttempt,
    async run({ invocation, params }, services) {
      await requirePermission(
        services,
        { name: 'mailboxes.read_attempt', permission: 'mailboxes.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      const { id } = parseInput(getMailboxConnectionAttempt.params, params);
      return withTenant(services.db, invocation.context, (trx) =>
        readMailboxConnectionAttempt(trx, id),
      );
    },
  } satisfies Route<typeof getMailboxConnectionAttempt>;
  const discover = {
    endpoint: discoverMailboxServers,
    async run({ invocation, body }, services) {
      await requirePermission(
        services,
        { name: 'mailboxes.discover', permission: 'mailboxes.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      return mailboxDiscovery.parse(
        await discoverMailbox(parseInput(discoverMailboxServers.body, body).email, discovery),
      );
    },
  } satisfies Route<typeof discoverMailboxServers>;
  const list = {
    endpoint: listMailboxes,
    async run({ invocation }, services) {
      await requirePermission(
        services,
        { name: 'mailboxes.list', permission: 'mailboxes.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, async (trx) => {
        const rows = await trx
          .selectFrom('messaging.mailboxes as mailbox')
          .innerJoin('messaging.channel_accounts as channel', (join) =>
            join
              .onRef('channel.id', '=', 'mailbox.id')
              .onRef('channel.business_id', '=', 'mailbox.business_id'),
          )
          .select([
            'mailbox.id',
            'channel.name',
            'channel.status',
            'mailbox.email_address',
            'mailbox.display_name',
            'mailbox.smtp_host',
            'mailbox.smtp_port',
            'mailbox.smtp_security',
            'mailbox.smtp_username',
            'mailbox.imap_host',
            'mailbox.imap_port',
            'mailbox.imap_security',
            'mailbox.imap_username',
            'mailbox.created_at',
          ])
          .orderBy('mailbox.created_at')
          .orderBy('mailbox.id')
          .execute();
        return {
          data: rows.map((row) =>
            mailbox.parse({
              id: toPublicId('mailbox', row.id),
              name: row.name,
              email: row.email_address,
              displayName: row.display_name,
              status: row.status,
              createdAt: row.created_at.toISOString(),
              smtp: {
                host: row.smtp_host,
                port: row.smtp_port,
                security: row.smtp_security,
                username: row.smtp_username,
              },
              imap: {
                host: row.imap_host,
                port: row.imap_port,
                security: row.imap_security,
                username: row.imap_username,
              },
            }),
          ),
        };
      });
    },
  } satisfies Route<typeof listMailboxes>;
  const requestCheck = {
    endpoint: requestMailboxCheck,
    command: requestMailboxCheckCommand,
    run: ({ invocation, params }, services) =>
      runCommand(services, requestMailboxCheckCommand, params, invocation),
  } satisfies Route<typeof requestMailboxCheck>;
  const setup = {
    endpoint: getMailboxSetup,
    async run({ invocation, params }, services) {
      await requirePermission(
        services,
        { name: 'mailboxes.read_setup', permission: 'mailboxes.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      const { id } = parseInput(getMailboxSetup.params, params);
      return withTenant(services.db, invocation.context, (trx) => readMailboxSetup(trx, id));
    },
  } satisfies Route<typeof getMailboxSetup>;
  const alerts = {
    endpoint: getMailboxSetupAlerts,
    async run({ invocation }, services) {
      await requirePermission(
        services,
        { name: 'mailboxes.read_alerts', permission: 'mailboxes.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, readMailboxAlerts);
    },
  } satisfies Route<typeof getMailboxSetupAlerts>;
  const sending = {
    endpoint: getMailboxSendingSettings,
    async run({ invocation, params }, services) {
      await requirePermission(
        services,
        { name: 'mailboxes.read_sending', permission: 'mailboxes.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      const { id } = parseInput(getMailboxSendingSettings.params, params);
      return withTenant(services.db, invocation.context, (trx) =>
        readMailboxSendingSettings(trx, id),
      );
    },
  } satisfies Route<typeof getMailboxSendingSettings>;
  const updateSending = {
    endpoint: updateMailboxSendingSettings,
    command: updateMailboxSendingCommand,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        updateMailboxSendingCommand,
        {
          id: parseInput(updateMailboxSendingSettings.params, params).id,
          settings: parseInput(updateMailboxSendingSettings.body, body),
        },
        invocation,
      ),
  } satisfies Route<typeof updateMailboxSendingSettings>;
  return [connect, read, discover, list, requestCheck, setup, alerts, sending, updateSending];
}
