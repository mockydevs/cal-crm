// Paying an invoice by card through the business's own Stripe account. "Pay now" on the
// invoice's public page asks for a checkout; the worker, which alone can open the key, creates
// the Checkout Session on that account; the page waits for it and sends the customer there.
//
// The rules it keeps:
// - the amount is the invoice's balance when the worker makes the session, in the invoice's
//   currency, and only a currency Stripe takes with two places (stripe-amounts.ts);
// - a session already made for the same balance, with time left, is used again, and so is a
//   request still being prepared: pressing "Pay now" twice never makes two sessions;
// - the worker asks Stripe with an idempotency key made from the checkout's id, with parameters
//   that are the same on every try, so a lost answer asked again returns the same session
//   (https://docs.stripe.com/api/idempotent_requests.md);
// - Stripe sends the customer back to the invoice's own address. Only that address's digest is
//   kept, so the token is sealed in the vault with the request and removed once used.
import { createHash } from 'node:crypto';

import {
  defineCommand,
  defineTask,
  requireBusiness,
  type Command,
  type Task,
  type TaskReference,
} from '@repo/commands';
import {
  documentActionRefusal,
  SALES_DOCUMENT_LINK_PATH,
  type DocumentState,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { NotFoundError, toPublicId } from '@repo/kernel';
import * as z from 'zod';

import { lockedDocument, stateOf } from './documents.js';
import { kindOf, statusOf } from './rules.js';
import { heldBusiness, MANAGE, type CommerceOptions } from './shared.js';
import { stripeAmountOf } from './stripe-amounts.js';
import { STRIPE_KEY_PURPOSE, type StripeSealing, type StripeVault } from './stripe-connect.js';
import { createCheckoutSession, type StripeTransport } from './stripe-transport.js';

export const STRIPE_RETURN_PURPOSE = 'commerce.stripe.return';

export const createStripeCheckoutReference = {
  name: 'commerce.create_stripe_checkout',
  data: z.strictObject({ checkoutId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

/** A session is used again while it has at least this long left. */
const REUSE_MARGIN_MS = 10 * 60 * 1000;
/** A request is waited for, not asked again, this long; after it the page says to try later. */
export const PREPARING_MS = 2 * 60 * 1000;
/** How long a session stays open at Stripe, from the request (Stripe allows 30 minutes to 24 hours). */
const SESSION_MS = 60 * 60 * 1000;

export type CheckoutFailure =
  | 'not_connected'
  | 'not_payable'
  | 'unsupported_currency'
  | 'below_minimum'
  | 'key_rejected'
  | 'missing_permission'
  | 'provider_error';

interface Payable {
  readonly state: DocumentState;
  readonly balanceDue: string;
  readonly currency: string;
}

/**
 * Why the invoice can't be paid by card now, or nothing when it can: an issued invoice that still
 * owes, in a currency Stripe takes, of a business whose Stripe account is connected.
 */
export async function cardPaymentRefusal(
  trx: DatabaseTransaction,
  businessId: string,
  invoice: Payable,
): Promise<CheckoutFailure | undefined> {
  if (documentActionRefusal('record_payment', invoice.state) !== undefined) return 'not_payable';
  const amount = stripeAmountOf(invoice.balanceDue, invoice.currency);
  if (amount.outcome === 'refused') return amount.reason;
  const connection = await trx
    .selectFrom('commerce.stripe_connections')
    .select('status')
    .where('business_id', '=', businessId)
    .executeTakeFirst();
  return connection?.status === 'connected' ? undefined : 'not_connected';
}

/** The same, for a document read without its lock: what the public page asks before showing the button. */
export async function cardPayable(
  trx: DatabaseTransaction,
  businessId: string,
  documentId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('commerce.documents')
    .select(['kind', 'status', 'number', 'amount_paid', 'balance_due', 'currency'])
    .where('id', '=', documentId)
    .executeTakeFirst();
  if (row === undefined) return false;
  const refusal = await cardPaymentRefusal(trx, businessId, {
    state: {
      kind: kindOf(row.kind),
      status: statusOf(row.status),
      number: row.number,
      amountPaid: row.amount_paid,
      // Only a quote is converted, and only an invoice is paid.
      converted: false,
    },
    balanceDue: row.balance_due,
    currency: row.currency,
  });
  return refusal === undefined;
}

const requestInput = z.strictObject({
  documentId: z.uuid(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

export type CheckoutRequest =
  | { readonly outcome: 'requested'; readonly checkoutId: string }
  | { readonly outcome: 'refused'; readonly reason: CheckoutFailure };

/**
 * "Pay now", for the holder of the invoice's address: the token is the address's own, sealed so
 * that Stripe can send the customer back to it. Made for each request, as the token is not input.
 */
export function createRequestCheckoutCommand(
  options: CommerceOptions,
  vault: StripeSealing,
  token: string,
): Command<typeof requestInput, CheckoutRequest> {
  return defineCommand({
    name: 'stripe_checkout.request',
    permission: MANAGE,
    input: requestInput,
    // The digest is the capability's: the log names the invoice and where the request came from.
    audit: ({ documentId }) => ({
      id: toPublicId('sales_document', documentId),
      source: 'public_link',
    }),
    async handle(trx, input, command): Promise<CheckoutRequest> {
      const businessId = await heldBusiness(options, trx, command);
      const row = await lockedDocument(trx, toPublicId('sales_document', input.documentId));
      const link = await trx
        .selectFrom('commerce.document_links')
        .select('id')
        .where('document_id', '=', row.id)
        .where('digest', '=', input.digest)
        .executeTakeFirst();
      // An address replaced since the page was shown opens nothing.
      if (link === undefined) throw new NotFoundError('Sales document', 'unavailable');
      const refusal = await cardPaymentRefusal(trx, businessId, {
        state: stateOf(row),
        balanceDue: row.balance_due,
        currency: row.currency,
      });
      if (refusal !== undefined) return { outcome: 'refused', reason: refusal };

      const now = (options.now ?? (() => new Date()))().getTime();
      const latest = await trx
        .selectFrom('commerce.stripe_checkouts')
        .select(['id', 'status', 'amount', 'currency', 'expires_at', 'created_at'])
        .where('document_id', '=', row.id)
        .where('status', 'in', ['preparing', 'open'])
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (
        latest !== undefined &&
        (latest.status === 'preparing'
          ? now - latest.created_at.getTime() < PREPARING_MS
          : latest.amount === row.balance_due &&
            latest.currency === row.currency &&
            latest.expires_at !== null &&
            latest.expires_at.getTime() - now > REUSE_MARGIN_MS)
      )
        return { outcome: 'requested', checkoutId: latest.id };

      const returnSecretId = await vault.store(
        trx,
        { agencyId: command.context.agencyId, businessId, purpose: STRIPE_RETURN_PURPOSE },
        token,
      );
      const created = await trx
        .insertInto('commerce.stripe_checkouts')
        .values({
          business_id: businessId,
          document_id: row.id,
          return_secret_id: returnSecretId,
          created_at: new Date(now),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      command.enqueue(createStripeCheckoutReference, { checkoutId: created.id });
      return { outcome: 'requested', checkoutId: created.id };
    },
  });
}

/** What the page shows for a checkout: the way to Stripe, or why there is none. */
export type CheckoutState =
  | { readonly state: 'preparing' }
  | { readonly state: 'open'; readonly url: string }
  | { readonly state: 'paid' }
  | { readonly state: 'expired' }
  | { readonly state: 'failed'; readonly failure: CheckoutFailure };

const failureOf = (value: string | null): CheckoutFailure =>
  value === 'not_connected' ||
  value === 'not_payable' ||
  value === 'unsupported_currency' ||
  value === 'below_minimum' ||
  value === 'key_rejected' ||
  value === 'missing_permission'
    ? value
    : 'provider_error';

/** A checkout of this document, as its page shows it, or nothing when it isn't this document's. */
export async function readCheckoutState(
  trx: DatabaseTransaction,
  options: CommerceOptions,
  documentId: string,
  checkoutId: string,
): Promise<CheckoutState | undefined> {
  const row = await trx
    .selectFrom('commerce.stripe_checkouts')
    .select(['status', 'session_url', 'expires_at', 'failure', 'created_at'])
    .where('id', '=', checkoutId)
    .where('document_id', '=', documentId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const now = (options.now ?? (() => new Date()))().getTime();
  switch (row.status) {
    case 'preparing':
      // A request the worker never finished: the page stops waiting.
      return now - row.created_at.getTime() < PREPARING_MS
        ? { state: 'preparing' }
        : { state: 'failed', failure: 'provider_error' };
    case 'open':
      return row.session_url !== null && row.expires_at !== null && row.expires_at.getTime() > now
        ? { state: 'open', url: row.session_url }
        : { state: 'expired' };
    case 'paid':
    case 'unmatched':
      return { state: 'paid' };
    case 'expired':
      return { state: 'expired' };
    default:
      return { state: 'failed', failure: failureOf(row.failure) };
  }
}

const httpsOrigin = (publicUrl: string): string | null => {
  try {
    const url = new URL(publicUrl);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
};

/** Eight letters from the checkout's id: the label's suffix Stripe recommends, the same on every try. */
const letters = (id: string): string =>
  [...createHash('sha256').update(id).digest()]
    .slice(0, 8)
    .map((byte) => String.fromCharCode(97 + (byte % 26)))
    .join('');

/** Creates the Checkout Session for one request, at the business's own Stripe account. */
export function createStripeCheckoutTask(
  vault: StripeVault,
  transport: StripeTransport,
  publicUrl: string,
): Task<typeof createStripeCheckoutReference.data> {
  return defineTask({
    ...createStripeCheckoutReference,
    async run({ checkoutId }, { invocation, services }) {
      const businessId = requireBusiness(invocation.context);

      /** Marks the request failed and removes the sealed token; nothing is asked of Stripe. */
      const fail = async (
        trx: DatabaseTransaction,
        returnSecretId: string | null,
        failure: CheckoutFailure,
      ): Promise<null> => {
        await trx
          .updateTable('commerce.stripe_checkouts')
          .set({ status: 'failed', failure, return_secret_id: null })
          .where('id', '=', checkoutId)
          .execute();
        if (returnSecretId !== null) await vault.remove(trx, returnSecretId);
        return null;
      };

      const locked = (trx: DatabaseTransaction) =>
        trx
          .selectFrom('commerce.stripe_checkouts')
          .select(['status', 'document_id', 'return_secret_id', 'created_at'])
          .where('id', '=', checkoutId)
          .forUpdate()
          .executeTakeFirst();

      const prepared = await withTenant(services.db, invocation.context, async (trx) => {
        const checkout = await locked(trx);
        if (checkout?.status !== 'preparing') return null;
        const origin = httpsOrigin(publicUrl);
        const connection = await trx
          .selectFrom('commerce.stripe_connections')
          .select(['status', 'key_secret_id'])
          .where('business_id', '=', businessId)
          .executeTakeFirst();
        if (origin === null || connection?.status !== 'connected')
          return fail(trx, checkout.return_secret_id, 'not_connected');
        const invoice = await lockedDocument(
          trx,
          toPublicId('sales_document', checkout.document_id),
        );
        const refusal = await cardPaymentRefusal(trx, businessId, {
          state: stateOf(invoice),
          balanceDue: invoice.balance_due,
          currency: invoice.currency,
        });
        if (refusal !== undefined) return fail(trx, checkout.return_secret_id, refusal);
        const amount = stripeAmountOf(invoice.balance_due, invoice.currency);
        if (amount.outcome === 'refused' || checkout.return_secret_id === null)
          return fail(trx, checkout.return_secret_id, 'provider_error');
        const token = await vault.read(trx, checkout.return_secret_id, STRIPE_RETURN_PURPOSE);
        return {
          key: await vault.read(trx, connection.key_secret_id, STRIPE_KEY_PURPOSE),
          page: `${origin}${SALES_DOCUMENT_LINK_PATH}/${token}`,
          amount,
          balanceDue: invoice.balance_due,
          currency: invoice.currency,
          name: invoice.number === null ? 'Invoice' : `Invoice ${invoice.number}`,
          expiresAt: Math.floor((checkout.created_at.getTime() + SESSION_MS) / 1000),
        };
      });
      if (prepared === null) return;

      const result = await createCheckoutSession(transport, prepared.key, {
        currency: prepared.amount.currency,
        unitAmount: prepared.amount.unitAmount,
        name: prepared.name,
        reference: checkoutId,
        successUrl: `${prepared.page}/paid`,
        cancelUrl: prepared.page,
        expiresAt: prepared.expiresAt,
        integrationIdentifier: `cal-crm-invoice-${letters(checkoutId)}`,
        idempotencyKey: `cal-crm-checkout-${checkoutId}`,
      });
      // A lost answer is asked again by the job's retry, with the same key and parameters.
      if (result.outcome === 'unknown')
        throw new Error('Stripe’s answer was lost; the Checkout Session is asked for again.');

      await withTenant(services.db, invocation.context, async (trx) => {
        const checkout = await locked(trx);
        if (checkout?.status !== 'preparing') return;
        if (result.outcome === 'rejected') {
          await fail(
            trx,
            checkout.return_secret_id,
            result.reason === 'unauthorized'
              ? 'key_rejected'
              : result.reason === 'forbidden'
                ? 'missing_permission'
                : 'provider_error',
          );
          return;
        }
        const { session } = result;
        // Stripe charges what it was asked to, or the session isn't shown to anyone.
        if (
          String(session.amountTotal) !== prepared.amount.unitAmount ||
          session.currency !== prepared.amount.currency
        ) {
          await fail(trx, checkout.return_secret_id, 'provider_error');
          return;
        }
        await trx
          .updateTable('commerce.stripe_checkouts')
          .set({
            status: 'open',
            amount: prepared.balanceDue,
            currency: prepared.currency,
            session_id: session.id,
            session_url: session.url,
            expires_at: session.expiresAt,
            livemode: session.livemode,
            return_secret_id: null,
          })
          .where('id', '=', checkoutId)
          .execute();
        if (checkout.return_secret_id !== null) await vault.remove(trx, checkout.return_secret_id);
      });
    },
  });
}
