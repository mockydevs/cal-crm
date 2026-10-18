// IncomingPhoneNumber's final status notification is not a call-progress event.
// https://www.twilio.com/docs/voice/twiml#ending-the-call-callback-requests
import * as z from 'zod';
import type { SignedParams } from '../twilio-signature.js';

const terminal = z.object({
  AccountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
  CallSid: z.string().regex(/^CA[0-9a-fA-F]{32}$/),
  From: z.string().min(1).max(512),
  To: z.string().min(1).max(512),
  Direction: z.literal('inbound'),
  CallStatus: z.enum(['completed', 'busy', 'failed', 'no-answer', 'canceled']),
  CallDuration: z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number)
    .optional(),
});
export interface VoiceTerminal {
  readonly accountSid: string;
  readonly callSid: string;
  readonly from: string;
  readonly to: string;
  readonly direction: 'inbound';
  readonly status: z.output<typeof terminal>['CallStatus'];
  readonly durationSeconds: number | null;
}
/** Called only after canonical URL/signature/account authentication of every parameter. */
export function parseVoiceTerminal(params: SignedParams, accountSid: string): VoiceTerminal | null {
  const parsed = terminal.safeParse(params);
  if (!parsed.success || parsed.data.AccountSid !== accountSid) return null;
  const value = parsed.data;
  return {
    accountSid: value.AccountSid,
    callSid: value.CallSid,
    from: value.From,
    to: value.To,
    direction: value.Direction,
    status: value.CallStatus,
    durationSeconds: value.CallDuration ?? null,
  };
}
