// Stage two of a Twilio webhook, in the worker: verify the stored request's signature
// with the connection's Auth Token, and only then apply it. A request whose signature is
// wrong changes nothing at all: not a message, not a consent, and not the connection
// (someone who learned a webhook URL can forge as many bad requests as they like, so a
// bad signature is never a reason to mark a connection as failing).
import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type Command,
  type Task,
  type TaskReference,
} from '@repo/commands';
import { withTenant } from '@repo/db';
import { ForbiddenError } from '@repo/kernel';
import type { Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import * as z from 'zod';

import { openSmsCredentials } from './sms-connect.js';
import { receiveSmsCommand } from './sms-inbound.js';
import { finishSmsWebhook, replaySmsWebhook, verifiedSmsWebhook } from './sms-intake.js';
import { recordSmsDelivery } from './sms-send.js';
import { smsWebhookOrigin } from './sms-webhook-url.js';
import { inboundSmsOf, statusCallbackOf, verifySmsWebhook } from './sms-webhook-verify.js';
import {
  advanceStatus,
  isOutboundStatus,
  isTwilioStatus,
  messageStatusOf,
  type SmsDeliveryStatus,
} from './twilio-status.js';

export const applySmsWebhookReference = {
  name: 'sms.apply_webhook',
  data: z.strictObject({ webhookId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

/**
 * How long a status callback waits for the send it reports to finish being recorded.
 * The dispatcher records its answer in a separate transaction. Give that transaction
 * time to settle the provider SID before applying an early callback. A send has a
 * 15-second request deadline; after two minutes apply the callback even if dispatch
 * never returned. The dispatch writer also preserves any later delivery status.
 */
export const DISPATCH_WAIT_MS = 120_000;
const RETRY_SECONDS = 5;

const statusInput = z.strictObject({
  webhookId: z.uuid(),
  messageId: z.uuid(),
  accountSid: z.string(),
  messageSid: z.string(),
  status: z.string().min(1).max(40),
  errorCode: z.number().int().positive().nullable(),
});

function floorOf(messageStatus: string): SmsDeliveryStatus | null {
  if (messageStatus === 'delivered' || messageStatus === 'read') return messageStatus;
  if (messageStatus === 'failed') return 'rejected';
  return messageStatus === 'sent' ? 'queued' : null;
}

export type ApplySmsStatusOutcome =
  /** The message moved forward. */
  | 'applied'
  /** Late, repeated, or nothing new: the message is already at or past this status. */
  | 'unchanged'
  /** It contradicts a final status already recorded; the first one is kept. */
  | 'conflict'
  /** The send it reports is still being recorded; try again shortly. */
  | 'wait'
  /** Not verified, or not about a message this connection sent. Nothing changed. */
  | 'ignored';

/**
 * Applies one verified status callback. Only the worker's system actor runs it. A message
 * only moves forward (twilio-status.ts), so the callbacks of one message give the same
 * end state in whatever order, and however many times, they arrive.
 */
export const applySmsStatusCommand: Command<typeof statusInput, ApplySmsStatusOutcome> =
  defineCommand({
    name: 'sms.apply_status',
    permission: 'sms.manage',
    input: statusInput,
    // Identifiers only: no number and no text reaches the audit log.
    audit: ({ webhookId, messageId }) => ({ webhookId, messageId }),
    async handle(trx, input, command): Promise<ApplySmsStatusOutcome> {
      if (command.context.actorKind !== 'system')
        throw new ForbiddenError('Only the SMS worker applies delivery statuses.');
      const businessId = requireBusiness(command.context);
      // Dispatch takes the business before the message. Match that order before the
      // callback's event/audit foreign keys acquire their business lock.
      await trx
        .selectFrom('tenancy.businesses')
        .select('id')
        .where('id', '=', businessId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const webhook = await verifiedSmsWebhook(trx, businessId, input.webhookId);
      if (webhook === undefined) return 'ignored';
      const ignore = async (note: string): Promise<'ignored'> => {
        await finishSmsWebhook(trx, businessId, webhook.id, note);
        return 'ignored';
      };
      // Signed by this connection's token, but naming another account: not ours to believe.
      if (input.accountSid !== webhook.accountSid) return ignore('account_mismatch');
      const { status } = input;
      if (!isTwilioStatus(status) || !isOutboundStatus(status)) return ignore('status_not_used');

      const message = await trx
        .selectFrom('messaging.messages as m')
        .innerJoin('messaging.outbound_dispatch as d', (join) =>
          join.onRef('d.business_id', '=', 'm.business_id').onRef('d.id', '=', 'm.id'),
        )
        .innerJoin('messaging.phone_numbers as number', (join) =>
          join
            .onRef('number.business_id', '=', 'm.business_id')
            .onRef('number.id', '=', 'm.channel_account_id'),
        )
        .innerJoin('messaging.conversations as v', (join) =>
          join.onRef('v.business_id', '=', 'm.business_id').onRef('v.id', '=', 'm.conversation_id'),
        )
        .select([
          'm.id',
          'm.status',
          'm.provider_message_id',
          'd.reserved_at',
          'd.finished_at',
          'v.contact_id',
        ])
        .where('m.business_id', '=', businessId)
        .where('m.id', '=', input.messageId)
        .where('m.channel', '=', 'sms')
        .where('m.direction', '=', 'outbound')
        // The message must have been sent from a number of the connection that signed this.
        .where('number.provider_connection_id', '=', webhook.connectionId)
        .forUpdate('m')
        .executeTakeFirst();
      if (message === undefined) return ignore('message_not_found');
      // Never handed to Twilio: no genuine callback can be about it.
      if (message.reserved_at === null) return ignore('message_not_sent');
      if (message.provider_message_id !== null && message.provider_message_id !== input.messageSid)
        return ignore('sid_mismatch');
      if (
        message.status === 'sending' &&
        message.finished_at === null &&
        webhook.ageMs < DISPATCH_WAIT_MS
      )
        return 'wait';

      const delivery = await trx
        .selectFrom('messaging.sms_deliveries')
        .select('provider_status')
        .where('message_id', '=', message.id)
        .forUpdate()
        .executeTakeFirst();
      const current = z
        .custom<SmsDeliveryStatus>(
          (value) => typeof value === 'string' && (value === 'rejected' || isTwilioStatus(value)),
        )
        .nullable()
        // Without a delivery row, the message's own status is the least it has reached.
        .parse(delivery?.provider_status ?? floorOf(message.status));
      const decision = advanceStatus(current, status);
      if (decision === 'conflict') {
        await trx
          .updateTable('messaging.sms_deliveries')
          .set((eb) => ({ conflicts: eb('conflicts', '+', 1) }))
          .where('message_id', '=', message.id)
          .execute();
        await finishSmsWebhook(trx, businessId, webhook.id, 'conflict');
        return 'conflict';
      }
      if (decision === 'ignore') {
        await finishSmsWebhook(trx, businessId, webhook.id, null);
        return 'unchanged';
      }

      await recordSmsDelivery(trx, businessId, message.id, { status, errorCode: input.errorCode });
      const next = messageStatusOf(status) ?? 'sent';
      await trx
        .updateTable('messaging.messages')
        .set({
          status: next,
          // A signed callback is the first proof of the SID for a send whose answer was lost.
          provider_message_id: input.messageSid,
          sent_at: sql<Date>`coalesce(sent_at, now())`,
          ...(next === 'delivered'
            ? { delivered_at: sql<Date>`coalesce(delivered_at, now())` }
            : {}),
          ...(next === 'read' ? { read_at: sql<Date>`coalesce(read_at, now())` } : {}),
          ...(next === 'failed'
            ? {
                failed_at: sql<Date>`coalesce(failed_at, now())`,
                error_code:
                  input.errorCode === null
                    ? 'provider_failed'
                    : `twilio_${String(input.errorCode)}`,
                // Twilio's own word: undelivered, failed or canceled.
                error_detail: status,
              }
            : { error_code: null, error_detail: null }),
        })
        .where('id', '=', message.id)
        .execute();
      // The dispatcher never recorded an end (it crashed, or its answer was lost). This is
      // the end: a later run of its job must not put the message back to "unknown".
      if (message.finished_at === null)
        await trx
          .updateTable('messaging.outbound_dispatch')
          .set({ finished_at: sql<Date>`now()` })
          .where('id', '=', message.id)
          .execute();
      if (next !== message.status && next !== 'sent')
        await command.emit({
          type: `message.${next}`,
          subject: { kind: 'message', id: message.id },
          payload:
            next === 'failed'
              ? { channel: 'sms', providerStatus: status, providerErrorCode: input.errorCode }
              : { channel: 'sms' },
          records: [message.contact_id],
        });
      await finishSmsWebhook(trx, businessId, webhook.id, null);
      await sql`select pg_notify('crm_business_changed', ${businessId})`.execute(trx);
      return 'applied';
    },
  });

/** What became of one stored webhook, for a counter. Never carries content. */
export type SmsWebhookResult =
  'invalid_signature' | 'unavailable' | 'unreadable' | 'waiting' | 'applied' | 'unchanged';

export interface ApplySmsWebhookOptions {
  /** Called once per run with the result: the place to count invalid signatures. */
  readonly onResult?: (result: SmsWebhookResult) => void;
}

/**
 * Verifies a stored Twilio webhook and applies it. Only the worker gets a vault that can
 * open the Auth Token. Running it again for the same stored webhook is safe: the second
 * run changes nothing.
 */
export function createApplySmsWebhookTask(
  vault: Vault,
  publicUrl: string,
  options: ApplySmsWebhookOptions = {},
): Task<typeof applySmsWebhookReference.data> {
  const origin = smsWebhookOrigin(publicUrl);
  return defineTask({
    ...applySmsWebhookReference,
    async run({ webhookId }, { invocation, services }) {
      const businessId = requireBusiness(invocation.context);
      const report = (result: SmsWebhookResult) => {
        options.onResult?.(result);
      };
      const verdict = await withTenant(services.db, invocation.context, async (trx) => {
        const stored = await trx
          .selectFrom('intake.webhooks as webhook')
          .innerJoin('messaging.provider_connections as connection', (join) =>
            join.onRef('connection.id', '=', 'webhook.provider_connection_id'),
          )
          .select(['webhook.endpoint', 'webhook.headers', 'webhook.body', 'connection.secret_id'])
          .where('webhook.id', '=', webhookId)
          // No row-level security on intake: the job's own business is matched by hand.
          .where('webhook.business_id', '=', businessId)
          .where('connection.business_id', '=', businessId)
          .where('connection.status', '<>', 'disconnected')
          .forUpdate('webhook')
          .executeTakeFirst();
        if (stored === undefined || origin === null) return 'unavailable' as const;
        const credentials = await openSmsCredentials(trx, vault, stored.secret_id);
        if (credentials === null) return 'unavailable' as const;
        const checked = verifySmsWebhook(stored, credentials, origin);
        // The verdict is written before anything acts on it, and a bad one ends here.
        await trx
          .updateTable('intake.webhooks')
          .set(
            checked.valid
              ? { signature_valid: true }
              : {
                  signature_valid: false,
                  processed_at: sql<Date>`coalesce(processed_at, now())`,
                  error: checked.reason,
                },
          )
          .where('id', '=', webhookId)
          .where('business_id', '=', businessId)
          .execute();
        return checked;
      });
      if (verdict === 'unavailable') {
        report('unavailable');
        return;
      }
      if (!verdict.valid) {
        report(verdict.reason === 'invalid_signature' ? 'invalid_signature' : 'unreadable');
        return;
      }

      const finish = (note: string) =>
        withTenant(services.db, invocation.context, (trx) =>
          finishSmsWebhook(trx, businessId, webhookId, note),
        );
      if (verdict.endpoint.kind === 'status') {
        const callback = statusCallbackOf(verdict.params);
        if (callback === null) {
          await finish('unreadable');
          report('unreadable');
          return;
        }
        const outcome = await runCommand(
          services,
          applySmsStatusCommand,
          { webhookId, messageId: verdict.endpoint.messageId, ...callback },
          invocation,
        );
        if (outcome === 'wait') {
          await withTenant(services.db, invocation.context, (trx) =>
            replaySmsWebhook(trx, webhookId, RETRY_SECONDS),
          );
          report('waiting');
        } else report(outcome === 'applied' ? 'applied' : 'unchanged');
        return;
      }
      const inbound = inboundSmsOf(verdict.params);
      if (inbound === null) {
        await finish('unreadable');
        report('unreadable');
        return;
      }
      const received = await runCommand(
        services,
        receiveSmsCommand,
        { webhookId, ...inbound },
        invocation,
      );
      report(received.outcome === 'stored' ? 'applied' : 'unchanged');
    },
  });
}
