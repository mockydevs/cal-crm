// Stripe's events for a business's own account, and the payment they record. The API keeps what
// Stripe sent as it came (it can't open the signing secret); the worker checks the signature,
// reads the event and records the invoice's payment once.
//
// The rules it keeps:
// - the signature is Stripe's v1 scheme: an HMAC-SHA256, keyed with the endpoint's whole
//   whsec_ secret, of "<t>.<raw body>", compared in constant time with every v1 in the
//   Stripe-Signature header; t must be within five minutes of when the request came in
//   (https://docs.stripe.com/webhooks.md, "Verify webhook signatures manually"; the same as
//   stripe-node's Webhooks.js). Other schemes, such as test mode's v0, are ignored;
// - only checkout.session.completed and checkout.session.async_payment_succeeded with
//   payment_status "paid" record a payment (https://docs.stripe.com/checkout/fulfillment.md).
//   The event's own session is trusted once its signature is checked: each event carries the
//   session as it stood, so a payment that succeeds later arrives with its own "paid" event;
// - one payment per checkout, whatever arrives twice or at once: the checkout's row is held
//   while its payment is written, and a checkout already paid takes nothing more;
// - Stripe charges what the session asked for. A session whose amount, currency or reference is
//   not its checkout's, or an invoice that can no longer take the payment (paid or voided
//   meanwhile), leaves the checkout "unmatched" for the team to settle in Stripe, never a
//   payment the books can't hold.
import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type Task,
  type TaskReference,
} from '@repo/commands';
import { documentActionRefusal, paymentRefusal, recordPaymentInput } from '@repo/contracts';
import { withTenant, type Database } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { lockedDocument, stateOf } from './documents.js';
import { createPaymentCommands } from './payments.js';
import { MANAGE, type CommerceOptions } from './shared.js';
import { amountFromStripe } from './stripe-amounts.js';
import {
  STRIPE_WEBHOOK_SECRET_PURPOSE,
  stripeWebhookDigest,
  type StripeVault,
} from './stripe-connect.js';
import { CHECKOUT_SESSION_ID } from './stripe-transport.js';

/** The token in a webhook address: 32 random bytes, base64url. */
const WEBHOOK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** Stripe's own libraries allow five minutes between the signature's time and now. */
const TOLERANCE_SECONDS = 300;
/** The largest event kept; a Checkout Session's events are a few kilobytes. */
export const STRIPE_WEBHOOK_MAX_BYTES = 262_144;
/** How long a processed event is kept, to see what arrived. */
const KEPT_DAYS = 30;

export type StripeWebhookAcceptance = 'accepted' | 'unknown' | 'refused' | 'over_capacity';

/** The API's side: keeps the request for the worker, or says why not. */
export async function acceptStripeWebhook(
  db: Database,
  request: { readonly token: string; readonly signature: unknown; readonly body: Uint8Array },
): Promise<StripeWebhookAcceptance> {
  if (!WEBHOOK_TOKEN.test(request.token)) return 'unknown';
  if (typeof request.signature !== 'string' || request.body.byteLength > STRIPE_WEBHOOK_MAX_BYTES)
    return 'refused';
  const {
    rows: [row],
  } = await sql<{ outcome: string }>`
    select outcome from private.accept_stripe_webhook(
      ${stripeWebhookDigest(request.token)}, ${request.signature}, ${Buffer.from(request.body)})
  `.execute(db);
  const outcome = row?.outcome;
  return outcome === 'accepted' || outcome === 'unknown' || outcome === 'over_capacity'
    ? outcome
    : 'refused';
}

/** Whether the header signs this body with this secret, at a time near when it came in. */
export function verifyStripeSignature(
  header: string,
  body: Uint8Array,
  secret: string,
  receivedAt: Date,
): boolean {
  let timestamp: number | undefined;
  const signatures: Buffer[] = [];
  for (const element of header.split(',')) {
    const at = element.indexOf('=');
    if (at < 1) continue;
    const scheme = element.slice(0, at).trim();
    const value = element.slice(at + 1).trim();
    if (scheme === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (scheme === 'v1' && /^[0-9a-f]{64}$/.test(value))
      signatures.push(Buffer.from(value, 'hex'));
  }
  if (timestamp === undefined || signatures.length === 0) return false;
  if (Math.abs(receivedAt.getTime() / 1000 - timestamp) > TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret)
    .update(`${String(timestamp)}.`)
    .update(body)
    .digest();
  return signatures.some((signature) => timingSafeEqual(signature, expected));
}

const PAYING_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

const event = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_]{1,250}$/),
  type: z.string().max(200),
  livemode: z.boolean(),
  data: z.object({ object: z.looseObject({}) }),
});

const paidSession = z.object({
  id: z.string().regex(CHECKOUT_SESSION_ID),
  payment_status: z.string(),
  amount_total: z.number().int().nonnegative(),
  currency: z.string().regex(/^[a-z]{3}$/),
  client_reference_id: z.string().nullable(),
  payment_intent: z.string().max(255).nullable().optional(),
});

