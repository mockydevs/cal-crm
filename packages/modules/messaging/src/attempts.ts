import { defineCommand, type Command, type TaskReference } from '@repo/commands';
import {
  connectMailboxInput,
  mailboxConnectionAttempt,
  mailboxConnectionResult,
  type MailboxConnectionAttempt,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction, type DB } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import type { SealingVault } from '@repo/module-vault';
import { requireBusiness } from '@repo/commands';
import { sql, type Selectable } from 'kysely';
import * as z from 'zod';

export const MAILBOX_CREDENTIALS = 'mailbox.credentials';
export const verifyMailboxReference = {
  name: 'mailboxes.verify',
  data: z.strictObject({ attemptId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

type AttemptRow = Selectable<DB['messaging.mailbox_connection_attempts']>;

export async function findAttempt(
  trx: DatabaseTransaction,
  id: string,
  lock = false,
): Promise<AttemptRow | undefined> {
  const query = trx
    .selectFrom('messaging.mailbox_connection_attempts')
    .selectAll()
    .where('id', '=', id);
  return (lock ? query.forUpdate() : query).executeTakeFirst();
}

export async function readMailboxConnectionAttempt(
  trx: DatabaseTransaction,
  publicId: string,
): Promise<MailboxConnectionAttempt> {
  const id = parsePublicId('mailbox_attempt', publicId);
  const row = id === undefined ? undefined : await findAttempt(trx, id);
  if (row === undefined) throw new NotFoundError('mailbox connection attempt', publicId);
  const common = {
    id: toPublicId('mailbox_attempt', row.id),
    createdAt: row.created_at.toISOString(),
  };
  if (row.status === 'pending')
    return mailboxConnectionAttempt.parse({
      ...common,
      status: 'pending',
      mailboxId: null,
      result: null,
    });
  const result = row.result === null ? null : mailboxConnectionResult.parse(row.result);
  return mailboxConnectionAttempt.parse({
    ...common,
    status: row.status,
    mailboxId: row.mailbox_id === null ? null : toPublicId('mailbox', row.mailbox_id),
    result,
    ...(row.status === 'failed' ? { failure: row.failure_code } : {}),
  });
}

/** Clear the reference before removing its secret; a connected mailbox never uses this path. */
export async function failAttempt(
  trx: DatabaseTransaction,
  vault: SealingVault,
  row: AttemptRow,
  failure: 'expired' | 'credentials_unreadable' | 'connection_failed',
  result: z.output<typeof mailboxConnectionResult> | null = null,
): Promise<void> {
  await trx
    .updateTable('messaging.mailbox_connection_attempts')
    .set({
      status: 'failed',
      failure_code: failure,
      result: result === null ? null : sql`${JSON.stringify(result)}::jsonb`,
      secret_id: null,
      finished_at: sql<Date>`now()`,
    })
    .where('id', '=', row.id)
    .execute();
  if (row.secret_id !== null) await vault.remove(trx, row.secret_id);
}

export function createConnectMailboxCommand(
  vault: SealingVault,
): Command<typeof connectMailboxInput, MailboxConnectionAttempt> {
  return defineCommand({
    name: 'mailboxes.connect',
    permission: 'mailboxes.manage',
    input: connectMailboxInput,
    audit: ({ name, email }) => ({ name, email }),
    async handle(trx, input, command): Promise<MailboxConnectionAttempt> {
      const businessId = requireBusiness(command.context);
      const normalized = input.email.toLowerCase();
      const existing = await trx
        .selectFrom('messaging.mailboxes')
        .select('id')
        .where('email_normalized', '=', normalized)
        .executeTakeFirst();
      if (existing !== undefined) throw new ConflictError('This mailbox is already connected.');
      const pending = await trx
        .selectFrom('messaging.mailbox_connection_attempts')
        .selectAll()
        .where('email_normalized', '=', normalized)
        .where('status', '=', 'pending')
        .forUpdate()
        .executeTakeFirst();
      if (pending !== undefined) {
        if (pending.expires_at.getTime() > Date.now())
          throw new ConflictError('This mailbox is already being tested.');
        await failAttempt(trx, vault, pending, 'expired');
      }
      const secretId = await vault.store(
        trx,
        { agencyId: command.context.agencyId, businessId, purpose: MAILBOX_CREDENTIALS },
        JSON.stringify(input),
      );
      const row = await trx
        .insertInto('messaging.mailbox_connection_attempts')
        .values({ business_id: businessId, email_address: input.email, secret_id: secretId })
        .returning(['id', 'created_at'])
        .executeTakeFirstOrThrow()
        .catch(
          explainUniqueViolation({
            mailbox_attempts_pending_email_unique: () =>
              new ConflictError('This mailbox is already being tested.'),
          }),
        );
      await command.emit({
        type: 'mailbox.connection_requested',
        subject: { kind: 'mailbox_attempt', id: row.id },
      });
      command.enqueue(verifyMailboxReference, { attemptId: row.id });
      return {
        id: toPublicId('mailbox_attempt', row.id),
        status: 'pending',
        mailboxId: null,
        result: null,
        createdAt: row.created_at.toISOString(),
      };
    },
  });
}
