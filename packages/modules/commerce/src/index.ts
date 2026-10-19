// The commerce module: the catalogue of products and services, quotes and invoices,
// payments with their receipts, and the settings they are numbered and worded by; and, from
// what those store, the PDF of each, a public address for a quote or an invoice, and the
// email that sends one to its contact. It owns the commerce schema. The business's profile,
// contacts, deals, files and outgoing mail are other modules', reached through what the
// server hands over (shared.ts). Nothing here talks to a payment provider.
import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  acceptQuote,
  archiveProduct,
  convertQuoteToInvoice,
  createInvoiceReminder,
  createProduct,
  createSalesDocument,
  createSalesDocumentLink,
  declineQuote,
  deleteInvoiceReminder,
  deleteProduct,
  deleteSalesDocument,
  duplicateSalesDocument,
  getCommerceSettings,
  getProduct,
  getReceipt,
  getReceiptPdf,
  getSalesDocument,
  getSalesDocumentPdf,
  issueSalesDocument,
  listInvoiceReminders,
  listPayments,
  listProducts,
  listSalesDocuments,
  parseInput,
  recordPayment,
  restoreProduct,
  reversePayment,
  reviseSalesDocument,
  sendReceipt,
  sendSalesDocument,
  setSalesDocumentNote,
  updateCommerceSettings,
  updateInvoiceReminder,
  updateProduct,
  updateSalesDocument,
  voidInvoice,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import { createDocumentCommands, readDocument, readDocuments } from './documents.js';
import { readPayments, readReceipt } from './payment-reads.js';
import { createPaymentCommands } from './payments.js';
import { pdfOf, readPrintableDocument, readPrintableReceipt } from './printing.js';
import { createSendCommands } from './sending.js';
import { createProductCommands, readProduct, readProducts } from './products.js';
import { createSettingsCommand, readSettings } from './settings.js';
import { createInvoiceReminderCommands, readInvoiceReminders } from './reminders.js';
export { createStripeRoutes } from './stripe-routes.js';
export {
  createRemoveStripeEndpointsTask,
  createSetUpStripeTask,
  readStripeConnection,
  removeStripeEndpointsReference,
  setUpStripeReference,
  STRIPE_WEBHOOK_SECRET_PURPOSE,
  stripeWebhookDigest,
  type StripeSealing,
  type StripeVault,
} from './stripe-connect.js';
export { createStripeCheckoutReference, createStripeCheckoutTask } from './stripe-checkout.js';
export {
  createStripeTransport,
  STRIPE_API_VERSION,
  type StripeTransport,
} from './stripe-transport.js';
import { requireRead, type CommerceOptions } from './shared.js';

export type {
  CommerceFile,
  CommerceFiles,
  CommerceLinks,
  CommerceMail,
  CommerceOptions,
  MailRefusal,
} from './shared.js';
export {
  createPublicDocumentHandlers,
  type PublicAnswer,
  type PublicCardPayments,
  type PublicDocumentHandlers,
  type PublicDocumentRequest,
} from './public.js';
export { commerceContactMerge } from './contact-merge.js';
export { DOCUMENT_PAGE_POLICY } from './print-html.js';
// The commands and the reads themselves, for whoever runs them outside these routes: the
// assistant's tools, an automation's steps. Each command goes through runCommand like any
// other. None names a delegation, so the command layer refuses every one of them to an
// assistant acting by itself; a person, an API key or an automation runs them. Letting an
// assistant propose a draft needs a kind of proposal and an autonomy action of its own,
// which the assistant's own work adds.
export {
  createDocumentCommands,
  readDocument,
  readDocuments,
  type DocumentCommands,
} from './documents.js';
export { readPayments, readReceipt } from './payment-reads.js';
export { createPaymentCommands, type PaymentCommands } from './payments.js';
export {
  createProductCommands,
  readProduct,
  readProducts,
  type ProductCommands,
} from './products.js';
export { createSendCommands, type SendCommands } from './sending.js';
export { createSettingsCommand, readSettings, type UpdateSettingsCommand } from './settings.js';
export {
  createInvoiceReminderCommands,
  readInvoiceReminders,
  sendInvoiceRemindersSweep,
  type CreateInvoiceReminderCommand,
  type DeleteInvoiceReminderCommand,
  type InvoiceReminderCommands,
  type UpdateInvoiceReminderCommand,
} from './reminders.js';

