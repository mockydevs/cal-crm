// One spelling for instructions, relay routing and worker signature reconstruction.
// Reuse the SMS origin/capability rules; the signature, not the token, authenticates.
import { isWebhookToken, smsWebhookOrigin } from '../sms-webhook-url.js';

export const voiceWebhookKinds = [
  'inbound',
  'progress',
  'ended',
  'dial-result',
  'accept',
  'voicemail',
  'recording',
] as const;
export type VoiceWebhookKind = (typeof voiceWebhookKinds)[number];
export interface VoiceCallbackTarget {
  readonly kind: VoiceWebhookKind;
  /** A stored route-step identity, required by handlers that advance a route. */
  readonly stepId?: string;
}
export interface VoiceCallbackPath extends VoiceCallbackTarget {
  readonly token: string;
}

const STEP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATH = /^\/webhooks\/twilio\/voice\/([A-Za-z0-9_-]{43})\/([a-z-]+)(?:\?step=([0-9a-f-]+))?$/;
const knownKind = (value: string | undefined): value is VoiceWebhookKind =>
  voiceWebhookKinds.some((kind) => kind === value);

export function voiceWebhookUrl(
  publicUrl: string,
  token: string,
  target: VoiceCallbackTarget,
): string | null {
  const origin = smsWebhookOrigin(publicUrl);
  if (
    origin === null ||
    !isWebhookToken(token) ||
    !knownKind(target.kind) ||
    (target.stepId !== undefined && !STEP.test(target.stepId))
  )
    return null;
  const query = target.stepId === undefined ? '' : `?step=${target.stepId}`;
  return `${origin}/webhooks/twilio/voice/${token}/${target.kind}${query}`;
}

/** No URL normalization, unknown query parameters, duplicate context or fragments. */
export function parseVoiceCallbackPath(rawPath: string): VoiceCallbackPath | null {
  const matched = PATH.exec(rawPath);
  if (matched === null) return null;
  const [, token, kind, stepId] = matched;
  if (token === undefined || !knownKind(kind) || (stepId !== undefined && !STEP.test(stepId)))
    return null;
  return { token, kind, ...(stepId === undefined ? {} : { stepId }) };
}
