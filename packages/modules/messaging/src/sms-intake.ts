// Receiving a Twilio webhook, stage one of two (the app can't open the Auth Token, so it
// can't check the signature). The public route calls acceptSmsWebhook, which stores the raw
// request and queues its verification in one statement. "Accepted" means stored and not yet
// verified: the request is not authenticated here, and nothing is believed until the worker
// has checked its signature (sms-callbacks.ts).
import type { Services } from '@repo/commands';
import type { Database, DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';
import * as z from 'zod';

import { FORM_LIMITS } from './twilio-form.js';
import {
  isWebhookToken,
  webhookDigest,
  webhookEndpoint,
  type WebhookEndpoint,
} from './sms-webhook-url.js';

/** The limits the public route must apply; the database function enforces the same. */
export const SMS_WEBHOOK_LIMITS = {
  /** Largest body stored. An inbound SMS is about 30 fields and 1,600 characters. */
  bodyBytes: FORM_LIMITS.bytes,
  headersBytes: 4096,
  /** Requests of one connection waiting for verification. */
  waitingPerConnection: 500,
  /** Requests waiting across the install. */
  waitingInstall: 20_000,
  /** Local CRM admission defaults, not provider quotas. Completed requests count. */
  minutePerConnection: 60,
  minuteInstall: 1000,
  retainedRowsPerConnection: 5000,
  retainedRowsInstall: 100_000,
  retainedBytesPerConnection: 16 * 1024 * 1024,
  retainedBytesInstall: 256 * 1024 * 1024,
  /** Days a verified request is kept, so it can be replayed. */
  retentionDays: 30,
} as const;

// Kept with the raw body: what verification and diagnosis need, and nothing else. No
// cookie, authorization or forwarding header is ever stored.
const KEPT_HEADERS = [
  'x-twilio-signature',
  'i-twilio-idempotency-token',
  'x-home-region',
  'content-type',
  'user-agent',
] as const;

// HMAC-SHA1 in base64 is always 27 characters and "=". A cheap filter, not a check.
const SIGNATURE_SHAPE = /^[A-Za-z0-9+/]{27}=$/;
const MESSAGE_ID = z.uuid();

export interface SmsWebhookRequest {
  /** The token from the URL path. */
  readonly token: string;
  readonly endpoint: WebhookEndpoint;
  /** Lower-case header names, as Node gives them. */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** The raw body, byte for byte. */
  readonly body: Uint8Array;
}

export type SmsWebhookAcceptance =
  /** Stored, not yet verified; its verification is queued. */
  | { readonly outcome: 'accepted'; readonly webhookId: string }
  /** No connection has this token. Nothing was stored. */
  | { readonly outcome: 'unknown' }
  /** Not something Twilio sends (no signature header, too large). Nothing was stored. */
  | { readonly outcome: 'refused' }
  /** Too many requests are waiting for verification. Nothing was stored. */
  | { readonly outcome: 'over_capacity' };

/**
 * The public route's only write. It needs no tenant context and no vault: the token alone
 * names the connection, and the connection names the business.
 */
export async function acceptSmsWebhook(
  db: Database,
  request: SmsWebhookRequest,
): Promise<SmsWebhookAcceptance> {
  if (!isWebhookToken(request.token)) return { outcome: 'unknown' };
  const signature = request.headers['x-twilio-signature'];
  if (
    typeof signature !== 'string' ||
    !SIGNATURE_SHAPE.test(signature) ||
    request.body.byteLength > SMS_WEBHOOK_LIMITS.bodyBytes ||
    (request.endpoint.kind === 'status' &&
      !MESSAGE_ID.safeParse(request.endpoint.messageId).success)
  )
    return { outcome: 'refused' };
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = request.headers[name];
    if (typeof value === 'string') headers[name] = value.slice(0, 512);
  }
  const {
    rows: [row],
  } = await sql<{ outcome: string; webhook_id: string | null }>`
    select outcome, webhook_id from private.accept_sms_webhook(
      ${webhookDigest(request.token)}, ${webhookEndpoint(request.endpoint)},
      ${JSON.stringify(headers)}::jsonb, ${Buffer.from(request.body)})
  `.execute(db);
  if (row?.outcome === 'accepted' && row.webhook_id !== null)
    return { outcome: 'accepted', webhookId: row.webhook_id };
  if (row?.outcome === 'unknown') return { outcome: 'unknown' };
  if (row?.outcome === 'over_capacity') return { outcome: 'over_capacity' };
  return { outcome: 'refused' };
}

/**
 * Queues a stored webhook again, now or after a delay. Applying a stored payload twice
 * changes nothing the second time, so this is safe to call for any webhook of the
 * caller's business. Call inside a tenant transaction.
 */
export async function replaySmsWebhook(
  trx: DatabaseTransaction,
  webhookId: string,
  delaySeconds = 0,
): Promise<void> {
  await sql`
    select private.enqueue_sms_webhook(${z.uuid().parse(webhookId)}::uuid, ${delaySeconds}::integer)
  `.execute(trx);
}

/** Removes stored webhooks past their retention; for the worker's maintenance schedule. */
export async function expireSmsWebhooks(services: Services): Promise<number> {
  const {
    rows: [row],
  } = await sql<{ deleted: number }>`
    select private.expire_sms_webhooks(10000) as deleted
  `.execute(services.db);
  return row?.deleted ?? 0;
}

/** A stored webhook whose signature the worker has verified, locked for this transaction. */
export interface VerifiedSmsWebhook {
  readonly id: string;
  readonly connectionId: string;
  /** The connection's Twilio Account SID. */
  readonly accountSid: string;
  /** Milliseconds since the request was received, by the database's clock. */
  readonly ageMs: number;
}

/**
 * The gate every effect of a webhook passes: the stored row must be this business's and
 * marked verified by the worker. An unverified or refused row gives undefined, and the
 * caller changes nothing. intake.webhooks has no row-level security, so the business is
 * matched here by hand.
 */
export async function verifiedSmsWebhook(
  trx: DatabaseTransaction,
  businessId: string,
  webhookId: string,
): Promise<VerifiedSmsWebhook | undefined> {
  const row = await trx
    .selectFrom('intake.webhooks as webhook')
    .innerJoin('messaging.provider_connections as connection', (join) =>
      join.onRef('connection.id', '=', 'webhook.provider_connection_id'),
    )
    .select([
      'webhook.id',
      'connection.id as connection_id',
      'connection.account_ref',
      sql<number>`(extract(epoch from (clock_timestamp() - webhook.received_at)) * 1000)::float8`.as(
        'age_ms',
      ),
    ])
    .where('webhook.id', '=', webhookId)
    .where('webhook.business_id', '=', businessId)
    .where('connection.business_id', '=', businessId)
    .where('webhook.signature_valid', '=', true)
    .forUpdate('webhook')
    .executeTakeFirst();
  return (
    row && {
      id: row.id,
      connectionId: row.connection_id,
      accountSid: row.account_ref,
      ageMs: row.age_ms,
    }
  );
}

/**
 * Marks a webhook handled, with a short code saying what became of it (never content).
 * The first time stays: applying the same stored payload again leaves the row as it was.
 */
export async function finishSmsWebhook(
  trx: DatabaseTransaction,
  businessId: string,
  webhookId: string,
  note: string | null,
): Promise<void> {
  await trx
    .updateTable('intake.webhooks')
    .set({ processed_at: sql<Date>`now()`, error: note })
    .where('id', '=', webhookId)
    .where('business_id', '=', businessId)
    .where('processed_at', 'is', null)
    .execute();
}