/**
 * The API's routes for products, quotes, invoices, payments and their settings, given the
 * other modules' readers. Reading the catalogue is open to everyone in the business;
 * reading anything else takes payments.read (or payments.manage, which includes it); every
 * change is a command that takes payments.manage.
 */
export function createCommerceRoutes(options: CommerceOptions): readonly ApiRoute[] {
  const products = createProductCommands(options);
  const documents = createDocumentCommands(options);
  const payments = createPaymentCommands(options);
  const settings = createSettingsCommand(options);
  const sends = createSendCommands(options, documents);
  const invoiceReminders = createInvoiceReminderCommands(options);

  // Products ------------------------------------------------------------------------------
  const productList = {
    endpoint: listProducts,
    run: ({ invocation, query }, { db }) => {
      requireBusiness(invocation.context);
      const input = parseInput(listProducts.query, query);
      return withTenant(db, invocation.context, (trx) => readProducts(trx, invocation, input));
    },
  } satisfies Route<typeof listProducts>;
  const productRead = {
    endpoint: getProduct,
    run: ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(getProduct.params, params);
      return withTenant(db, invocation.context, (trx) => readProduct(trx, invocation, id));
    },
  } satisfies Route<typeof getProduct>;
  const productCreate = {
    endpoint: createProduct,
    command: products.create,
    run: ({ invocation, body }, services) =>
      runCommand(services, products.create, body, invocation),
  } satisfies Route<typeof createProduct>;
  const productUpdate = {
    endpoint: updateProduct,
    command: products.update,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        products.update,
        { ...parseInput(updateProduct.body, body), ...parseInput(updateProduct.params, params) },
        invocation,
      ),
  } satisfies Route<typeof updateProduct>;
  const productShelve = (
    endpoint: typeof archiveProduct | typeof restoreProduct,
    command: (typeof products)['archive'],
  ): ApiRoute => ({
    endpoint,
    command,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        command,
        { ...parseInput(endpoint.body, body), ...parseInput(endpoint.params, params) },
        invocation,
      ),
  });
  const productDelete = {
    endpoint: deleteProduct,
    command: products.remove,
    run: ({ invocation, params }, services) =>
      runCommand(services, products.remove, parseInput(deleteProduct.params, params), invocation),
  } satisfies Route<typeof deleteProduct>;

  // Quotes and invoices -------------------------------------------------------------------
  const documentList = {
    endpoint: listSalesDocuments,
    async run({ invocation, query }, services) {
      await requireRead(services, invocation, 'sales_document.list');
      const input = parseInput(listSalesDocuments.query, query);
      return withTenant(services.db, invocation.context, (trx) =>
        readDocuments(options, trx, invocation, input),
      );
    },
  } satisfies Route<typeof listSalesDocuments>;
  const documentRead = {
    endpoint: getSalesDocument,
    async run({ invocation, params }, services) {
      await requireRead(services, invocation, 'sales_document.read');
      const { id } = parseInput(getSalesDocument.params, params);
      return withTenant(services.db, invocation.context, (trx) =>
        readDocument(options, trx, invocation, id),
      );
    },
  } satisfies Route<typeof getSalesDocument>;
  const documentCreate = {
    endpoint: createSalesDocument,
    command: documents.create,
    run: ({ invocation, body }, services) =>
      runCommand(services, documents.create, body, invocation),
  } satisfies Route<typeof createSalesDocument>;
  const documentUpdate = {
    endpoint: updateSalesDocument,
    command: documents.update,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        documents.update,
        // Parsed here first, so a refusal points into the body as the caller sent it.
        {
          ...parseInput(updateSalesDocument.params, params),
          values: parseInput(updateSalesDocument.body, body),
        },
        invocation,
      ),
  } satisfies Route<typeof updateSalesDocument>;
  const documentDelete = {
    endpoint: deleteSalesDocument,
    command: documents.remove,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        documents.remove,
        parseInput(deleteSalesDocument.params, params),
        invocation,
      ),
  } satisfies Route<typeof deleteSalesDocument>;
  const documentIssue = {
    endpoint: issueSalesDocument,
    command: documents.issue,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        documents.issue,
        {
          ...parseInput(issueSalesDocument.body, body),
          ...parseInput(issueSalesDocument.params, params),
        },
        invocation,
      ),
  } satisfies Route<typeof issueSalesDocument>;
  // Revising, answering, converting and copying take the document alone.
  const documentAction = (
    endpoint:
      | typeof reviseSalesDocument
      | typeof acceptQuote
      | typeof declineQuote
      | typeof convertQuoteToInvoice
      | typeof duplicateSalesDocument,
    command: (typeof documents)['revise'],
  ): ApiRoute => ({
    endpoint,
    command,
    run: ({ invocation, params }, services) =>
      runCommand(services, command, parseInput(endpoint.params, params), invocation),
  });
  const documentVoid = {
    endpoint: voidInvoice,
    command: documents.void,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        documents.void,
        { ...parseInput(voidInvoice.body, body), ...parseInput(voidInvoice.params, params) },
        invocation,
      ),
  } satisfies Route<typeof voidInvoice>;
  const documentNote = {
    endpoint: setSalesDocumentNote,
    command: documents.setNote,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        documents.setNote,
        {
          ...parseInput(setSalesDocumentNote.body, body),
          ...parseInput(setSalesDocumentNote.params, params),
        },
        invocation,
      ),
  } satisfies Route<typeof setSalesDocumentNote>;

  // Printing and sharing --------------------------------------------------------- A PDF is
  // read behind the permission its document is read behind. What it says is read in one
  // transaction; it is drawn after that one has ended.
  const documentPdf = {
    endpoint: getSalesDocumentPdf,
    async run({ invocation, params }, services) {
      await requireRead(services, invocation, 'sales_document.pdf');
      const { id } = parseInput(getSalesDocumentPdf.params, params);
      return pdfOf(
        await withTenant(services.db, invocation.context, (trx) =>
          readPrintableDocument(options, trx, invocation, id),
        ),
      );
    },
  } satisfies Route<typeof getSalesDocumentPdf>;
  const receiptPdf = {
    endpoint: getReceiptPdf,
    async run({ invocation, params }, services) {
      await requireRead(services, invocation, 'payment.pdf');
      const { id } = parseInput(getReceiptPdf.params, params);
      return pdfOf(
        await withTenant(services.db, invocation.context, (trx) =>
          readPrintableReceipt(options, trx, invocation, id),
        ),
      );
    },
  } satisfies Route<typeof getReceiptPdf>;
  const documentLink = {
    endpoint: createSalesDocumentLink,
    command: documents.link,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        documents.link,
        {
          ...parseInput(createSalesDocumentLink.body, body),
          ...parseInput(createSalesDocumentLink.params, params),
        },
        invocation,
      ),
  } satisfies Route<typeof createSalesDocumentLink>;

  const documentSend = {
    endpoint: sendSalesDocument,
    command: sends.document,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        sends.document,
        {
          ...parseInput(sendSalesDocument.params, params),
          values: parseInput(sendSalesDocument.body, body),
        },
        invocation,
      ),
  } satisfies Route<typeof sendSalesDocument>;
  const receiptSend = {
    endpoint: sendReceipt,
    command: sends.receipt,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        sends.receipt,
        {
          ...parseInput(sendReceipt.params, params),
          values: parseInput(sendReceipt.body, body),
        },
        invocation,
      ),
  } satisfies Route<typeof sendReceipt>;

  // Payments and receipts -----------------------------------------------------------------
  const paymentList = {
    endpoint: listPayments,
    async run({ invocation, query }, services) {
      await requireRead(services, invocation, 'payment.list');
      const input = parseInput(listPayments.query, query);
      return withTenant(services.db, invocation.context, (trx) =>
        readPayments(trx, invocation, input),
      );
    },
  } satisfies Route<typeof listPayments>;
  const paymentRecord = {
    endpoint: recordPayment,
    command: payments.record,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        payments.record,
        {
          ...parseInput(recordPayment.params, params),
          payment: parseInput(recordPayment.body, body),
        },
        invocation,
      ),
  } satisfies Route<typeof recordPayment>;
  const receiptRead = {
    endpoint: getReceipt,
    async run({ invocation, params }, services) {
      await requireRead(services, invocation, 'payment.read');
      const { id } = parseInput(getReceipt.params, params);
      return withTenant(services.db, invocation.context, (trx) => readReceipt(trx, invocation, id));
    },
  } satisfies Route<typeof getReceipt>;
  const paymentReverse = {
    endpoint: reversePayment,
    command: payments.reverse,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        payments.reverse,
        { ...parseInput(reversePayment.body, body), ...parseInput(reversePayment.params, params) },
        invocation,
      ),
  } satisfies Route<typeof reversePayment>;

  // Settings ------------------------------------------------------------------------------
  const settingsRead = {
    endpoint: getCommerceSettings,
    async run({ invocation }, services) {
      await requireRead(services, invocation, 'commerce_settings.read');
      const businessId = requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, (trx) =>
        readSettings(trx, invocation, businessId),
      );
    },
  } satisfies Route<typeof getCommerceSettings>;
  const settingsUpdate = {
    endpoint: updateCommerceSettings,
    command: settings,
    run: ({ invocation, body }, services) => runCommand(services, settings, body, invocation),
  } satisfies Route<typeof updateCommerceSettings>;

  // Invoice Reminders ---------------------------------------------------------------------
  const invoiceReminderList = {
    endpoint: listInvoiceReminders,
    async run({ invocation }, services) {
      await requireRead(services, invocation, 'invoice_reminders.read');
      const businessId = requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, (trx) =>
        readInvoiceReminders(trx, invocation, businessId),
      );
    },
  } satisfies Route<typeof listInvoiceReminders>;

  const invoiceReminderCreate = {
    endpoint: createInvoiceReminder,
    command: invoiceReminders.create,
    run: ({ invocation, body }, services) =>
      runCommand(services, invoiceReminders.create, body, invocation),
  } satisfies Route<typeof createInvoiceReminder>;

  const invoiceReminderUpdate = {
    endpoint: updateInvoiceReminder,
    command: invoiceReminders.update,
    run: ({ invocation, params, body }, services) => {
      const input = parseInput(updateInvoiceReminder.params, params);
      return runCommand(
        services,
        invoiceReminders.update,
        { id: input.id, values: body },
        invocation,
      );
    },
  } satisfies Route<typeof updateInvoiceReminder>;

  const invoiceReminderDelete = {
    endpoint: deleteInvoiceReminder,
    command: invoiceReminders.delete,
    run: ({ invocation, params }, services) => {
      const input = parseInput(deleteInvoiceReminder.params, params);
      return runCommand(services, invoiceReminders.delete, { id: input.id }, invocation);
    },
  } satisfies Route<typeof deleteInvoiceReminder>;

  return [
    productList,
    productCreate,
    productRead,
    productUpdate,
    productShelve(archiveProduct, products.archive),
    productShelve(restoreProduct, products.restore),
    productDelete,
    documentList,
    documentCreate,
    documentRead,
    documentUpdate,
    documentDelete,
    documentIssue,
    documentAction(reviseSalesDocument, documents.revise),
    documentAction(acceptQuote, documents.accept),
    documentAction(declineQuote, documents.decline),
    documentAction(convertQuoteToInvoice, documents.convert),
    documentVoid,
    documentAction(duplicateSalesDocument, documents.duplicate),
    documentNote,
    paymentList,
    paymentRecord,
    receiptRead,
    paymentReverse,
    settingsRead,
    settingsUpdate,
    invoiceReminderList,
    invoiceReminderCreate,
    invoiceReminderUpdate,
    invoiceReminderDelete,
    documentPdf,
    receiptPdf,
    documentLink,
    documentSend,
    receiptSend,
  ];
}