export const applyStripeWebhookReference = {
  name: 'commerce.apply_stripe_webhook',
  data: z.strictObject({ webhookId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

const settleInput = z.strictObject({
  sessionId: z.string().regex(CHECKOUT_SESSION_ID),
  amountTotal: z.number().int().nonnegative(),
  currency: z.string(),
  reference: z.string().nullable(),
  paymentIntent: z.string().nullable(),
});

type Settled = 'paid' | 'unmatched' | 'already' | 'none';

/** Records the payment of the checkout a paid session belongs to, once. */
function createSettleCommand(options: CommerceOptions) {
  const payments = createPaymentCommands(options);
  return defineCommand({
    name: 'stripe_checkout.settle',
    permission: MANAGE,
    input: settleInput,
    audit: ({ sessionId }) => ({ sessionId }),
    async handle(trx, input, command): Promise<Settled> {
      const checkout = await trx
        .selectFrom('commerce.stripe_checkouts')
        .select(['id', 'status', 'document_id', 'amount', 'currency'])
        .where('session_id', '=', input.sessionId)
        .forUpdate()
        .executeTakeFirst();
      // A session this install didn't make, such as one of the business's own elsewhere.
      if (checkout === undefined) return 'none';
      if (checkout.status === 'paid' || checkout.status === 'unmatched') return 'already';
      const unmatched = async (): Promise<Settled> => {
        await trx
          .updateTable('commerce.stripe_checkouts')
          .set({ status: 'unmatched' })
          .where('id', '=', checkout.id)
          .execute();
        return 'unmatched';
      };
      const amount = amountFromStripe(input.amountTotal);
      if (
        checkout.amount === null ||
        checkout.currency === null ||
        input.reference !== checkout.id ||
        input.currency !== checkout.currency.toLowerCase() ||
        amount !== checkout.amount
      )
        return unmatched();
      const documentId = toPublicId('sales_document', checkout.document_id);
      // Checked here, before anything is written, so a refusal never fails the transaction.
      const invoice = await lockedDocument(trx, documentId);
      if (
        documentActionRefusal('record_payment', stateOf(invoice)) !== undefined ||
        paymentRefusal(amount, invoice.balance_due, invoice.currency) !== undefined
      )
        return unmatched();
      const receipt = await payments.record.handle(
        trx,
        {
          id: documentId,
          payment: recordPaymentInput.parse({
            amount,
            method: 'card',
            reference: input.paymentIntent ?? input.sessionId,
            note: 'Paid by card through Stripe.',
          }),
        },
        command,
      );
      await trx
        .updateTable('commerce.stripe_checkouts')
        .set({ status: 'paid', payment_id: parsePublicId('payment', receipt.id) })
        .where('id', '=', checkout.id)
        .execute();
      return 'paid';
    },
  });
}

/** Checks one kept event and applies it. */
export function createApplyStripeWebhookTask(
  options: CommerceOptions,
  vault: StripeVault,
): Task<typeof applyStripeWebhookReference.data> {
  const settle = createSettleCommand(options);
  return defineTask({
    ...applyStripeWebhookReference,
    async run({ webhookId }, { invocation, services }) {
      const businessId = requireBusiness(invocation.context);
      const mark = (outcome: 'applied' | 'ignored' | 'refused', eventId: string | null) =>
        withTenant(services.db, invocation.context, async (trx) => {
          await trx
            .updateTable('commerce.stripe_webhooks')
            .set({ outcome, event_id: eventId, processed_at: sql<Date>`now()` })
            .where('id', '=', webhookId)
            .where('processed_at', 'is', null)
            .execute();
          // What was processed long ago goes.
          await trx
            .deleteFrom('commerce.stripe_webhooks')
            .where('business_id', '=', businessId)
            .where('processed_at', '<', sql<Date>`now() - make_interval(days => ${KEPT_DAYS})`)
            .execute();
        });

      const read = await withTenant(services.db, invocation.context, async (trx) => {
        const row = await trx
          .selectFrom('commerce.stripe_webhooks')
          .select(['signature', 'body', 'received_at', 'processed_at'])
          .where('id', '=', webhookId)
          .executeTakeFirst();
        if (row?.processed_at !== null) return null;
        const connection = await trx
          .selectFrom('commerce.stripe_connections')
          .select(['status', 'livemode', 'webhook_secret_id'])
          .where('business_id', '=', businessId)
          .executeTakeFirst();
        // Disconnected since: nothing is left to check the signature with.
        if (connection?.status !== 'connected' || connection.webhook_secret_id === null)
          return 'refused' as const;
        const secret = await vault.read(
          trx,
          connection.webhook_secret_id,
          STRIPE_WEBHOOK_SECRET_PURPOSE,
        );
        if (!verifyStripeSignature(row.signature, row.body, secret, row.received_at))
          return 'refused' as const;
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.from(row.body).toString('utf8'));
        } catch {
          return 'refused' as const;
        }
        const found = event.safeParse(parsed);
        if (!found.success) return 'refused' as const;
        return { event: found.data, livemode: connection.livemode };
      });
      if (read === null) return;
      if (read === 'refused') {
        await mark('refused', null);
        return;
      }

      const { event: received, livemode } = read;
      const session = paidSession.safeParse(received.data.object);
      if (
        !PAYING_EVENTS.has(received.type) ||
        received.livemode !== livemode ||
        !session.success ||
        session.data.payment_status !== 'paid'
      ) {
        await mark('ignored', received.id);
        return;
      }
      const settled = await runCommand(
        services,
        settle,
        {
          sessionId: session.data.id,
          amountTotal: session.data.amount_total,
          currency: session.data.currency,
          reference: session.data.client_reference_id,
          paymentIntent: session.data.payment_intent ?? null,
        },
        invocation,
      );
      await mark(
        settled === 'paid' || settled === 'unmatched' ? 'applied' : 'ignored',
        received.id,
      );
    },
  });
}
