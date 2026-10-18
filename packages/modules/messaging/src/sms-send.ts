// Sending SMS through the existing outbound pipeline (outbound.ts), unchanged: this file
// only supplies the SMS half of its two ports. Policy (consent, suppressions, quiet hours,
// frequency) and the reservation that prevents a second send stay where they are.
import { withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import type { Vault } from '@repo/module-vault';
import { sql } from 'kysely';

import type { OutboundAdmission, OutboundChannel, OutboundSender } from './outbound.js';
export type { OutboundChannel } from './outbound.js';
import { openSmsCredentials } from './sms-connect.js';
import { smsWebhookOrigin, statusCallbackUrl } from './sms-webhook-url.js';
import {
  createMessage,
  type CreateMessageOptions,
  type CreateMessageResult,
  type TwilioTransport,
} from './twilio-api.js';
import { isOutboundStatus, statusRank, type OutboundSmsStatus } from './twilio-status.js';

/**
 * Twilio: a Body "can be up to 1,600 characters". Twilio doesn't say how it counts, so
 * UTF-16 units are counted here, which is never fewer than its characters.
 */
export const SMS_BODY_MAX = 1600;

export interface SmsAdmissionFacts {
  readonly channel: string;
  /** Whether PUBLIC_URL gives Twilio an address it can report statuses to. */
  readonly callbackAvailable: boolean;
  readonly bodyLength: number;
  /** The sending number, or null when the account isn't a registered number. */
  readonly number: {
    readonly capabilities: readonly string[];
    readonly connectionStatus: string;
  } | null;
}
export type SmsAdmissionRefusal =
  | 'unsupported_channel'
  | 'status_callback_unavailable'
  | 'sms_body_too_long'
  | 'sms_number_unavailable'
  | 'sms_connection_unavailable';

/** Why an SMS can't be handed to Twilio at all, or null when it can. */
export function evaluateSmsAdmission(facts: SmsAdmissionFacts): SmsAdmissionRefusal | null {
  if (facts.channel !== 'sms') return 'unsupported_channel';
  // Without a callback an ambiguous send could never be settled, nor a delivery reported.
  if (!facts.callbackAvailable) return 'status_callback_unavailable';
  if (facts.bodyLength > SMS_BODY_MAX) return 'sms_body_too_long';
  if (!facts.number?.capabilities.includes('sms')) return 'sms_number_unavailable';
  if (facts.number.connectionStatus !== 'connected') return 'sms_connection_unavailable';
  return null;
}

/**
 * One sender and one admission for the single dispatch task, each message going to its
 * own channel's pair. A channel without a pair is refused before any reservation.
 */
export function routeOutboundByChannel(
  channels: Readonly<Partial<Record<'email' | 'sms', OutboundChannel>>>,
): OutboundChannel {
  return {
    admission: (trx, context, message) =>
      channels[message.channel]?.admission(trx, context, message) ??
      Promise.resolve({ action: 'refuse', reason: 'unsupported_channel' }),
    sender: {
      deliver: (message, context) =>
        channels[message.channel]?.sender.deliver(message, context) ??
        Promise.resolve({ outcome: 'rejected' }),
    },
  };
}

/**
 * Records what the provider said about a message, only if that is further along than what
 * is already recorded. The comparison is in the statement itself, so a late or repeated
 * report can't move a message backwards whatever order two writers run in.
 */
export async function recordSmsDelivery(
  trx: DatabaseTransaction,
  businessId: string,
  messageId: string,
  delivery: {
    readonly status: OutboundSmsStatus;
    readonly errorCode?: number | null;
    readonly segments?: number | null;
  },
): Promise<boolean> {
  const rank = statusRank(delivery.status);
  const row = await trx
    .insertInto('messaging.sms_deliveries')
    .values({
      business_id: businessId,
      message_id: messageId,
      provider_status: delivery.status,
      status_rank: rank,
      provider_error_code: delivery.errorCode ?? null,
      segments: delivery.segments ?? null,
    })
    .onConflict((oc) =>
      oc
        .columns(['business_id', 'message_id'])
        .doUpdateSet((eb) => ({
          provider_status: eb.ref('excluded.provider_status'),
          status_rank: eb.ref('excluded.status_rank'),
          provider_error_code: eb.ref('excluded.provider_error_code'),
          segments: sql<
            number | null
          >`coalesce(excluded.segments, messaging.sms_deliveries.segments)`,
          status_changed_at: sql<Date>`now()`,
        }))
        .where('messaging.sms_deliveries.status_rank', '<', rank),
    )
    .returning('message_id')
    .executeTakeFirst();
  return row !== undefined;
}

export interface TwilioOutboundOptions {
  /** For tests: how the bounded retry of an HTTP 429 waits. */
  readonly create?: CreateMessageOptions;
}

/**
 * Worker-only. The Auth Token and API key never enter a job, an error or a log: they are
 * opened in a short transaction and used for the one request.
 *
 * What the three outcomes mean for an SMS:
 * - accepted: Twilio answered with the SID of a message it created;
 * - rejected: Twilio answered that it created nothing, or nothing was sent at all;
 * - unknown: no readable answer (a timeout, a 5xx, a cut connection). Twilio may have
 *   created the message, and it has no idempotency key, so the message is never sent
 *   again automatically. Its status callback, which carries our message id, settles it.
 */
export function createTwilioOutbound(
  vault: Vault,
  transport: TwilioTransport,
  db: Database,
  publicUrl: string,
  options: TwilioOutboundOptions = {},
): OutboundChannel {
  const origin = smsWebhookOrigin(publicUrl);
  const numberOf = (trx: DatabaseTransaction, accountId: string) =>
    trx
      .selectFrom('messaging.phone_numbers as number')
      .innerJoin('messaging.provider_connections as connection', (join) =>
        join
          .onRef('connection.id', '=', 'number.provider_connection_id')
          // The number's own business must own the connection it names.
          .onRef('connection.business_id', '=', 'number.business_id'),
      )
      .select([
        'number.e164',
        'number.capabilities',
        'connection.status',
        'connection.account_ref',
        'connection.secret_id',
      ])
      .where('number.id', '=', accountId)
      .where('connection.provider', '=', 'twilio')
      .executeTakeFirst();

  const admission: OutboundAdmission = async (trx, _context, message) => {
    const number = message.channel === 'sms' ? await numberOf(trx, message.accountId) : undefined;
    const refusal = evaluateSmsAdmission({
      channel: message.channel,
      callbackAvailable: origin !== null,
      bodyLength: message.text.length,
      number:
        number === undefined
          ? null
          : { capabilities: number.capabilities, connectionStatus: number.status },
    });
    return refusal === null ? { action: 'allow' } : { action: 'refuse', reason: refusal };
  };

  const sender: OutboundSender = {
    async deliver(message, context) {
      if (message.channel !== 'sms' || origin === null) return { outcome: 'rejected' };
      const prepared = await withTenant(db, context, async (trx) => {
        const number = await numberOf(trx, message.accountId);
        if (number?.status !== 'connected') return null;
        const credentials = await openSmsCredentials(trx, vault, number.secret_id);
        if (credentials?.accountSid !== number.account_ref) return null;
        return { from: number.e164, credentials };
      });
      // Nothing was sent: the number, its connection or its credentials are gone.
      if (prepared === null) return { outcome: 'rejected' };
      const result: CreateMessageResult = await createMessage(
        transport,
        prepared.credentials,
        {
          to: message.to,
          from: prepared.from,
          body: message.text,
          statusCallback: statusCallbackUrl(
            origin,
            prepared.credentials.webhookToken,
            message.messageId,
          ),
        },
        options.create,
      );
      if (result.outcome === 'unknown') return { outcome: 'unknown' };
      const businessId = context.businessId;
      try {
        if (businessId !== undefined)
          await withTenant(db, context, (trx) =>
            recordSmsDelivery(
              trx,
              businessId,
              message.messageId,
              result.outcome === 'accepted'
                ? {
                    // Twilio's first status without a Messaging Service is "queued".
                    status:
                      result.status !== null && isOutboundStatus(result.status)
                        ? result.status
                        : 'queued',
                    segments: result.segments,
                  }
                : { status: 'rejected', errorCode: result.code },
            ),
          );
      } catch {
        // Twilio's answer stands whether or not its detail could be recorded; throwing
        // here would turn an accepted send into an unknown one.
      }
      return result.outcome === 'accepted'
        ? { outcome: 'accepted', providerId: result.sid }
        : { outcome: 'rejected' };
    },
  };
  return { sender, admission };
}
