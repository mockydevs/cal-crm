import { defineTask, requireBusiness, type Task } from '@repo/commands';
import { connectMailboxInput, type ConnectMailboxInput } from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import type { MailboxConnector, MailboxInboxCursor, MailboxReader } from '@repo/mail';
import { SecretUnreadableError, type Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import { ZodError } from 'zod';
import {
  failAttempt,
  findAttempt,
  MAILBOX_CREDENTIALS,
  verifyMailboxReference,
} from './attempts.js';
import { beginMailboxCheck } from './check-runs.js';

async function saveMailbox(
  trx: DatabaseTransaction,
  businessId: string,
  secretId: string,
  input: ConnectMailboxInput,
  baseline: { startedAt: Date; cursor: MailboxInboxCursor },
): Promise<string> {
  const channel = await trx
    .insertInto('messaging.channel_accounts')
    .values({ business_id: businessId, channel: 'email', name: input.name })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('messaging.mailboxes')
    .values({
      business_id: businessId,
      id: channel.id,
      email_address: input.email,
      display_name: input.displayName,
      auth_method: 'password',
      smtp_host: input.smtp.host,
      smtp_port: input.smtp.port,
      smtp_security: input.smtp.security,
      smtp_username: input.smtp.username,
      imap_host: input.imap.host,
      imap_port: input.imap.port,
      imap_security: input.imap.security,
      imap_username: input.imap.username,
      secret_id: secretId,
      warmup_started_at: sql`now()`,
      // Inbound sync reads only mail that arrives after this.
      inbound_started_at: baseline.startedAt,
      inbound_uid_validity: baseline.cursor.uidValidity,
      imap_uid_validity: baseline.cursor.uidValidity,
      imap_last_uid: String(baseline.cursor.lastUid),
    })
    .execute();
  return channel.id;
}

/**
 * Where inbound sync starts: the time just before, and the inbox's end as read then. Only
 * mail after them is read. A failed read fails the job, which retries while the attempt is
 * pending: a mailbox is never saved without them.
 */
async function inboxBaseline(
  reader: MailboxReader,
  input: ConnectMailboxInput,
): Promise<{ startedAt: Date; cursor: MailboxInboxCursor }> {
  const startedAt = new Date();
  return { startedAt, cursor: (await reader.readInbox(input.imap, null)).cursor };
}

/** Only the worker receives a vault that can open credentials. Sign-ins hold no DB transaction. */
export function createVerifyMailboxTask(
  vault: Vault,
  connector: MailboxConnector & MailboxReader,
): Task<typeof verifyMailboxReference.data> {
  return defineTask({
    ...verifyMailboxReference,
    async run({ attemptId }, { invocation, services }) {
      const businessId = requireBusiness(invocation.context);
      const prepared = await withTenant(services.db, invocation.context, async (trx) => {
        const row = await findAttempt(trx, attemptId, true);
        if (row?.status !== 'pending' || row.secret_id === null) return null;
        if (row.expires_at.getTime() <= Date.now()) {
          await failAttempt(trx, vault, row, 'expired');
          return null;
        }
        try {
          const credentials = await vault.read(trx, row.secret_id, MAILBOX_CREDENTIALS);
          const parsed: unknown = JSON.parse(credentials);
          return { secretId: row.secret_id, input: connectMailboxInput.parse(parsed) };
        } catch (failure) {
          if (!(
            failure instanceof SecretUnreadableError ||
            failure instanceof ZodError ||
            failure instanceof SyntaxError
          ))
            throw failure;
          await failAttempt(trx, vault, row, 'credentials_unreadable');
          return null;
        }
      });
      if (prepared === null) return;
      const result = await connector.verify(prepared.input);
      const verified = result.smtp.status !== 'fail' && result.imap.status !== 'fail';
      const baseline = verified ? await inboxBaseline(connector, prepared.input) : null;
      await withTenant(services.db, invocation.context, async (trx) => {
        const row = await findAttempt(trx, attemptId, true);
        if (row?.status !== 'pending' || row.secret_id !== prepared.secretId) return;
        if (row.expires_at.getTime() <= Date.now()) await failAttempt(trx, vault, row, 'expired');
        else if (baseline === null) await failAttempt(trx, vault, row, 'connection_failed', result);
        else {
          const mailboxId = await saveMailbox(
            trx,
            businessId,
            prepared.secretId,
            prepared.input,
            baseline,
          );
          const initial = await beginMailboxCheck(trx, businessId, mailboxId, 'connect');
          await sql`select private.enqueue_mailbox_check(${initial.runId}::uuid, ${invocation.causationId ?? null}::uuid)`.execute(
            trx,
          );
          await trx
            .updateTable('messaging.mailbox_connection_attempts')
            .set({
              status: 'connected',
              secret_id: null,
              mailbox_id: mailboxId,
              result: sql`${JSON.stringify(result)}::jsonb`,
              finished_at: sql<Date>`now()`,
            })
            .where('id', '=', attemptId)
            .execute();
        }
        await sql`select pg_notify('crm_business_changed', ${businessId})`.execute(trx);
      });
    },
  });
}
