// Provider contract: https://www.twilio.com/docs/voice/api/call-resource
// Form names/statuses also checked against installed twilio@6.1.2 call.js/call.d.ts.
// This transport is separate from SMS's deliberately smaller request allowlist.
import * as z from 'zod';

import type {
  TwilioCredentials,
  TwilioRequest,
  TwilioResponse,
  TwilioTransport,
} from '../twilio-api.js';

const ACCOUNT = /^AC[0-9a-fA-F]{32}$/;
const CALL = /^CA[0-9a-fA-F]{32}$/;
const callPath = '/2010-04-01/Accounts/AC[0-9a-fA-F]{32}/Calls';
const createPath = new RegExp(`^${callPath}\\.json$`);
const instancePath = new RegExp(`^${callPath}/CA[0-9a-fA-F]{32}\\.json$`);
const keyCollection = /^\/2010-04-01\/Accounts\/AC[0-9a-fA-F]{32}\/Keys\.json$/;
const keyInstance = /^\/2010-04-01\/Accounts\/AC[0-9a-fA-F]{32}\/Keys\/SK[0-9a-fA-F]{32}\.json$/;

export interface VoiceTransportRequest extends Omit<TwilioRequest, 'method'> {
  readonly method: 'GET' | 'POST' | 'DELETE';
}
export type VoiceTransport = (request: VoiceTransportRequest) => Promise<TwilioResponse>;

export function isAllowedVoiceRequest(method: string, path: string): boolean {
  return (
    (method === 'POST' && createPath.test(path)) ||
    (method === 'POST' && keyCollection.test(path)) ||
    (method === 'DELETE' && keyInstance.test(path)) ||
    ((method === 'GET' || method === 'POST') && instancePath.test(path))
  );
}

