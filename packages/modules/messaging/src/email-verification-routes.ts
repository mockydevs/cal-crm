import {
  defineCommand,
  requireBusiness,
  requirePermission,
  runCommand,
  type ApiRoute,
  type Route,
} from '@repo/commands';
import {
  blockEmailAddress,
  unblockEmailAddress,
  verifyEmailAddress,
  excludeEmailAddress,
  includeEmailAddress,
  getEmailVerificationSettings,
  updateEmailVerificationSettings,
  connectEmailVerificationProvider,
  disconnectEmailVerificationProvider,
  testEmailVerificationProvider,
  connectEmailVerificationProviderInput,
  parseInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { emailableProvider, type MailboxProvider } from '@repo/email-checks';
import { ValidationError } from '@repo/kernel';
import type { SealingVault } from '@repo/module-vault';
import { sql } from 'kysely';
import * as z from 'zod';
import {
  emailAddressCommands,
  readVerificationSettings,
  updateVerificationSettingsCommand,
} from './email-verification.js';
import { EMAIL_VERIFICATION_SECRET } from './email-verification-task.js';

export function createEmailVerificationRoutes(
  options: {
    readonly vault?: SealingVault;
    readonly provider?: (key: string) => MailboxProvider;
  } = {},
): readonly ApiRoute[] {
  const connect = defineCommand({
    name: 'email_verification.connect',
    permission: 'email.verification.manage',
    input: connectEmailVerificationProviderInput.extend({
      availableCredits: z.int().min(0),
      testMode: z.boolean(),
    }),
    audit: () => ({}),
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      if (options.vault === undefined)
        throw new ValidationError([
          { path: '', code: 'vault_unavailable', message: 'The secret vault is not configured.' },
        ]);
      await sql`select id from tenancy.businesses where id=${businessId}::uuid for no key update`.execute(
        trx,
      );
      const {
        rows: [old],
      } = await sql<{ secret_id: string }>`select secret_id from messaging.provider_connections
        where business_id=app.business_id() and provider='emailable' for update`.execute(trx);
      const secretId =
        old?.secret_id ??
        (await options.vault.store(
          trx,
          { agencyId: command.context.agencyId, businessId, purpose: EMAIL_VERIFICATION_SECRET },
          input.apiKey,
        ));
      if (old !== undefined) await options.vault.replace(trx, secretId, input.apiKey);
      await sql`insert into messaging.provider_connections (agency_id,business_id,provider,label,account_ref,secret_id,status,last_checked_at,available_credits,test_mode)
        values (${command.context.agencyId}::uuid,${businessId}::uuid,'emailable','Email verification','verification',${secretId}::uuid,'connected',now(),${input.availableCredits},${input.testMode})
        on conflict (business_id) where provider='emailable' and business_id is not null do update
          set status='connected',last_checked_at=now(),available_credits=excluded.available_credits,test_mode=excluded.test_mode`.execute(
        trx,
      );
      return readVerificationSettings(trx);
    },
  });
  const disconnect = defineCommand({
    name: 'email_verification.disconnect',
    permission: 'email.verification.manage',
    input: z.strictObject({}),
    async handle(trx, _input, command) {
      requireBusiness(command.context);
      // Keep the sealed secret on the disconnected row; no task uses disconnected credentials.
      await sql`update messaging.provider_connections set status='disconnected',available_credits=null,test_mode=null
        where business_id=app.business_id() and provider='emailable'`.execute(trx);
      return readVerificationSettings(trx);
    },
  });
  const test = defineCommand({
    name: 'email_verification.test',
    permission: 'email.verification.manage',
    input: z.strictObject({}),
    async handle(trx, _input, command) {
      requireBusiness(command.context);
      command.enqueue(
        { name: 'messaging.test_email_verification_provider', data: z.strictObject({}) },
        {},
      );
      return readVerificationSettings(trx);
    },
  });
  const read = {
    endpoint: getEmailVerificationSettings,
    async run({ invocation }, services) {
      await requirePermission(
        services,
        { name: 'email_verification.read_settings', permission: 'email.verification.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, readVerificationSettings);
    },
  } satisfies Route<typeof getEmailVerificationSettings>;
  const update = {
    endpoint: updateEmailVerificationSettings,
    command: updateVerificationSettingsCommand,
    run: ({ body, invocation }, services) =>
      runCommand(services, updateVerificationSettingsCommand, body, invocation),
  } satisfies Route<typeof updateEmailVerificationSettings>;
  const connecting = {
    endpoint: connectEmailVerificationProvider,
    command: connect,
    async run({ body, invocation }, services) {
      await requirePermission(services, connect, invocation);
      requireBusiness(invocation.context);
      const input = parseInput(connectEmailVerificationProviderInput, body);
      // Account fields/auth verified against https://emailable.com/docs/api/account/ and
      // https://emailable.com/docs/api/authentication/. No transaction is open here.
      const outcome = await (options.provider ?? ((key) => emailableProvider({ apiKey: key })))(
        input.apiKey,
      ).account();
      if (outcome.kind !== 'ok')
        throw new ValidationError([
          {
            path: '/apiKey',
            code: 'connection_failed',
            message: 'The verification provider could not confirm this key.',
          },
        ]);
      return runCommand(
        services,
        connect,
        { ...input, availableCredits: outcome.availableCredits, testMode: outcome.testMode },
        invocation,
      );
    },
  } satisfies Route<typeof connectEmailVerificationProvider>;
  return [
    read,
    update,
    connecting,
    {
      endpoint: disconnectEmailVerificationProvider,
      command: disconnect,
      run: ({ invocation }, services) => runCommand(services, disconnect, {}, invocation),
    } satisfies Route<typeof disconnectEmailVerificationProvider>,
    {
      endpoint: testEmailVerificationProvider,
      command: test,
      run: ({ invocation }, services) => runCommand(services, test, {}, invocation),
    } satisfies Route<typeof testEmailVerificationProvider>,
    {
      endpoint: verifyEmailAddress,
      command: emailAddressCommands.verify,
      run: ({ body, invocation }, services) =>
        runCommand(services, emailAddressCommands.verify, body, invocation),
    } satisfies Route<typeof verifyEmailAddress>,
    {
      endpoint: excludeEmailAddress,
      command: emailAddressCommands.exclude,
      run: ({ body, invocation }, services) =>
        runCommand(services, emailAddressCommands.exclude, body, invocation),
    } satisfies Route<typeof excludeEmailAddress>,
    {
      endpoint: includeEmailAddress,
      command: emailAddressCommands.include,
      run: ({ body, invocation }, services) =>
        runCommand(services, emailAddressCommands.include, body, invocation),
    } satisfies Route<typeof includeEmailAddress>,
    {
      endpoint: blockEmailAddress,
      command: emailAddressCommands.block,
      run: ({ body, invocation }, services) =>
        runCommand(services, emailAddressCommands.block, body, invocation),
    } satisfies Route<typeof blockEmailAddress>,
    {
      endpoint: unblockEmailAddress,
      command: emailAddressCommands.unblock,
      run: ({ body, invocation }, services) =>
        runCommand(services, emailAddressCommands.unblock, body, invocation),
    } satisfies Route<typeof unblockEmailAddress>,
  ];
}
