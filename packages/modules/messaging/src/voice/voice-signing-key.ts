// v2010 creates Standard keys only; v1's Restricted keys cannot sign Voice access tokens.
// The secret is returned once. A lost answer needs operator reconciliation, never retry.
// https://www.twilio.com/docs/iam/api-keys/key-resource-v2010#create-a-new-api-key
import * as z from 'zod';
import type { TwilioCredentials, TwilioResponse } from '../twilio-api.js';
import type { VoiceTransport } from './twilio-voice.js';

const ACCOUNT = /^AC[0-9a-fA-F]{32}$/;
const KEY = /^SK[0-9a-fA-F]{32}$/;
const key = z.object({
  sid: z.string().regex(KEY),
  secret: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\p{Cc}\s]+$/u),
});
const code = z.object({ code: z.int().positive() });
type Failure =
  { readonly outcome: 'rejected'; readonly code: number | null } | { readonly outcome: 'unknown' };
export type VoiceSigningKeyResult =
  | Failure
  | {
      readonly outcome: 'created';
      /** Worker-only, seal at once. Never return through API or put in logs/audit/events. */
      readonly key: { readonly sid: string; readonly secret: string; readonly type: 'standard' };
    };
const rejected = (): Failure => ({ outcome: 'rejected', code: null });
const json = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};
const refusal = (response: TwilioResponse): Failure => {
  const parsed = code.safeParse(json(response.body));
  return { outcome: 'rejected', code: parsed.success ? parsed.data.code : null };
};

async function exchange(
  transport: VoiceTransport,
  credentials: TwilioCredentials,
  method: 'POST' | 'DELETE',
  suffix: string,
): Promise<TwilioResponse | null> {
  try {
    return await transport({
      method,
      path: `/2010-04-01/Accounts/${credentials.accountSid}/Keys${suffix}`,
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString('base64')}`,
      },
      ...(method === 'POST'
        ? { body: new URLSearchParams({ FriendlyName: 'CRM browser calling' }).toString() }
        : {}),
    });
  } catch {
    return null;
  }
}

/** Invoke only after an authorized, durable one-time setup reservation. */
export async function createVoiceSigningKey(
  transport: VoiceTransport,
  credentials: TwilioCredentials,
): Promise<VoiceSigningKeyResult> {
  if (!ACCOUNT.test(credentials.accountSid) || credentials.authToken === '') return rejected();
  const response = await exchange(transport, credentials, 'POST', '.json');
  if (response === null || response.status < 200 || response.status >= 500)
    return { outcome: 'unknown' };
  if (response.status >= 400) return refusal(response);
  if (response.status >= 300) return { outcome: 'unknown' };
  const parsed = key.safeParse(json(response.body));
  return parsed.success
    ? { outcome: 'created', key: { ...parsed.data, type: 'standard' } }
    : { outcome: 'unknown' };
}

export async function revokeVoiceSigningKey(
  transport: VoiceTransport,
  credentials: TwilioCredentials,
  sid: string,
): Promise<Failure | { readonly outcome: 'revoked' }> {
  if (!ACCOUNT.test(credentials.accountSid) || credentials.authToken === '' || !KEY.test(sid))
    return rejected();
  const response = await exchange(transport, credentials, 'DELETE', `/${sid}.json`);
  if (response === null) return { outcome: 'unknown' };
  if (response.status === 204 || response.status === 404) return { outcome: 'revoked' };
  if (response.status >= 400 && response.status < 500) return refusal(response);
  return { outcome: 'unknown' };
}
