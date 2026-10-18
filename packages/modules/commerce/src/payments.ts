// Payments against invoices. Each payment is a receipt with a number of its own. It is
// written under the invoice's row lock, in the transaction that moves the invoice's amount
// paid, balance and status, so the three never disagree. Nothing is recorded beyond what is
// owed, and a payment made by mistake is reversed, never deleted.
import { defineCommand, type Command, type CommandContext } from '@repo/commands';
import {
  documentActionRefusal,
  invoiceStatusFor,
  paymentRefusal,
  recordPaymentInput,
  reversePaymentInput,
  type Receipt,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import { ConflictError, toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { lockedDocument, stateOf } from './documents.js';
import { readReceipt } from './payment-reads.js';
import { fourPlaces, paidAfter } from './rules.js';
import { takeNumber } from './settings.js';
import {
  actorOf,
  businessToday,
  heldBusiness,
  MANAGE,
  notFound,
  rowId,
  type CommerceOptions,
} from './shared.js';

/** A receipt number another payment already has: possible only after a prefix change. */
const numberTaken = explainUniqueViolation({
  payments_number_unique: () =>
    new ConflictError(
      'Another receipt already has the next number. Change the prefix or the next number in the settings.',
    ),
});

const recordWithId = z.strictObject({ id: z.string(), payment: recordPaymentInput });
const reverseWithId = reversePaymentInput.extend({ id: z.string() });

export interface PaymentCommands {
  readonly record: Command<typeof recordWithId, Receipt>;
  readonly reverse: Command<typeof reverseWithId, Receipt>;
}

export function createPaymentCommands(options: CommerceOptions): PaymentCommands {
  const receiptOf = (
    trx: DatabaseTransaction,
    command: CommandContext,
    id: string,
  ): Promise<Receipt> => readReceipt(trx, command, toPublicId('payment', id));

  const record = defineCommand({
    name: 'payment.record',
    permission: MANAGE,
    input: recordWithId,
    audit: ({ id, payment }) => ({
      id,
      amount: payment.amount,
      method: payment.method,
      paidOn: payment.paidOn,
    }),
    async handle(trx, { id, payment }, command): Promise<Receipt> {
      const businessId = await heldBusiness(options, trx, command);
      // The invoice's row is held: two payments at once are taken one after the other,
      // each against what the one before left owing.
      const invoice = await lockedDocument(trx, id);
      const refusal = documentActionRefusal('record_payment', stateOf(invoice));
      if (refusal !== undefined) throw new ConflictError(refusal);
      const amount = paymentRefusal(payment.amount, invoice.balance_due, invoice.currency);
      if (amount !== undefined)
        throw new ValidationError([
          { path: '/amount', code: amount.code, message: amount.message },
        ]);
      const paidOn = payment.paidOn ?? (await businessToday(options, trx, command)).today;
      const after = paidAfter(invoice.total, invoice.amount_paid, payment.amount, 'record');
      const status = invoiceStatusFor(invoice.total, after.amountPaid);
      const numbered = await takeNumber(trx, businessId, 'receipt');
      const actor = actorOf(command.context);
      const row = await trx
        .insertInto('commerce.payments')
        .values({
          business_id: businessId,
          document_id: invoice.id,
          number: numbered.number,
          sequence_number: numbered.sequence,
          amount: payment.amount,
          currency: invoice.currency,
          paid_on: paidOn,
          method: payment.method,
          reference: payment.reference,
          note: payment.note,
          balance_after: after.balanceDue,
          recorded_by_kind: actor.kind,
          recorded_by_id: actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
        .catch(numberTaken);
      await trx
        .updateTable('commerce.documents')
        .set({
          amount_paid: after.amountPaid,
          balance_due: after.balanceDue,
          status,
          revision: invoice.revision + 1,
        })
        .where('id', '=', invoice.id)
        .execute();
      const records = [invoice.contact_id, invoice.deal_id].filter((each) => each !== null);
      const payload = {
        number: numbered.number,
        invoiceId: toPublicId('sales_document', invoice.id),
        invoiceNumber: invoice.number,
        amount: fourPlaces(payment.amount),
        currency: invoice.currency,
        balanceDue: after.balanceDue,
      };
      await command.emit({
        type: 'payment.recorded',
        subject: { kind: 'payment', id: row.id },
        payload,
        records,
      });
      if (status === 'paid')
        await command.emit({
          type: 'invoice.paid',
          subject: { kind: 'sales_document', id: invoice.id },
          payload: {
            number: invoice.number,
            total: fourPlaces(invoice.total),
            currency: invoice.currency,
          },
          records,
        });
      return receiptOf(trx, command, row.id);
    },
  });

  const reverse = defineCommand({
    name: 'payment.reverse',
    permission: MANAGE,
    input: reverseWithId,
    async handle(trx, input, command): Promise<Receipt> {
      await heldBusiness(options, trx, command);
      const paymentId = rowId('payment', input.id);
      const found = await trx
        .selectFrom('commerce.payments')
        .select('document_id')
        .where('id', '=', paymentId)
        .executeTakeFirst();
      if (found === undefined) throw notFound('payment', input.id);
      // The invoice first, as recording does, then the payment under it.
      const invoice = await lockedDocument(trx, toPublicId('sales_document', found.document_id));
      const row = await trx
        .selectFrom('commerce.payments')
        .select(['id', 'number', 'amount', 'status'])
        .where('id', '=', paymentId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (row.status === 'reversed') throw new ConflictError('This payment is already reversed.');
      const actor = actorOf(command.context);
      await trx
        .updateTable('commerce.payments')
        .set({
          status: 'reversed',
          reversed_at: sql<Date>`now()`,
          reversal_reason: input.reason,
          reversed_by_kind: actor.kind,
          reversed_by_id: actor.id,
        })
        .where('id', '=', row.id)
        .execute();
      const after = paidAfter(invoice.total, invoice.amount_paid, row.amount, 'reverse');
      await trx
        .updateTable('commerce.documents')
        .set({
          amount_paid: after.amountPaid,
          balance_due: after.balanceDue,
          status: invoiceStatusFor(invoice.total, after.amountPaid),
          revision: invoice.revision + 1,
        })
        .where('id', '=', invoice.id)
        .execute();
      await command.emit({
        type: 'payment.reversed',
        subject: { kind: 'payment', id: row.id },
        payload: {
          number: row.number,
          invoiceId: toPublicId('sales_document', invoice.id),
          invoiceNumber: invoice.number,
          amount: fourPlaces(row.amount),
          currency: invoice.currency,
          reason: input.reason,
          balanceDue: after.balanceDue,
        },
        records: [invoice.contact_id, invoice.deal_id].filter((each) => each !== null),
      });
      return receiptOf(trx, command, row.id);
    },
  });

  return { record, reverse };
}
