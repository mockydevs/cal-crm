// A provider's update arriving at a connection's address: stored as it came, unverified, with
// its check queued, in one statement (private.accept_integration_webhook). The app cannot open
// the secret it is signed with, so it believes nothing: the worker verifies it (worker.ts)
// before anything acts on it. Only the headers the check needs are kept.
import type { Database } from '@repo/db';
import { sql } from 'kysely';

import type { IntegrationProvider } from './provider.js';
import { sha256Hex } from './rules.js';

/** The most a provider may send in one request, as the database admits it. */
export const INTEGRATION_WEBHOOK_BODY_BYTES = 262_144;

export interface IntegrationWebhookRequest {
  readonly provider: string;
  readonly token: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

export type IntegrationWebhookOutcome = 'accepted' | 'unknown' | 'refused' | 'over_capacity';

/** Stores a provider's update for the worker to verify, or says why it was not stored. */
export async function acceptIntegrationWebhook(
  db: Database,
  providers: readonly IntegrationProvider[],
  request: IntegrationWebhookRequest,
): Promise<IntegrationWebhookOutcome> {
  const provider = providers.find((each) => each.key === request.provider);
  if (provider?.auth !== 'oauth2' || provider.webhook === undefined) return 'unknown';
  if (!/^[A-Za-z0-9_-]{43}$/.test(request.token)) return 'unknown';
  const keep: Record<string, string> = {};
  for (const name of ['content-type', provider.webhook.header.toLowerCase()]) {
    const value = request.headers[name];
    if (typeof value === 'string') keep[name] = value;
  }
  const { rows } = await sql<{
    outcome: IntegrationWebhookOutcome;
  }>`select outcome from private.accept_integration_webhook(${provider.key}, ${sha256Hex(request.token)}, ${JSON.stringify(keep)}::jsonb, ${request.body})`.execute(
    db,
  );
  return rows[0]?.outcome ?? 'unknown';
}
