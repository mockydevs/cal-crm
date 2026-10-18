import { randomUUID } from 'node:crypto';
import { withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import type { Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import { openSmsCredentials } from '../sms-connect.js';
import { webhookDigest } from '../sms-webhook-url.js';
import { verifyVoiceRequest, type VoiceRequestVerdict } from './voice-request.js';
import { parseVoiceCallbackPath } from './voice-url.js';

export type AuthenticatedVoiceCallback =
  | { readonly outcome: 'refused'; readonly statusCode: 400 | 403 | 404 | 503 }
  | {
      readonly outcome: 'authenticated';
      readonly context: TenantContext;
      readonly connectionId: string;
      readonly verified: Extract<VoiceRequestVerdict, { valid: true }>;
    };

/**
 * Worker-only. Resolving a capability grants no mutation: the tenant-scoped vault
 * read and full signature/account check must succeed before a call handler runs.
 * Returned values contain no decrypted credentials. Handlers must recheck connection,
 * number and member state under their call lock before committing instructions.
 */
export async function authenticateVoiceCallback(
  db: Database,
  vault: Vault,
  publicUrl: string,
  request: Parameters<typeof verifyVoiceRequest>[0],
): Promise<AuthenticatedVoiceCallback> {
  const target = parseVoiceCallbackPath(request.path);
  if (target === null || request.body.byteLength > 65_536)
    return { outcome: 'refused', statusCode: 400 };
  if (request.signature === undefined || request.signature === '' || request.signature.length > 512)
    return { outcome: 'refused', statusCode: 403 };
  const {
    rows: [resolved],
  } = await sql<{
    agency_id: string;
    business_id: string;
    connection_id: string;
  }>`select * from private.resolve_voice_callback(${webhookDigest(target.token)})`.execute(db);
  if (resolved === undefined) return { outcome: 'refused', statusCode: 404 };
  const context: TenantContext = {
    agencyId: resolved.agency_id,
    businessId: resolved.business_id,
    actorKind: 'system',
    correlationId: randomUUID(),
  };
  return withTenant(db, context, async (trx): Promise<AuthenticatedVoiceCallback> => {
    const connection = await trx
      .selectFrom('messaging.provider_connections as c')
      .innerJoin('tenancy.businesses as b', 'b.id', 'c.business_id')
      .select(['c.secret_id', 'c.account_ref'])
      .where('c.id', '=', resolved.connection_id)
      .where('c.business_id', '=', resolved.business_id)
      .where('c.agency_id', '=', resolved.agency_id)
      .where('c.webhook_digest', '=', webhookDigest(target.token))
      .where('c.provider', '=', 'twilio')
      .where('c.status', '=', 'connected')
      .where('b.status', '=', 'active')
      .executeTakeFirst();
    if (connection === undefined) return { outcome: 'refused', statusCode: 404 };
    const credentials = await openSmsCredentials(trx, vault, connection.secret_id);
    if (credentials?.accountSid !== connection.account_ref)
      return { outcome: 'refused', statusCode: 503 };
    const verified = verifyVoiceRequest(request, { ...credentials, publicUrl });
    if (!verified.valid) return { outcome: 'refused', statusCode: 403 };
    return { outcome: 'authenticated', context, connectionId: resolved.connection_id, verified };
  });
}
