// A business's own Stripe account, reached with the restricted key it pasted. Only the
// requests listed here can be sent, to Stripe's API host alone, with no redirects and a bounded
// answer; the key never appears in an error or a log.
//   Errors and status codes: https://docs.stripe.com/api/errors.md (401 no valid key, 403 the
//   key lacks the permission, 429 and 5xx worth retrying).
//   Idempotency: https://docs.stripe.com/api/idempotent_requests.md (every v1 POST takes an
//   Idempotency-Key of up to 255 characters; a retry returns the saved answer, even a 500).
//   Webhook endpoints: https://docs.stripe.com/api/webhook_endpoints/create.md (the signing
//   `secret` is returned only when the endpoint is created).
import * as z from 'zod';

/** The API version every request and the webhook endpoint use. */
export const STRIPE_API_VERSION = '2026-07-29.dahlia';

/** A restricted key: rk_live_… or rk_test_… (https://docs.stripe.com/keys/restricted-api-keys.md). */
export const RESTRICTED_KEY = /^rk_(live|test)_[A-Za-z0-9]{16,247}$/;
export const WEBHOOK_ENDPOINT_ID = /^we_[A-Za-z0-9]{8,64}$/;

const ALLOWED: readonly { readonly method: 'POST' | 'DELETE'; readonly path: RegExp }[] = [
  { method: 'POST', path: /^\/v1\/webhook_endpoints$/ },
  { method: 'DELETE', path: /^\/v1\/webhook_endpoints\/we_[A-Za-z0-9]{8,64}$/ },
];

export function isAllowedStripeRequest(method: string, path: string): boolean {
  return ALLOWED.some((allowed) => allowed.method === method && allowed.path.test(path));
}

export interface StripeRequest {
  readonly method: 'POST' | 'DELETE';
  readonly path: string;
  readonly key: string;
  readonly form?: URLSearchParams;
  readonly idempotencyKey?: string;
}
export interface StripeResponse {
  readonly status: number;
  readonly body: unknown;
}
export type StripeTransport = (request: StripeRequest) => Promise<StripeResponse>;

export interface StripeTransportOptions {
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** Fixed host, the allowlist above, no redirects, a bounded answer, nothing secret in errors. */
export function createStripeTransport(options: StripeTransportOptions = {}): StripeTransport {
  const fetcher = options.fetcher ?? fetch;
  const maxBytes = options.maxResponseBytes ?? 65_536;
  return async (request) => {
    if (!isAllowedStripeRequest(request.method, request.path))
      throw new Error('This Stripe request is not allowed.');
    const headers: Record<string, string> = {
      authorization: `Bearer ${request.key}`,
      'stripe-version': STRIPE_API_VERSION,
    };
    if (request.form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    // Only POST takes one; on GET and DELETE it has no effect.
    if (request.method === 'POST' && request.idempotencyKey !== undefined)
      headers['idempotency-key'] = request.idempotencyKey;
    const response = await fetcher(new URL(request.path, 'https://api.stripe.com'), {
      method: request.method,
      headers,
      ...(request.form === undefined ? {} : { body: request.form.toString() }),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    for (;;) {
      const next = await reader?.read();
      if (next === undefined || next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) break;
      size += chunk.byteLength;
      if (size > maxBytes) {
        await reader?.cancel();
        throw new Error('Stripe answered with more than expected.');
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}

export type StripeRejection = 'unauthorized' | 'forbidden' | 'invalid' | 'refused';
export type StripeOutcome<T> =
  | ({ readonly outcome: 'accepted' } & T)
  | {
      readonly outcome: 'rejected';
      readonly reason: StripeRejection;
      readonly status: number | null;
    }
  | { readonly outcome: 'unknown' };

const invalid = { outcome: 'rejected', reason: 'invalid', status: null } as const;
const unknown = { outcome: 'unknown' } as const;

/** Sends one request; a lost answer, a rate limit or a Stripe server error is unknown. */
async function exchange(
  transport: StripeTransport,
  request: StripeRequest,
): Promise<StripeResponse | 'unknown'> {
  try {
    const response = await transport(request);
    if (response.status === 429 || response.status >= 500) return 'unknown';
    return response;
  } catch {
    return 'unknown';
  }
}

function rejection(status: number): StripeOutcome<never> {
  if (status === 401) return { outcome: 'rejected', reason: 'unauthorized', status };
  if (status === 403) return { outcome: 'rejected', reason: 'forbidden', status };
  return { outcome: 'rejected', reason: 'refused', status };
}

const httpsUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === '';
});

const createdEndpoint = z.object({
  id: z.string().regex(WEBHOOK_ENDPOINT_ID),
  livemode: z.boolean(),
  secret: z.string().regex(/^whsec_[A-Za-z0-9]{8,255}$/),
});

/** The only events this install needs: a Checkout Session paid now, or later, or not. */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
] as const;

export async function createWebhookEndpoint(
  transport: StripeTransport,
  key: string,
  input: { readonly url: string; readonly idempotencyKey: string },
): Promise<
  StripeOutcome<{
    readonly endpoint: { readonly id: string; readonly livemode: boolean; readonly secret: string };
  }>
> {
  if (
    !RESTRICTED_KEY.test(key) ||
    !httpsUrl.safeParse(input.url).success ||
    input.idempotencyKey.length === 0 ||
    input.idempotencyKey.length > 255
  )
    return invalid;
  const form = new URLSearchParams([
    ['url', input.url],
    ...WEBHOOK_EVENTS.map((event): [string, string] => ['enabled_events[]', event]),
    ['api_version', STRIPE_API_VERSION],
    ['description', 'Cal CRM invoice payments'],
  ]);
  const response = await exchange(transport, {
    method: 'POST',
    path: '/v1/webhook_endpoints',
    key,
    form,
    idempotencyKey: input.idempotencyKey,
  });
  if (response === 'unknown') return unknown;
  if (response.status !== 200) return rejection(response.status);
  const parsed = createdEndpoint.safeParse(response.body);
  // An answer without the signing secret can't be used and can't be asked for again.
  if (!parsed.success) return unknown;
  return {
    outcome: 'accepted',
    endpoint: { id: parsed.data.id, livemode: parsed.data.livemode, secret: parsed.data.secret },
  };
}

export async function deleteWebhookEndpoint(
  transport: StripeTransport,
  key: string,
  endpointId: string,
): Promise<
  { readonly outcome: 'deleted' } | Exclude<StripeOutcome<never>, { outcome: 'accepted' }>
> {
  if (!RESTRICTED_KEY.test(key) || !WEBHOOK_ENDPOINT_ID.test(endpointId)) return invalid;
  const response = await exchange(transport, {
    method: 'DELETE',
    path: `/v1/webhook_endpoints/${endpointId}`,
    key,
  });
  if (response === 'unknown') return unknown;
  // Already gone counts as deleted.
  if (response.status === 200 || response.status === 404) return { outcome: 'deleted' };
  return rejection(response.status);
}
