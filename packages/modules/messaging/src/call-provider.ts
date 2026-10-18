// The worker's port to Twilio for placing and ending calls. Placing rings the person's
// browser first, from the business number; when the browser answers, one <Dial> rings the
// other party, whose leg reports to its own stored leg. Requests are signed with the
// account's Standard key from calling setup. Nothing here decides whether a call may be
// made: the place task has already checked and reserved it.
import { withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { SecretUnreadableError, type Vault } from '@repo/module-vault';
import * as z from 'zod';

import type { CallProvider, CallProviderResult, EndedCall, PlacedCall } from './call-ledger.js';
import { openSmsCredentials } from './sms-connect.js';
import type { TwilioCredentials } from './twilio-api.js';
import {
  createVoiceCall,
  endVoiceCall,
  type VoiceCallResult,
  type VoiceTransport,
} from './voice/twilio-voice.js';
import { renderDial } from './voice/voice-twiml.js';
import { voiceWebhookUrl } from './voice/voice-url.js';
import { VOICE_SIGNING_KEY } from './voice-setup.js';

/** How long the browser, then the other party, ring before the call gives up. */
export const RING_SECONDS = 30;

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
      // Nothing of a failure is passed on: a parse error can quote the decrypted text.
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

const unopened: CallProviderResult = { outcome: 'rejected', code: null };

function asProviderResult(result: VoiceCallResult): CallProviderResult {
  if (result.outcome === 'accepted')
    return { outcome: 'accepted', providerCallId: result.call.sid, status: result.call.status };
  if (result.outcome === 'rejected') return { outcome: 'rejected', code: result.code };
  return { outcome: 'unknown' };
}

export function createTwilioCallProvider(options: {
  readonly db: Database;
  readonly vault: Vault;
  readonly transport: VoiceTransport;
  readonly publicUrl: string;
}): CallProvider {
  const { db, vault, transport, publicUrl } = options;
  return {
    async place(call: PlacedCall, context: TenantContext): Promise<CallProviderResult> {
      const account = await openAccount(db, vault, context, call.connectionId);
      if (account === null) return unopened;
      const url = (kind: 'progress' | 'dial-result', stepId: string) =>
        voiceWebhookUrl(publicUrl, account.webhookToken, { kind, stepId });
      const rootProgress = url('progress', call.legId);
      const remoteProgress = url('progress', call.remoteLegId);
      const dialResult = url('dial-result', call.legId);
      // An install without a public https address can't hear from Twilio, so places nothing.
      if (rootProgress === null || remoteProgress === null || dialResult === null) return unopened;
      const twiml = renderDial({
        destinations: [{ kind: 'number', address: call.to }],
        actionUrl: dialResult,
        progressUrl: remoteProgress,
        timeoutSeconds: RING_SECONDS,
        callerId: call.from,
        recording: { enabled: false },
      });
      return asProviderResult(
        await createVoiceCall(transport, account.credentials, {
          to: `client:${call.identity}`,
          from: call.from,
          twiml,
          statusCallback: rootProgress,
          timeout: RING_SECONDS,
        }),
      );
    },
    async end(call: EndedCall, context: TenantContext): Promise<CallProviderResult> {
      const account = await openAccount(db, vault, context, call.connectionId);
      if (account === null) return unopened;
      return asProviderResult(
        await endVoiceCall(transport, account.credentials, call.providerCallId, call.status),
      );
    },
  };
}
