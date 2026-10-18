import { randomUUID } from 'node:crypto';
import { defineTask, type Services, type Task } from '@repo/commands';
import { connectMailboxInput } from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import type { Mailer, MailboxSender } from '@repo/mail';
import { SecretUnreadableError, type SealingVault, type Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import * as z from 'zod';
import { MAILBOX_CREDENTIALS } from './attempts.js';

const PURPOSE = 'mailbox.install_message';
const message = z.strictObject({
  to: z.email().max(320),
  subject: z.string().max(998),
  text: z.string(),
  html: z.string().optional(),
});
const envelope = z.strictObject({ mailboxId: z.uuid(), message });
const deliveryData = z.strictObject({ messageId: z.uuid() });

/** A UUID selected by the install operator; never accepted from an authentication request. */
export interface InstallMailbox {
  readonly mailboxId: string;
}

async function activeMailbox(trx: DatabaseTransaction, id: string) {
  return trx
    .selectFrom('messaging.mailboxes as mailbox')
    .innerJoin('messaging.channel_accounts as account', (join) =>
      join
        .onRef('account.business_id', '=', 'mailbox.business_id')
        .onRef('account.id', '=', 'mailbox.id'),
    )
    .innerJoin('tenancy.businesses as business', 'business.id', 'mailbox.business_id')
    .select(['mailbox.secret_id', 'mailbox.email_address', 'mailbox.display_name'])
    .where('mailbox.id', '=', id)
    .where('account.status', '=', 'active')
    .where('business.status', '=', 'active')
    .where('mailbox.auth_method', '=', 'password')
    .executeTakeFirst();
}

/** The app seals message bodies, including sign-in tokens, before queuing their identifier. */
export function createQueuedInstallMailer(
  services: Services,
  vault: SealingVault,
  selected: InstallMailbox,
): Mailer {
  return {
    async send(input) {
      const parsed = message.parse(input);
      const {
        rows: [scope],
      } = await sql<{
        agency_id: string;
        business_id: string;
      }>`select * from private.install_mailbox_scope(${selected.mailboxId}::uuid)`.execute(
        services.db,
      );
      if (scope === undefined) throw new Error('The selected install mailbox is not available.');
      await withTenant(
        services.db,
        {
          agencyId: scope.agency_id,
          businessId: scope.business_id,
          actorKind: 'system',
          correlationId: randomUUID(),
        },
        async (trx) => {
          if ((await activeMailbox(trx, selected.mailboxId)) === undefined)
            throw new Error('The selected install mailbox is not available.');
          const messageId = await vault.store(
            trx,
            { agencyId: scope.agency_id, businessId: scope.business_id, purpose: PURPOSE },
            JSON.stringify({ mailboxId: selected.mailboxId, message: parsed }),
          );
          await sql`select private.enqueue_job('mailboxes.send_install', ${JSON.stringify({ messageId })}::jsonb, null::uuid)`.execute(
            trx,
          );
        },
      );
    },
    close() {
      /* Each queued delivery owns and closes its worker-side transport. */
    },
  };
}

export function createSendInstallMailTask(
  vault: Vault,
  sender: MailboxSender,
): Task<typeof deliveryData> {
  return defineTask({
    name: 'mailboxes.send_install',
    data: deliveryData,
    async run({ messageId }, { invocation, services }) {
      const prepared = await withTenant(services.db, invocation.context, async (trx) => {
        const stored = await trx
          .selectFrom('vault.secrets')
          .select(sql<boolean>`created_at <= now() - interval '10 minutes'`.as('expired'))
          .where('id', '=', messageId)
          .where('purpose', '=', PURPOSE)
          .forUpdate()
          .executeTakeFirst();
        if (stored === undefined) return null;
        if (stored.expired) {
          await vault.remove(trx, messageId);
          return null;
        }
        let pending: z.output<typeof envelope>;
        try {
          pending = envelope.parse(JSON.parse(await vault.read(trx, messageId, PURPOSE)));
        } catch (error) {
          if (!(
            error instanceof SecretUnreadableError ||
            error instanceof z.ZodError ||
            error instanceof SyntaxError
          ))
            throw error;
          await vault.remove(trx, messageId);
          return null;
        }
        const mailbox = await activeMailbox(trx, pending.mailboxId);
        if (mailbox === undefined) {
          await vault.remove(trx, messageId);
          return null;
        }
        const credentials = await vault
          .read(trx, mailbox.secret_id, MAILBOX_CREDENTIALS)
          .then((plaintext) => connectMailboxInput.parse(JSON.parse(plaintext)))
          .catch(() => {
            throw new Error(
              'Install mail credentials are unavailable; the queued message will retry.',
            );
          });
        const { html, ...body } = pending.message;
        return {
          input: credentials.smtp,
          from: { address: mailbox.email_address, name: mailbox.display_name },
          message: { ...body, ...(html === undefined ? {} : { html }) },
        };
      });
      if (prepared === null) return;
      try {
        await sender.send(prepared.input, prepared.from, prepared.message);
      } catch {
        throw new Error('Install mail delivery failed; the queued message will retry.');
      }
      await withTenant(services.db, invocation.context, (trx) => vault.remove(trx, messageId));
    },
  });
}