export interface VoiceTransportOptions {
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** Fixed host, no redirects, bounded response. No credentials in thrown errors. */
export function createVoiceTransport(options: VoiceTransportOptions = {}): VoiceTransport {
  const fetcher = options.fetcher ?? fetch;
  return async (request) => {
    if (!isAllowedVoiceRequest(request.method, request.path))
      throw new Error('This voice request is not allowed.');
    const response = await fetcher(new URL(request.path, 'https://api.twilio.com'), {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    for (;;) {
      const next = await reader?.read();
      if (next === undefined || next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw new Error('The voice response was not bytes.');
      size += chunk.byteLength;
      if (size > (options.maxResponseBytes ?? 1024 * 1024)) {
        await reader?.cancel();
        throw new Error('The voice response was too large.');
      }
      chunks.push(chunk);
    }
    return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
  };
}

export const voiceCallStatuses = [
  'queued',
  'ringing',
  'in-progress',
  'completed',
  'busy',
  'failed',
  'no-answer',
  'canceled',
] as const;
export type VoiceCallStatus = (typeof voiceCallStatuses)[number];

const callBody = z.object({
  sid: z.string().regex(CALL),
  account_sid: z.string().regex(ACCOUNT),
  parent_call_sid: z.string().regex(CALL).nullable(),
  status: z.enum(voiceCallStatuses),
  from: z.string().max(512).nullable(),
  to: z.string().max(512).nullable(),
  duration: z
    .string()
    .regex(/^\d{1,9}$/)
    .nullable(),
});

export interface VoiceCall {
  readonly sid: string;
  readonly accountSid: string;
  readonly parentSid: string | null;
  readonly status: VoiceCallStatus;
  readonly from: string | null;
  readonly to: string | null;
  readonly durationSeconds: number | null;
}

export type VoiceCallResult =
  | { readonly outcome: 'accepted'; readonly call: VoiceCall }
  | { readonly outcome: 'rejected'; readonly httpStatus: number; readonly code: number | null }
  | {
      readonly outcome: 'unknown';
      readonly reason: 'no_response' | 'server_error' | 'unreadable' | 'unexpected_status';
    };

const rejected = (): VoiceCallResult => ({ outcome: 'rejected', httpStatus: 0, code: null });
const codeBody = z.object({ code: z.number().int().positive() });
function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function classify(
  response: TwilioResponse,
  accountSid: string,
  expectedSid?: string,
): VoiceCallResult {
  if (response.status >= 400 && response.status < 500) {
    const code = codeBody.safeParse(json(response.body));
    return {
      outcome: 'rejected',
      httpStatus: response.status,
      code: code.success ? code.data.code : null,
    };
  }
  if (response.status >= 500 && response.status < 600)
    return { outcome: 'unknown', reason: 'server_error' };
  if (response.status < 200 || response.status >= 300)
    return { outcome: 'unknown', reason: 'unexpected_status' };
  const parsed = callBody.safeParse(json(response.body));
  if (
    !parsed.success ||
    parsed.data.account_sid !== accountSid ||
    (expectedSid !== undefined && parsed.data.sid !== expectedSid)
  )
    return { outcome: 'unknown', reason: 'unreadable' };
  const call = parsed.data;
  return {
    outcome: 'accepted',
    call: {
      sid: call.sid,
      accountSid: call.account_sid,
      parentSid: call.parent_call_sid,
      status: call.status,
      from: call.from,
      to: call.to,
      durationSeconds: call.duration === null ? null : Number(call.duration),
    },
  };
}

async function exchange(
  transport: TwilioTransport,
  credentials: TwilioCredentials,
  method: TwilioRequest['method'],
  suffix: string,
  body?: string,
  expectedSid?: string,
): Promise<VoiceCallResult> {
  const identity = credentials.apiKey?.sid ?? credentials.accountSid;
  const secret = credentials.apiKey?.secret ?? credentials.authToken;
  let response: TwilioResponse;
  try {
    response = await transport({
      method,
      path: `/2010-04-01/Accounts/${credentials.accountSid}/Calls${suffix}`,
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${identity}:${secret}`, 'utf8').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      ...(body === undefined ? {} : { body }),
    });
  } catch {
    // A lost response may already have placed/ended the call. Never repeat it here.
    return { outcome: 'unknown', reason: 'no_response' };
  }
  return classify(response, credentials.accountSid, expectedSid);
}

const callback = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    !url.hostname.includes('_')
  );
});
const createInput = z.strictObject({
  // A phone number, or a browser's client identifier: the Calls resource takes either as To
  // (installed twilio@6.1.2 call.d.ts, CallListInstanceCreateOptions.to).
  to: z.union([
    z.string().regex(/^\+[1-9][0-9]{6,14}$/),
    z.string().regex(/^client:[A-Za-z0-9_]{1,121}$/),
  ]),
  from: z.string().regex(/^\+[1-9][0-9]{6,14}$/),
  // CreateCall Twiml limit: https://www.twilio.com/docs/voice/api/call-resource#request-body-parameters
  twiml: z.string().min(1).max(4000),
  statusCallback: callback,
  timeout: z.number().int().min(1).max(600),
});
export type CreateVoiceCallInput = z.infer<typeof createInput>;

/** PSTN creation; callers must authorize/reserve before invoking this paid operation. */
export async function createVoiceCall(
  transport: TwilioTransport,
  credentials: TwilioCredentials,
  input: CreateVoiceCallInput,
): Promise<VoiceCallResult> {
  const parsed = createInput.safeParse(input);
  if (!ACCOUNT.test(credentials.accountSid) || !parsed.success) return rejected();
  const value = parsed.data;
  const form = new URLSearchParams([
    ['To', value.to],
    ['From', value.from],
    ['Twiml', value.twiml],
    ['Timeout', String(value.timeout)],
    ['StatusCallback', value.statusCallback],
    ['StatusCallbackMethod', 'POST'],
  ]);
  for (const event of ['initiated', 'ringing', 'answered', 'completed'])
    form.append('StatusCallbackEvent', event);
  return exchange(transport, credentials, 'POST', '.json', form.toString());
}

/** Reconciliation reads never create a replacement call after an uncertain result. */
export async function fetchVoiceCall(
  transport: TwilioTransport,
  credentials: TwilioCredentials,
  sid: string,
): Promise<VoiceCallResult> {
  if (!ACCOUNT.test(credentials.accountSid) || !CALL.test(sid)) return rejected();
  return exchange(transport, credentials, 'GET', `/${sid}.json`, undefined, sid);
}

export async function endVoiceCall(
  transport: TwilioTransport,
  credentials: TwilioCredentials,
  sid: string,
  status: 'canceled' | 'completed',
): Promise<VoiceCallResult> {
  const requestedStatus = z.enum(['canceled', 'completed']).safeParse(status);
  if (!ACCOUNT.test(credentials.accountSid) || !CALL.test(sid) || !requestedStatus.success)
    return rejected();
  return exchange(
    transport,
    credentials,
    'POST',
    `/${sid}.json`,
    new URLSearchParams({ Status: requestedStatus.data }).toString(),
    sid,
  );
}
