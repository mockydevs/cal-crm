// Twilio's standard TwiML request identity fields (From may be anonymous or client:).
// https://www.twilio.com/docs/voice/twiml#request-parameters
// Recording notifications have AccountSid/CallSid, not the entire TwiML envelope:
// https://www.twilio.com/docs/voice/api/recording#recordingstatuscallback
import * as z from 'zod';
import { parseForm } from '../twilio-form.js';
import { validateSignature, type SignedParams } from '../twilio-signature.js';
import { voiceCallStatuses } from './twilio-voice.js';
import { parseVoiceCallbackPath, voiceWebhookUrl, type VoiceCallbackPath } from './voice-url.js';

const identity = z.object({
  AccountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
  CallSid: z.string().regex(/^CA[0-9a-fA-F]{32}$/),
});
const envelope = identity.extend({
  From: z.string().min(1).max(512),
  To: z.string().min(1).max(512),
  CallStatus: z.enum([...voiceCallStatuses, 'initiated']),
  Direction: z.enum(['inbound', 'outbound-api', 'outbound-dial']),
});
export interface VerifiedVoiceCall {
  readonly accountSid: string;
  readonly callSid: string;
  readonly from?: string;
  readonly to?: string;
  readonly status?: z.infer<typeof envelope>['CallStatus'];
  readonly direction?: z.infer<typeof envelope>['Direction'];
}
export type VoiceRequestVerdict =
  | {
      readonly valid: true;
      readonly target: VoiceCallbackPath;
      readonly call: VerifiedVoiceCall;
      /** Signed, bounded, untrimmed fields. Never log; parse kind-specific fields before use. */
      readonly params: SignedParams;
    }
  | {
      readonly valid: false;
      readonly reason: 'invalid_target' | 'invalid_signature' | 'malformed_body' | 'invalid_call';
    };

/** Secrets and publicUrl come from stored connection/config, never a request header. */
export function verifyVoiceRequest(
  request: {
    readonly path: string;
    readonly body: Uint8Array;
    readonly signature: string | undefined;
  },
  trusted: {
    readonly publicUrl: string;
    readonly webhookToken: string;
    readonly authToken: string;
    readonly accountSid: string;
  },
): VoiceRequestVerdict {
  const target = parseVoiceCallbackPath(request.path);
  if (target?.token !== trusted.webhookToken) return { valid: false, reason: 'invalid_target' };
  const url = voiceWebhookUrl(trusted.publicUrl, trusted.webhookToken, target);
  if (url === null) return { valid: false, reason: 'invalid_target' };
  const params = parseForm(request.body);
  if (params === null) return { valid: false, reason: 'malformed_body' };
  if (
    request.signature === undefined ||
    trusted.authToken === '' ||
    !validateSignature(trusted.authToken, request.signature, url, params)
  )
    return { valid: false, reason: 'invalid_signature' };
  if (target.kind === 'recording') {
    const parsed = identity.safeParse(params);
    if (!parsed.success || parsed.data.AccountSid !== trusted.accountSid)
      return { valid: false, reason: 'invalid_call' };
    return {
      valid: true,
      target,
      params,
      call: { accountSid: parsed.data.AccountSid, callSid: parsed.data.CallSid },
    };
  }
  const parsed = envelope.safeParse(params);
  if (!parsed.success || parsed.data.AccountSid !== trusted.accountSid)
    return { valid: false, reason: 'invalid_call' };
  const call = parsed.data;
  return {
    valid: true,
    target,
    params,
    call: {
      accountSid: call.AccountSid,
      callSid: call.CallSid,
      from: call.From,
      to: call.To,
      status: call.CallStatus,
      direction: call.Direction,
    },
  };
}
