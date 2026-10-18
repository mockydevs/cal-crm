// Worker task pointing each active voice number on a connected Twilio account at the voice
// webhooks. An install without a public address or with an account not ready for calling does
// nothing; transient errors retry so numbers remain aligned with the account's calling state.
import { defineTask, type Task, type TaskReference } from '@repo/commands';
import { withTenant, type Database, type DatabaseTransaction, type Json } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { SecretUnreadableError, type Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import * as z from 'zod';

import { openSmsCredentials } from '../sms-connect.js';
import type { TwilioCredentials } from '../twilio-api.js';
import { VOICE_SIGNING_KEY } from '../voice-setup.js';
import { configureNumberVoice, type NumberTransport } from './number-provider.js';
import { voiceWebhookUrl } from './voice-url.js';

export const pointVoiceNumbersReference = {
  name: 'messaging.point_voice_numbers',
  data: z.strictObject({ connectionId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

const signingKey = z.strictObject({
  sid: z.string(),
  secret: z.string(),
  type: z.literal('standard'),
});

interface Account {
  readonly credentials: TwilioCredentials;
  readonly webhookToken: string;
}

/** The connection's account, signed with its voice key; null when either can't be opened. */
async function openAccount(
  db: Database,
  vault: Vault,
  context: TenantContext,
  connectionId: string,
): Promise<Account | null> {
  return withTenant(db, context, async (trx) => {
    const row = await trx
      .selectFrom('messaging.provider_connections as connection')
      .innerJoin('messaging.voice_setups as setup', (join) =>
        join
          .onRef('setup.connection_id', '=', 'connection.id')
          .onRef('setup.business_id', '=', 'connection.business_id'),
      )
      .select(['connection.secret_id', 'connection.account_ref', 'setup.secret_id as key_id'])
      .where('connection.id', '=', connectionId)
      .where('connection.status', '=', 'connected')
      .where('setup.status', '=', 'ready')
      .executeTakeFirst();
    const keyId = row?.key_id ?? null;
    if (row === undefined || keyId === null) return null;
    const account = await openSmsCredentials(trx, vault, row.secret_id);
    if (account?.accountSid !== row.account_ref) return null;
    let opened: unknown;
    try {
      opened = JSON.parse(await vault.read(trx, keyId, VOICE_SIGNING_KEY));
    } catch (failure) {
      if (!(failure instanceof SecretUnreadableError || failure instanceof SyntaxError))
        throw failure;
      return null;
    }
    const key = signingKey.safeParse(opened);
    if (!key.success) return null;
    return {
      credentials: {
        accountSid: account.accountSid,
        authToken: account.authToken,
        apiKey: { sid: key.data.sid, secret: key.data.secret },
      },
      webhookToken: account.webhookToken,
    };
  });
}

/**
 * Enqueues pointing the connection's voice numbers at the voice handler.
 */
export async function enqueuePointVoiceNumbers(
  trx: DatabaseTransaction,
  connectionId: string,
): Promise<void> {
  await sql`select private.enqueue_job(${pointVoiceNumbersReference.name}, ${sql<Json>`${JSON.stringify({ connectionId })}::jsonb`}, null::uuid)`.execute(
    trx,
  );
}

/**
 * Updates Twilio for each active voice number on a ready connection so calls route to the
 * voice webhook. Network exchanges run outside of database transactions.
 */
export function createPointVoiceNumbersTask(
  vault: Vault,
  transport: NumberTransport,
  publicUrl: string,
): Task<typeof pointVoiceNumbersReference.data> {
  return defineTask({
    ...pointVoiceNumbersReference,
    async run({ connectionId }, { invocation, services }) {
      const account = await openAccount(services.db, vault, invocation.context, connectionId);
      if (account === null) return;

      const numbers = await withTenant(services.db, invocation.context, (trx) =>
        trx
          .selectFrom('messaging.phone_numbers as number')
          .innerJoin('messaging.channel_accounts as channel', (join) =>
            join
              .onRef('channel.id', '=', 'number.id')
              .onRef('channel.business_id', '=', 'number.business_id'),
          )
          .select('number.provider_number_ref')
          .where('number.provider_connection_id', '=', connectionId)
          .where('channel.status', '=', 'active')
          .where((eb) => eb(eb.val('voice'), '=', eb.fn.any('number.capabilities')))
          .orderBy('number.provider_number_ref')
          .execute(),
      );
      if (numbers.length === 0) return;

      const voiceUrl = voiceWebhookUrl(publicUrl, account.webhookToken, { kind: 'inbound' });
      const statusCallback = voiceWebhookUrl(publicUrl, account.webhookToken, { kind: 'ended' });
      if (voiceUrl === null || statusCallback === null) return;

      let hasUnknown = false;
      for (const number of numbers) {
        const result = await configureNumberVoice(
          transport,
          account.credentials,
          number.provider_number_ref,
          { voiceUrl, statusCallback },
        );
        if (result.outcome === 'unknown') {
          hasUnknown = true;
        }
      }

      if (hasUnknown) {
        throw new Error('Configuring number voice URLs failed on Twilio; the job will retry.');
      }
    },
  });
}
