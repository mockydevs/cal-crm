import { defineCommand, requireBusiness, type Command, type TaskReference } from '@repo/commands';
import {
  mailboxSetup,
  mailboxSetupCheck,
  requestMailboxCheckInput,
  type MailboxSetup,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import * as z from 'zod';
import { sql } from 'kysely';

export const checkMailboxReference = {
  name: 'mailboxes.check',
  data: z.strictObject({ runId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

/** The mailbox lock serializes manual, initial and daily check requests. */
export async function beginMailboxCheck(
  trx: DatabaseTransaction,
  businessId: string,
  mailboxId: string,
  trigger: 'connect' | 'manual' | 'scheduled' | 'bounce_spike',
): Promise<{ readonly runId: string; readonly setup: MailboxSetup }> {
  const mailbox = await trx
    .selectFrom('messaging.mailboxes as mailbox')
    .innerJoin('messaging.channel_accounts as channel', (join) =>
      join
        .onRef('channel.business_id', '=', 'mailbox.business_id')
        .onRef('channel.id', '=', 'mailbox.id'),
    )
    .innerJoin('tenancy.businesses as business', 'business.id', 'mailbox.business_id')
    .select(['mailbox.id', 'channel.status', 'business.status as business_status'])
    .where('mailbox.id', '=', mailboxId)
    .forUpdate('mailbox')
    .executeTakeFirst();
  const publicId = toPublicId('mailbox', mailboxId);
  if (mailbox === undefined) throw new NotFoundError('mailbox', publicId);
  if (mailbox.status !== 'active' || mailbox.business_status !== 'active')
    throw new ConflictError('This mailbox is not available for setup checks.');
  const pending = await trx
    .selectFrom('messaging.mailbox_check_runs')
    .select('id')
    .where('mailbox_id', '=', mailboxId)
    .where('finished_at', 'is', null)
    .executeTakeFirst();
  if (pending !== undefined) throw new ConflictError('A mailbox check is already running.');
  const run = await trx
    .insertInto('messaging.mailbox_check_runs')
    .values({ business_id: businessId, mailbox_id: mailboxId, trigger, method: 'self' })
    .returningAll()
    .executeTakeFirstOrThrow();
  return {
    runId: run.id,
    setup: mailboxSetup.parse({
      mailboxId: publicId,
      state: 'pending',
      method: run.method,
      trigger: run.trigger,
      startedAt: run.started_at.toISOString(),
      finishedAt: null,
      score: null,
      checks: [],
    }),
  };
}

/** Latest tenant-visible check only; no run identifier, raw mail or secret leaves the module. */
export async function readMailboxSetup(
  trx: DatabaseTransaction,
  publicId: string,
): Promise<MailboxSetup | null> {
  const id = parsePublicId('mailbox', publicId);
  const mailbox =
    id === undefined
      ? undefined
      : await trx
          .selectFrom('messaging.mailboxes')
          .select('id')
          .where('id', '=', id)
          .executeTakeFirst();
  if (mailbox === undefined) throw new NotFoundError('mailbox', publicId);
  const run = await trx
    .selectFrom('messaging.mailbox_check_runs')
    .selectAll()
    .where('mailbox_id', '=', mailbox.id)
    .orderBy('started_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (run === undefined) return null;
  const rows =
    run.finished_at === null
      ? []
      : await trx
          .selectFrom('messaging.mailbox_check_results')
          .selectAll()
          .where('run_id', '=', run.id)
          .orderBy('check_key')
          .execute();
  const checks = rows.map((row) => {
    const details = row.details;
    return mailboxSetupCheck.parse({
      key: row.check_key,
      status: row.status,
      pointsPossible: row.points_possible,
      pointsAwarded: row.points_awarded,
      reason:
        typeof details === 'object' && details !== null && 'reason' in details
          ? details['reason']
          : undefined,
      ...(typeof details === 'object' && details !== null && 'fix' in details
        ? { fix: details['fix'] }
        : {}),
    });
  });
  return mailboxSetup.parse({
    mailboxId: publicId,
    state: run.finished_at === null ? 'pending' : 'finished',
    method: run.method,
    trigger: run.trigger,
    startedAt: run.started_at.toISOString(),
    finishedAt: run.finished_at?.toISOString() ?? null,
    score: run.score,
    checks,
  });
}

export const requestMailboxCheckCommand: Command<typeof requestMailboxCheckInput, MailboxSetup> =
  defineCommand({
    name: 'mailboxes.check',
    permission: 'mailboxes.manage',
    input: requestMailboxCheckInput,
    async handle(trx, { id }, command) {
      const mailboxId = parsePublicId('mailbox', id);
      if (mailboxId === undefined) throw new NotFoundError('mailbox', id);
      const { runId, setup } = await beginMailboxCheck(
        trx,
        requireBusiness(command.context),
        mailboxId,
        'manual',
      );
      const causationId = await command.emit({
        type: 'mailbox.check_requested',
        subject: { kind: 'mailbox', id: mailboxId },
      });
      await sql`select private.enqueue_mailbox_check(${runId}::uuid, ${causationId}::uuid)`.execute(
        trx,
      );
      return setup;
    },
  });
