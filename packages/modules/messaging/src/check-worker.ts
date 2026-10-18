import { defineTask, requireBusiness, type Task } from '@repo/commands';
import { connectMailboxInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import type { MailboxProbe } from '@repo/mail';
import { checkDns, type CheckStatus, type DnsFix, type Resolve } from '@repo/mail-checks';
import { SecretUnreadableError, type Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import { ZodError } from 'zod';
import { MAILBOX_CREDENTIALS } from './attempts.js';
import { checkSelfMessage } from './check-message.js';
import { checkMailboxReference } from './check-runs.js';
import { scoreMailboxChecks, type MailboxCheckKey, type MailboxCheckStatuses } from './score.js';

interface Evidence {
  readonly status: CheckStatus;
  readonly reason: string;
  readonly fix?: DnsFix;
}

function unknownChecks(): Record<MailboxCheckKey, Evidence> {
  const unknown = { status: 'could_not_check', reason: 'not_attempted' } as const;
  return {
    connection: unknown,
    encryption: unknown,
    spf: unknown,
    dkim: unknown,
    dmarc: unknown,
    dmarc_enforcement: unknown,
    reverse_dns: unknown,
    mx: unknown,
    blocklists: { status: 'could_not_check', reason: 'not_configured' },
    unsubscribe: unknown,
  };
}

/** Credentials and raw self-copies stay in this worker; persisted details are allowlisted. */
export function createCheckMailboxTask(
  vault: Vault,
  probe: MailboxProbe,
  resolve?: Resolve,
): Task<typeof checkMailboxReference.data> {
  return defineTask({
    ...checkMailboxReference,
    async run({ runId }, { invocation, services }) {
      const businessId = requireBusiness(invocation.context);
      const prepared = await withTenant(services.db, invocation.context, async (trx) => {
        const row = await trx
          .selectFrom('messaging.mailbox_check_runs as run')
          .innerJoin('messaging.mailboxes as mailbox', 'mailbox.id', 'run.mailbox_id')
          .innerJoin('messaging.channel_accounts as channel', 'channel.id', 'mailbox.id')
          .innerJoin('tenancy.businesses as business', 'business.id', 'mailbox.business_id')
          .select(['run.mailbox_id', 'mailbox.secret_id'])
          .where('run.id', '=', runId)
          .where('run.finished_at', 'is', null)
          .where('channel.status', '=', 'active')
          .where('business.status', '=', 'active')
          .executeTakeFirst();
        if (row === undefined) return null;
        try {
          const decrypted = await vault.read(trx, row.secret_id, MAILBOX_CREDENTIALS);
          const parsed: unknown = JSON.parse(decrypted);
          return { mailboxId: row.mailbox_id, input: connectMailboxInput.parse(parsed) };
        } catch (failure) {
          if (!(
            failure instanceof SecretUnreadableError ||
            failure instanceof ZodError ||
            failure instanceof SyntaxError
          ))
            throw failure;
          return { mailboxId: row.mailbox_id, input: null };
        }
      });
      if (prepared === null) return;
      const evidence = unknownChecks();
      if (prepared.input === null) {
        evidence.connection = { status: 'fail', reason: 'credentials_unavailable' };
      } else {
        const domain = prepared.input.email.slice(prepared.input.email.lastIndexOf('@') + 1);
        // The sender's public IP and envelope return path are not proven by a self-copy.
        // Checking the From domain's SPF record cannot authorize an invented source IP.
        const dns = await checkDns({ fromDomain: domain, returnPathDomain: domain }, resolve);
        for (const check of dns) evidence[check.key] = check;
        try {
          const message = await checkSelfMessage(probe, prepared.input, resolve);
          evidence.connection = { status: 'pass', reason: 'self_copy_received' };
          for (const check of message) {
            if (check.key !== 'dmarc' || evidence.dmarc.status === 'pass')
              evidence[check.key] = check;
          }
        } catch {
          // Vendor errors and parser excerpts may contain mail or credentials.
          evidence.connection = { status: 'fail', reason: 'self_copy_unavailable' };
        }
      }
      const statuses: MailboxCheckStatuses = {
        connection: evidence.connection.status,
        encryption: evidence.encryption.status,
        spf: evidence.spf.status,
        dkim: evidence.dkim.status,
        dmarc: evidence.dmarc.status,
        dmarc_enforcement: evidence.dmarc_enforcement.status,
        reverse_dns: evidence.reverse_dns.status,
        mx: evidence.mx.status,
        blocklists: evidence.blocklists.status,
        unsubscribe: evidence.unsubscribe.status,
      };
      const scored = scoreMailboxChecks(statuses);
      await withTenant(services.db, invocation.context, async (trx) => {
        const run = await trx
          .selectFrom('messaging.mailbox_check_runs as run')
          .innerJoin('messaging.channel_accounts as channel', 'channel.id', 'run.mailbox_id')
          .innerJoin('tenancy.businesses as business', 'business.id', 'run.business_id')
          .select('run.id')
          .where('run.id', '=', runId)
          .where('run.finished_at', 'is', null)
          .where('channel.status', '=', 'active')
          .where('business.status', '=', 'active')
          .forUpdate('run')
          .executeTakeFirst();
        if (run === undefined) return;
        await trx
          .insertInto('messaging.mailbox_check_results')
          .values(
            scored.checks.map((check) => {
              const result = evidence[check.key];
              const details = {
                reason: result.reason,
                ...(result.fix === undefined ? {} : { fix: result.fix }),
              };
              return {
                business_id: businessId,
                run_id: runId,
                check_key: check.key,
                status: check.status,
                points_possible: check.pointsPossible,
                points_awarded: check.pointsAwarded,
                details: sql`${JSON.stringify(details)}::jsonb`,
              };
            }),
          )
          .execute();
        await trx
          .updateTable('messaging.mailbox_check_runs')
          .set({ score: scored.score, finished_at: sql<Date>`now()` })
          .where('id', '=', runId)
          .execute();
        await trx
          .updateTable('messaging.mailboxes')
          .set({ setup_score: scored.score, setup_checked_at: sql<Date>`now()` })
          .where('id', '=', prepared.mailboxId)
          .execute();
        await sql`select pg_notify('crm_business_changed', ${businessId})`.execute(trx);
      });
    },
  });
}
