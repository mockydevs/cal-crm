// Stage two of receiving a Twilio webhook: deciding whether a stored raw request is
// Twilio's. Pure: the worker passes in the Auth Token it opened. Until this says yes,
// nothing in the request is believed.
import { parseWebhookEndpoint, webhookUrlOf, type WebhookEndpoint } from './sms-webhook-url.js';
import { parseForm, singleValue } from './twilio-form.js';
import { validateSignature, type SignedParams } from './twilio-signature.js';

export interface StoredSmsWebhook {
  /** intake.webhooks.endpoint: "inbound" or "status?m=<message id>". */
  readonly endpoint: string;
  /** intake.webhooks.headers. */
  readonly headers: unknown;
  /** intake.webhooks.body, byte for byte as received. */
  readonly body: Uint8Array;
}

function headerOf(headers: unknown, name: string): string | undefined {
  if (typeof headers !== 'object' || headers === null || !Object.hasOwn(headers, name))
    return undefined;
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : undefined;
}

export type SmsWebhookVerdict =
  | {
      readonly valid: true;
      readonly endpoint: WebhookEndpoint;
      readonly params: SignedParams;
    }
  | {
      readonly valid: false;
      readonly reason: 'malformed_endpoint' | 'malformed_body' | 'invalid_signature';
    };

/**
 * Checks the X-Twilio-Signature of a stored request with the connection's Auth Token.
 *
 * The URL that was signed is rebuilt from our own configuration (the public origin and
 * the connection's sealed token) and the stored endpoint: never from a Host or forwarding
 * header, which a caller controls. Every parameter of the body is signed, known or not.
 */
export function verifySmsWebhook(
  stored: StoredSmsWebhook,
  secrets: { readonly authToken: string; readonly webhookToken: string },
  origin: string,
): SmsWebhookVerdict {
  const endpoint = parseWebhookEndpoint(stored.endpoint);
  if (endpoint === null) return { valid: false, reason: 'malformed_endpoint' };
  const params = parseForm(stored.body);
  if (params === null) return { valid: false, reason: 'malformed_body' };
  const signature = headerOf(stored.headers, 'x-twilio-signature');
  const url = webhookUrlOf(origin, secrets.webhookToken, endpoint);
  if (signature === undefined || !validateSignature(secrets.authToken, signature, url, params))
    return { valid: false, reason: 'invalid_signature' };
  return { valid: true, endpoint, params };
}

const SID = /^(SM|MM)[0-9a-fA-F]{32}$/;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;

export interface StatusCallback {
  readonly accountSid: string;
  readonly messageSid: string;
  /** Twilio's MessageStatus, as sent; a value we don't know yet is ignored later. */
  readonly status: string;
  /** Present when the status is failed or undelivered. */
  readonly errorCode: number | null;
}

/**
 * The parts of a status callback we act on. Twilio "occasionally adds new properties
 * without advance notice", so everything else is left alone (and is still signed).
 */
export function statusCallbackOf(params: SignedParams): StatusCallback | null {
  const accountSid = singleValue(params, 'AccountSid');
  const messageSid = singleValue(params, 'MessageSid');
  const status = singleValue(params, 'MessageStatus');
  if (accountSid === undefined || !ACCOUNT_SID.test(accountSid)) return null;
  if (messageSid === undefined || !SID.test(messageSid)) return null;
  if (status === undefined || status.length === 0 || status.length > 40) return null;
  const code = singleValue(params, 'ErrorCode') ?? '';
  return {
    accountSid,
    messageSid,
    status,
    errorCode: /^[1-9][0-9]{0,8}$/.test(code) ? Number(code) : null,
  };
}

export interface InboundSms {
  readonly accountSid: string;
  readonly messageSid: string;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  /** Twilio's own verdict; sent only when the customer uses Advanced Opt-Out. */
  readonly optOutType: string | null;
}

/** The parts of an inbound message webhook we act on. */
export function inboundSmsOf(params: SignedParams): InboundSms | null {
  const accountSid = singleValue(params, 'AccountSid');
  const messageSid = singleValue(params, 'MessageSid');
  const from = singleValue(params, 'From');
  const to = singleValue(params, 'To');
  if (accountSid === undefined || !ACCOUNT_SID.test(accountSid)) return null;
  if (messageSid === undefined || !SID.test(messageSid)) return null;
  if (from === undefined || to === undefined) return null;
  return {
    accountSid,
    messageSid,
    from,
    to,
    // A message with only media has no Body.
    body: singleValue(params, 'Body') ?? '',
    optOutType: singleValue(params, 'OptOutType') ?? null,
  };
}
