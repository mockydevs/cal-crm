// https://www.twilio.com/docs/voice/api/call-resource#statuscallback
// Progress callbacks include initiated (unlike the REST Call resource enum), and
// CallDuration is seconds; Duration is billing minutes. Never interchange them.
import * as z from 'zod';

import { parseForm } from '../twilio-form.js';
import { validateSignature, type SignedParams } from '../twilio-signature.js';
import { voiceCallStatuses } from './twilio-voice.js';

const callSid = z.string().regex(/^CA[0-9a-fA-F]{32}$/);
const integer = z
  .string()
  .regex(/^\d{1,9}$/)
  .transform(Number);
const progressBody = z.object({
  AccountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
  CallSid: callSid,
  ParentCallSid: callSid.optional(),
  CallStatus: z.enum([...voiceCallStatuses, 'initiated']),
  From: z.string().min(1).max(512),
  To: z.string().min(1).max(512),
  Direction: z.enum(['inbound', 'outbound-api', 'outbound-dial']),
  CallbackSource: z.literal('call-progress-events'),
  SequenceNumber: integer,
  CallDuration: integer.optional(),
});

export interface VoiceProgress {
  readonly accountSid: string;
  readonly callSid: string;
  readonly parentSid: string | null;
  readonly status: (typeof voiceCallStatuses)[number] | 'initiated';
  readonly from: string;
  readonly to: string;
  readonly direction: 'inbound' | 'outbound-api' | 'outbound-dial';
  readonly sequence: number;
  readonly durationSeconds: number | null;
}

export type VoiceProgressVerdict =
  | { readonly valid: true; readonly progress: VoiceProgress }
  | {
      readonly valid: false;
      readonly reason: 'malformed_body' | 'invalid_signature' | 'malformed_progress';
    };

/** trusted.url must come from stored endpoint/configuration, never forwarded headers. */
export function verifyVoiceProgress(
  body: Uint8Array,
  signature: string | undefined,
  trusted: { readonly authToken: string; readonly url: string; readonly accountSid: string },
): VoiceProgressVerdict {
  const params = parseForm(body);
  if (params === null) return { valid: false, reason: 'malformed_body' };
  try {
    if (
      signature === undefined ||
      trusted.authToken === '' ||
      !validateSignature(trusted.authToken, signature, trusted.url, params)
    )
      return { valid: false, reason: 'invalid_signature' };
  } catch {
    return { valid: false, reason: 'invalid_signature' };
  }
  // Unknown fields remain signed, but are not persisted. Arrays for duplicated
  // known fields fail their scalar schema, even if the duplicate was signed.
  const progress = parseVoiceProgress(params, trusted.accountSid);
  return progress === null
    ? { valid: false, reason: 'malformed_progress' }
    : { valid: true, progress };
}

/** For the worker after canonical request signature/account verification. */
export function parseVoiceProgress(params: SignedParams, accountSid: string): VoiceProgress | null {
  const parsed = progressBody.safeParse(params);
  if (!parsed.success || parsed.data.AccountSid !== accountSid) return null;
  const value = parsed.data;
  return {
    accountSid: value.AccountSid,
    callSid: value.CallSid,
    parentSid: value.ParentCallSid ?? null,
    status: value.CallStatus,
    from: value.From,
    to: value.To,
    direction: value.Direction,
    sequence: value.SequenceNumber,
    durationSeconds: value.CallDuration ?? null,
  };
}

const rank: Readonly<Record<VoiceProgress['status'], number>> = {
  queued: 0,
  initiated: 1,
  ringing: 2,
  'in-progress': 3,
  completed: 4,
  busy: 4,
  failed: 4,
  'no-answer': 4,
  canceled: 4,
};
export type VoiceProgressState = Pick<
  VoiceProgress,
  'accountSid' | 'callSid' | 'status' | 'sequence'
>;

/** Caller applies this while holding the call row lock; conflicts need reconciliation. */
export function advanceVoiceProgress(
  current: VoiceProgressState | null,
  incoming: VoiceProgress,
): 'advance' | 'ignore' | 'conflict' {
  if (current === null) return 'advance';
  if (current.callSid !== incoming.callSid || current.accountSid !== incoming.accountSid)
    return 'conflict';
  if (incoming.sequence < current.sequence) return 'ignore';
  if (incoming.sequence === current.sequence)
    return incoming.status === current.status ? 'ignore' : 'conflict';
  if (
    rank[current.status] === 4 &&
    rank[incoming.status] === 4 &&
    current.status !== incoming.status
  )
    return 'conflict';
  if (rank[incoming.status] < rank[current.status]) return 'ignore';
  return 'advance';
}
