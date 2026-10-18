// Commerce, stage 1: the catalogue of products and services, quotes and invoices, payments
// with their receipts, and the business's settings for them. GoHighLevel calls these
// Products, Estimates, Invoices and Transactions, under Payments.
//
// Every amount is a decimal string, never a float: four places, as numeric(19, 4) holds it.
// What a document comes to is worked out by one function (commerce-money.ts), which this
// contract runs to refuse numbers that cannot be and which the server runs again to store
// the result.
import { isAmount, isCurrencyCode } from '@repo/kernel';
import * as z from 'zod';

import { businessAddress } from './business-profile.js';
import { computeDocumentTotals, toUnits } from './commerce-money.js';
import {
  invoiceStatuses,
  MAX_SEQUENCE_NUMBER,
  paymentMethods,
  quoteStatuses,
  salesDocumentActions,
  salesDocumentKinds,
  salesDocumentStatuses,
} from './commerce-rules.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

export const COMMERCE_LIMITS = {
  /** The lines one quote or invoice holds. */
  lines: 200,
  pageSize: 200,
} as const;

/** What one of a product is, as a screen may offer; any short text is accepted. */
export const PRODUCT_UNIT_SUGGESTIONS = [
  'item',
  'hour',
  'day',
  'week',
  'month',
  'session',
  'person',
  'km',
  'kg',
] as const;

const nonnegativeDecimal = (value: string): boolean => isAmount(value) && !value.startsWith('-');

const moneyInput = z
  .string()
  .refine(nonnegativeDecimal, {
    error: 'Enter a nonnegative decimal amount with at most four decimal places.',
  })
  .meta({ examples: ['1500.00'] });
/** An amount as the API returns it: always four places. */
const money = z.string().meta({
  description: 'A decimal amount, exact to four places.',
  examples: ['1500.0000'],
});
const percentInput = z
  .string()
  .refine((value) => nonnegativeDecimal(value) && toUnits(value) <= toUnits('100'), {
    error: 'Enter a percentage from 0 to 100, with at most four decimal places.',
  })
  .meta({ examples: ['16'] });
const currency = z
  .string()
  .refine(isCurrencyCode, { error: 'Enter a currency code, such as KES.' })
  .meta({ examples: ['KES'] });
const calendarDate = z.iso
  .date({ error: 'Enter a calendar date.' })
  .meta({ examples: ['2026-10-12'] });
/**
 * A number of a quote's or an invoice's arithmetic, as text. The arithmetic itself says
 * whether it is one (commerce-money.ts), so each is refused once, with one code.
 */
const decimalText = z.string().max(40);
const revision = z.int().min(1).meta({
  description: 'The revision it was read at. A stale one returns 409 and changes nothing.',
});
const pageLimit = z.coerce.number().int().min(1).max(COMMERCE_LIMITS.pageSize).default(50);

// Products and services -----------------------------------------------------------------------

export const productKinds = ['product', 'service'] as const;
export type ProductKind = (typeof productKinds)[number];

const productValues = z.strictObject({
  kind: z.enum(productKinds),
  name: z.string().trim().min(1, { error: 'Give it a name.' }).max(200),
  description: z.string().trim().max(5000).default(''),
  sku: z
    .string()
    .trim()
    .min(1, { error: 'Enter a code, or leave it out.' })
    .max(64)
    .nullable()
    .default(null)
    .meta({
      description:
        "The business's own code for it. Optional; no two of a business's products share one, whatever its capitals.",
      examples: ['PLAN-01'],
    }),
  unit: z
    .string()
    .trim()
    .max(32)
    .default('')
    .meta({
      description: 'What one of it is, in any short words. Empty when it has no unit.',
      examples: ['hour'],
    }),
  unitPrice: moneyInput.meta({ description: 'The price of one, before tax.' }),
  currency,
  taxRate: percentInput.nullable().default(null).meta({
    description:
      "The tax charged on it, in percent. Null: the business's default rate applies when it is put on a document.",
  }),
});
export const createProductInput = productValues.meta({ id: 'CreateProductInput' });
export const updateProductInput = productValues
  .extend({ revision })
  .meta({ id: 'UpdateProductInput' });
export const productRevisionInput = z
  .strictObject({ revision })
  .meta({ id: 'ProductRevisionInput' });
export type CreateProductInput = z.input<typeof createProductInput>;
export type UpdateProductInput = z.input<typeof updateProductInput>;

export const product = z
  .looseObject({
    id: publicId('product'),
    kind: z.enum(productKinds),
    name: z.string(),
    description: z.string(),
    sku: z.string().nullable(),
    unit: z.string(),
    unitPrice: money,
    currency: z.string(),
    taxRate: z.string().nullable().meta({ description: 'Percent, to four places, or null.' }),
    archived: z.boolean().meta({
      description:
        'An archived product is not offered for new lines; documents that use it keep it.',
    }),
    archivedAt: timestamp.nullable(),
    used: z.boolean().meta({
      description:
        'Whether a quote or an invoice names it. One that is used can be archived, not deleted.',
    }),
    revision,
    canManage: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({
    id: 'Product',
    description: 'A product or a service the business sells, with its rate.',
  });
export type Product = z.output<typeof product>;

export const productList = z
  .strictObject({
    items: z.array(product),
    nextCursor: publicId('product').nullable(),
    canManage: z.boolean(),
  })
  .meta({ id: 'ProductList' });
export type ProductList = z.output<typeof productList>;

export const listProductsQuery = z.strictObject({
  q: z.string().trim().max(200).optional().meta({
    description: 'Finds products by any part of their name or code.',
  }),
  kind: z.enum(productKinds).optional(),
  archived: z.enum(['true', 'false']).default('false').meta({
    description: 'true lists the archived products; false, the default, the ones in use.',
  }),
  after: publicId('product').optional(),
  limit: pageLimit,
});

const productParams = z.strictObject({ id: publicId('product') });
const productGroup = 'Products';

export const listProducts = defineEndpoint({
  operationId: 'listProducts',
  method: 'get',
  path: '/products',
  summary: 'List products and services by name',
  group: productGroup,
  query: listProductsQuery,
  response: { status: 200, description: 'A page of products.', schema: productList },
});
export const createProduct = defineEndpoint({
  operationId: 'createProduct',
  method: 'post',
  path: '/products',
  summary: 'Add a product or a service with its rate',
  group: productGroup,
  body: createProductInput,
  response: { status: 201, description: 'The product.', schema: product },
});
export const getProduct = defineEndpoint({
  operationId: 'getProduct',
  method: 'get',
  path: '/products/{id}',
  summary: 'Read a product',
  group: productGroup,
  params: productParams,
  response: { status: 200, description: 'The product.', schema: product },
});
export const updateProduct = defineEndpoint({
  operationId: 'updateProduct',
  method: 'put',
  path: '/products/{id}',
  summary: 'Change a product; documents that already use it keep what they say',
  group: productGroup,
  params: productParams,
  body: updateProductInput,
  response: { status: 200, description: 'The product.', schema: product },
});
export const archiveProduct = defineEndpoint({
  operationId: 'archiveProduct',
  method: 'post',
  path: '/products/{id}/archive',
  summary: 'Archive a product, so it is no longer offered for new lines',
  group: productGroup,
  params: productParams,
  body: productRevisionInput,
  response: { status: 200, description: 'The archived product.', schema: product },
});
export const restoreProduct = defineEndpoint({
  operationId: 'restoreProduct',
  method: 'post',
  path: '/products/{id}/restore',
  summary: 'Bring an archived product back',
  group: productGroup,
  params: productParams,
  body: productRevisionInput,
  response: { status: 200, description: 'The product.', schema: product },
});
export const deleteProduct = defineEndpoint({
  operationId: 'deleteProduct',
  method: 'delete',
  path: '/products/{id}',
  summary: 'Delete a product no quote or invoice names; one that is used is archived instead',
  group: productGroup,
  params: productParams,
  response: { status: 204, description: 'The product is gone.' },
});

// Quotes and invoices -------------------------------------------------------------------------

export const discount = z
  .strictObject({
    kind: z.enum(['percent', 'amount']),
    value: decimalText.meta({
      description:
        "A nonnegative decimal: 0 to 100 for a percentage; else an amount in the document's currency, in the currency's own units.",
      examples: ['10'],
    }),
  })
  .meta({ id: 'Discount', description: 'Money off: a percentage, or an amount.' });
export type Discount = z.output<typeof discount>;

export const salesDocumentLineInput = z
  .strictObject({
    productId: publicId('product').nullable().default(null).meta({
      description:
        'The product the line was taken from, if any. The line keeps its own name, unit, price and tax rate.',
    }),
    name: z.string().trim().min(1, { error: 'Say what the line is for.' }).max(200),
    description: z.string().trim().max(5000).default(''),
    quantity: decimalText.meta({
      description: 'A decimal above zero, with at most four decimal places.',
      examples: ['2.5'],
    }),
    unit: z.string().trim().max(32).default(''),
    unitPrice: decimalText.meta({
      description:
        'The price of one, before tax: a nonnegative decimal with at most four decimal places.',
      examples: ['1500.00'],
    }),
    discount: discount.nullable().default(null).meta({
      description: 'Money off this line, before tax. No more than the line comes to.',
    }),
    taxRate: decimalText
      .nullable()
      .default(null)
      .meta({
        description: 'The tax on this line, in percent from 0 to 100. Null: none.',
        examples: ['16'],
      }),
  })
  .meta({ id: 'SalesDocumentLineInput' });

const documentValues = z.strictObject({
  contactId: publicId('contact').meta({ description: 'Who the document is for.' }),
  dealId: publicId('deal').nullable().default(null).meta({
    description: 'The opportunity it belongs to, if any.',
  }),
  currency,
  issueDate: calendarDate.nullable().default(null).meta({
    description:
      "The date printed on it. Null: the day it is first issued, in the business's time zone. A draft that already has a number keeps the date it was issued with unless another is named.",
  }),
  dueDate: calendarDate.nullable().default(null).meta({
    description:
      "For an invoice, the day payment is due; for a quote, the last day it can be accepted. Null: worked out when it is issued, from the business's payment terms or quote validity.",
  }),
  lines: z
    .array(salesDocumentLineInput)
    .max(COMMERCE_LIMITS.lines, { error: `Use at most ${String(COMMERCE_LIMITS.lines)} lines.` })
    .meta({ description: 'In the order they are printed. A draft may have none yet.' }),
  discount: discount.nullable().default(null).meta({
    description:
      "Money off the whole document, after the lines' own discounts and before tax. It is shared over the lines in proportion, so each tax rate is charged on what is paid.",
  }),
  notes: z.string().trim().max(5000).optional().meta({
    description:
      "For the customer, printed on the document. Left out of a new document: the business's default notes. Left out of an edit: unchanged.",
  }),
  terms: z.string().trim().max(10000).optional().meta({
    description:
      "Terms and conditions. Left out of a new document: the business's default terms. Left out of an edit: unchanged.",
  }),
  billTo: z.string().trim().max(1000).default('').meta({
    description: "The customer's billing address, as it should be printed.",
  }),
  customerTaxNumber: z.string().trim().min(1).max(64).nullable().default(null).meta({
    description: "The customer's tax number, when the document must show it.",
  }),
});

/** Runs the document's arithmetic, and reports each number it refuses where it was typed. */
function refineTotals(
  input: {
    readonly currency: string;
    readonly lines: readonly z.output<typeof salesDocumentLineInput>[];
    readonly discount: Discount | null;
  },
  context: z.RefinementCtx,
): void {
  const result = computeDocumentTotals(input);
  if (result.ok) return;
  for (const issue of result.issues)
    context.addIssue({
      code: 'custom',
      path: [...issue.path],
      message: issue.message,
      params: { code: issue.code },
    });
}

export const createSalesDocumentInput = documentValues
  .extend({ kind: z.enum(salesDocumentKinds) })
  .superRefine(refineTotals)
  .meta({ id: 'CreateSalesDocumentInput' });
export const updateSalesDocumentInput = documentValues
  .extend({ revision })
  .superRefine(refineTotals)
  .meta({ id: 'UpdateSalesDocumentInput' });
export const salesDocumentRevisionInput = z
  .strictObject({ revision })
  .meta({ id: 'SalesDocumentRevisionInput' });
export type CreateSalesDocumentInput = z.input<typeof createSalesDocumentInput>;
export type UpdateSalesDocumentInput = z.input<typeof updateSalesDocumentInput>;

export const salesDocumentLine = z
  .looseObject({
    id: publicId('sales_document_line'),
    position: z.int().min(0),
    productId: publicId('product').nullable(),
    name: z.string(),
    description: z.string(),
    quantity: z.string().meta({ examples: ['2.5000'] }),
    unit: z.string(),
    unitPrice: money,
    discount: discount.nullable(),
    taxRate: z.string().meta({ description: 'Percent, to four places.', examples: ['16.0000'] }),
    amount: money.meta({ description: 'Quantity times unit price.' }),
    discountAmount: money.meta({ description: "The line's own discount." }),
    taxableAmount: money.meta({
      description:
        "What tax is charged on: the amount less the line's discount and its share of the document's discount.",
    }),
    taxAmount: money,
    total: money.meta({ description: 'Taxable amount plus tax.' }),
  })
  .meta({ id: 'SalesDocumentLine' });
export type SalesDocumentLine = z.output<typeof salesDocumentLine>;

/** Who a document is from, as the business was when it was issued. */
export const sellerSnapshot = z
  .looseObject({
    name: z.string(),
    address: businessAddress.nullable(),
    taxNumber: z.string().nullable(),
    logoFileId: publicId('file').nullable().meta({
      description:
        "The business's logo when the document was issued; read it through the files API.",
    }),
    paymentInstructions: z.string().meta({
      description: 'How to pay: bank or mobile money details, as the settings had them.',
    }),
  })
  .meta({ id: 'SellerSnapshot' });
export type SellerSnapshot = z.output<typeof sellerSnapshot>;

/**
 * Who a document is for: as the contact was when the draft was last saved, then as they
 * were when it was issued.
 */
export const customerSnapshot = z
  .looseObject({
    name: z.string().meta({ description: 'Empty when the contact has no name.' }),
    email: z.string().nullable(),
    phone: z.string().nullable().meta({ description: 'In E.164.' }),
    billTo: z.string(),
    taxNumber: z.string().nullable(),
  })
  .meta({ id: 'CustomerSnapshot' });
export type CustomerSnapshot = z.output<typeof customerSnapshot>;

export const salesDocumentTotals = z
  .looseObject({
    subtotal: money.meta({ description: "The lines' amounts, before any discount." }),
    lineDiscountTotal: money,
    documentDiscount: money,
    discountTotal: money.meta({ description: 'Both kinds of discount together.' }),
    taxes: z
      .array(z.looseObject({ rate: z.string(), taxable: money, tax: money }))
      .meta({ description: 'One entry for each tax rate on the document, lowest first.' }),
    taxTotal: money,
    total: money.meta({ description: 'Subtotal less discounts plus tax.' }),
    amountPaid: money.meta({ description: 'Payments recorded and not reversed. Zero on a quote.' }),
    balanceDue: money.meta({ description: 'Total less amount paid.' }),
  })
  .meta({ id: 'SalesDocumentTotals' });

const paymentStatuses = ['recorded', 'reversed'] as const;

export const payment = z
  .looseObject({
    id: publicId('payment'),
    number: z.string().meta({ description: 'The receipt number.', examples: ['RCT-0001'] }),
    invoiceId: publicId('sales_document'),
    invoiceNumber: z.string(),
    contactId: publicId('contact').nullable(),
    customerName: z.string(),
    amount: money,
    currency: z.string(),
    paidOn: calendarDate.meta({ description: 'The day the money was received.' }),
    method: z.enum(paymentMethods),
    reference: z.string().nullable().meta({
      description: "The bank's, the mobile money or the cheque's own reference.",
    }),
    note: z.string(),
    balanceAfter: money.meta({
      description: 'What was still owed on the invoice once this payment was recorded.',
    }),
    status: z.enum(paymentStatuses),
    reversedAt: timestamp.nullable(),
    reversalReason: z.string().nullable(),
    lastSentAt: timestamp.nullable().optional().meta({
      description: 'When its receipt was last sent to the customer; null when it never was.',
    }),
    sendCount: z.int().min(0).optional().meta({
      description: 'How many times its receipt was sent to the customer.',
    }),
    createdAt: timestamp,
  })
  .meta({
    id: 'Payment',
    description: 'Money received against an invoice. Each one is a receipt.',
  });
export type Payment = z.output<typeof payment>;

/** Where a quote's or an invoice's public page is served: /d/<token>. */
export const SALES_DOCUMENT_LINK_PATH = '/d';
/** The token in a public link: 32 bytes nobody can guess, in base64url. */
export const salesDocumentLinkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const salesDocumentLink = z
  .looseObject({
    url: z.url().meta({
      description:
        'Opens a read-only page of the document, with its PDF, for whoever holds the address. No sign-in. A sent quote can be accepted or declined there.',
      examples: ['https://crm.example.com/d/3q2-7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    }),
    createdAt: timestamp.meta({
      description: 'When this address was made. Making a new one stops the one before.',
    }),
  })
  .meta({ id: 'SalesDocumentLink', description: "A document's public address." });
export type SalesDocumentLink = z.output<typeof salesDocumentLink>;

export const salesDocument = z
  .looseObject({
    id: publicId('sales_document'),
    kind: z.enum(salesDocumentKinds),
    status: z.enum(salesDocumentStatuses).meta({
      description: `A quote is one of ${quoteStatuses.join(', ')}; an invoice one of ${invoiceStatuses.join(', ')}. Overdue and expired are not statuses: see the two flags.`,
    }),
    number: z
      .string()
      .nullable()
      .meta({
        description:
          'Given when the document is first issued, and kept for good. Null on a new draft.',
        examples: ['INV-0001'],
      }),
    contactId: publicId('contact').nullable().meta({
      description:
        'Null only once the contact was deleted for good; customer still says who it was for.',
    }),
    dealId: publicId('deal').nullable(),
    quoteId: publicId('sales_document').nullable().meta({
      description: 'On an invoice: the quote it was made from.',
    }),
    invoiceId: publicId('sales_document').nullable().meta({
      description: 'On a quote: the invoice made from it.',
    }),
    currency: z.string(),
    issueDate: calendarDate.nullable(),
    dueDate: calendarDate.nullable().meta({
      description: "An invoice's due date; a quote's last day to be accepted.",
    }),
    customer: customerSnapshot,
    seller: sellerSnapshot.nullable().meta({
      description:
        'Null until the document is issued. A screen shows a draft with the current business profile and settings.',
    }),
    lines: z.array(salesDocumentLine),
    discount: discount.nullable(),
    notes: z.string(),
    terms: z.string(),
    internalNote: z.string().meta({ description: 'For the team. Never printed.' }),
    totals: salesDocumentTotals,
    overdue: z.boolean().meta({
      description:
        "An invoice that was issued, is not void, still has a balance, and whose due date has gone by in the business's time zone. Worked out when read.",
    }),
    expired: z.boolean().meta({
      description:
        "A quote that was sent, has no answer, and whose last day has gone by in the business's time zone. Worked out when read.",
    }),
    issuedAt: timestamp.nullable(),
    acceptedAt: timestamp.nullable(),
    declinedAt: timestamp.nullable(),
    voidedAt: timestamp.nullable(),
    voidReason: z.string().nullable(),
    sentAt: timestamp.nullable().optional().meta({
      description:
        'When the document was first sent to the customer by email. Null when it never was: issuing sends nothing.',
    }),
    lastSentAt: timestamp.nullable().optional().meta({
      description: 'When it was last sent to the customer.',
    }),
    sendCount: z.int().min(0).optional().meta({
      description: 'How many times it was sent to the customer.',
    }),
    publicLink: salesDocumentLink.nullable().optional().meta({
      description:
        'The public address of an issued document, once it has one. Null on a draft, and where the install serves no public pages.',
    }),
    payments: z.array(payment).meta({
      description: "An invoice's payments, oldest first, reversed ones included. Empty on a quote.",
    }),
    actions: z.array(z.enum(salesDocumentActions)).meta({
      description:
        'What can be done to the document as it stands, whoever asks. Whether you may is canManage.',
    }),
    revision,
    canManage: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'SalesDocument', description: 'A quote or an invoice.' });
export type SalesDocument = z.output<typeof salesDocument>;

export const salesDocumentSummary = z
  .looseObject({
    id: publicId('sales_document'),
    kind: z.enum(salesDocumentKinds),
    status: z.enum(salesDocumentStatuses),
    number: z.string().nullable(),
    contactId: publicId('contact').nullable(),
    customerName: z.string(),
    dealId: publicId('deal').nullable(),
    currency: z.string(),
    issueDate: calendarDate.nullable(),
    dueDate: calendarDate.nullable(),
    total: money,
    amountPaid: money,
    balanceDue: money,
    overdue: z.boolean(),
    expired: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'SalesDocumentSummary' });
export type SalesDocumentSummary = z.output<typeof salesDocumentSummary>;

export const salesDocumentList = z
  .strictObject({
    items: z.array(salesDocumentSummary),
    nextCursor: publicId('sales_document').nullable(),
    canManage: z.boolean(),
  })
  .meta({ id: 'SalesDocumentList' });
export type SalesDocumentList = z.output<typeof salesDocumentList>;

/** What the list can be narrowed to: a stored status, or one of the two read from dates. */
export const salesDocumentListStatuses = [
  'all',
  ...salesDocumentStatuses,
  'overdue',
  'expired',
] as const;

export const listSalesDocumentsQuery = z.strictObject({
  kind: z.enum(salesDocumentKinds).optional().meta({
    description: 'Quotes or invoices. Left out: both, as a contact’s panel lists them.',
  }),
  status: z.enum(salesDocumentListStatuses).default('all').meta({
    description:
      'A status, or overdue (invoices past their due date with a balance) or expired (sent quotes past their last day).',
  }),
  contactId: publicId('contact').optional(),
  dealId: publicId('deal').optional(),
  q: z.string().trim().max(200).optional().meta({
    description: "Finds documents by any part of their number or of the customer's name.",
  }),
  issuedFrom: calendarDate.optional().meta({ description: 'Issue date on or after this day.' }),
  issuedTo: calendarDate.optional().meta({ description: 'Issue date on or before this day.' }),
  after: publicId('sales_document').optional(),
  limit: pageLimit,
});

const documentParams = z.strictObject({ id: publicId('sales_document') });
const documentGroup = 'Quotes and invoices';

export const listSalesDocuments = defineEndpoint({
  operationId: 'listSalesDocuments',
  method: 'get',
  path: '/sales-documents',
  summary: 'List quotes and invoices, newest first',
  group: documentGroup,
  query: listSalesDocumentsQuery,
  response: { status: 200, description: 'A page of documents.', schema: salesDocumentList },
});
export const createSalesDocument = defineEndpoint({
  operationId: 'createSalesDocument',
  method: 'post',
  path: '/sales-documents',
  summary: 'Start a quote or an invoice as a draft',
  group: documentGroup,
  body: createSalesDocumentInput,
  response: { status: 201, description: 'The draft, with its totals.', schema: salesDocument },
});
export const getSalesDocument = defineEndpoint({
  operationId: 'getSalesDocument',
  method: 'get',
  path: '/sales-documents/{id}',
  summary: 'Read a quote or an invoice with its lines, totals and payments',
  group: documentGroup,
  params: documentParams,
  response: { status: 200, description: 'The document.', schema: salesDocument },
});
export const updateSalesDocument = defineEndpoint({
  operationId: 'updateSalesDocument',
  method: 'put',
  path: '/sales-documents/{id}',
  summary: 'Save a draft: its lines replace the ones it had',
  group: documentGroup,
  params: documentParams,
  body: updateSalesDocumentInput,
  response: { status: 200, description: 'The draft, with its totals.', schema: salesDocument },
});
export const deleteSalesDocument = defineEndpoint({
  operationId: 'deleteSalesDocument',
  method: 'delete',
  path: '/sales-documents/{id}',
  summary: 'Delete a draft that was never issued',
  group: documentGroup,
  params: documentParams,
  response: { status: 204, description: 'The draft is gone.' },
});
export const issueSalesDocument = defineEndpoint({
  operationId: 'issueSalesDocument',
  method: 'post',
  path: '/sales-documents/{id}/issue',
  summary: 'Issue a draft: it gets its number, is marked sent and can no longer be edited',
  group: documentGroup,
  params: documentParams,
  body: salesDocumentRevisionInput,
  response: {
    status: 200,
    description:
      'The issued document, with its number and who it is from and for as they are now. Issuing sends nothing by itself.',
    schema: salesDocument,
  },
});
export const reviseSalesDocument = defineEndpoint({
  operationId: 'reviseSalesDocument',
  method: 'post',
  path: '/sales-documents/{id}/revise',
  summary: 'Return an issued quote, or an invoice with no payment, to a draft with the same number',
  group: documentGroup,
  params: documentParams,
  response: { status: 200, description: 'The document as a draft.', schema: salesDocument },
});
export const acceptQuote = defineEndpoint({
  operationId: 'acceptQuote',
  method: 'post',
  path: '/sales-documents/{id}/accept',
  summary: 'Mark a sent quote accepted',
  group: documentGroup,
  params: documentParams,
  response: { status: 200, description: 'The accepted quote.', schema: salesDocument },
});
export const declineQuote = defineEndpoint({
  operationId: 'declineQuote',
  method: 'post',
  path: '/sales-documents/{id}/decline',
  summary: 'Mark a sent quote declined',
  group: documentGroup,
  params: documentParams,
  response: { status: 200, description: 'The declined quote.', schema: salesDocument },
});
export const convertQuoteToInvoice = defineEndpoint({
  operationId: 'convertQuoteToInvoice',
  method: 'post',
  path: '/sales-documents/{id}/convert',
  summary: 'Make a draft invoice from a sent or accepted quote, once',
  group: documentGroup,
  params: documentParams,
  response: {
    status: 201,
    description: "The draft invoice, with the quote's lines and a link back to it.",
    schema: salesDocument,
  },
});
export const voidInvoiceInput = z
  .strictObject({
    reason: z.string().trim().min(1, { error: 'Say why the invoice is void.' }).max(500),
  })
  .meta({ id: 'VoidInvoiceInput' });
export const voidInvoice = defineEndpoint({
  operationId: 'voidInvoice',
  method: 'post',
  path: '/sales-documents/{id}/void',
  summary: 'Void an invoice with no payment on it; it is kept, with the reason',
  group: documentGroup,
  params: documentParams,
  body: voidInvoiceInput,
  response: { status: 200, description: 'The void invoice.', schema: salesDocument },
});
export const duplicateSalesDocument = defineEndpoint({
  operationId: 'duplicateSalesDocument',
  method: 'post',
  path: '/sales-documents/{id}/duplicate',
  summary: 'Copy a quote or an invoice into a new draft of the same kind',
  group: documentGroup,
  params: documentParams,
  response: { status: 201, description: 'The new draft.', schema: salesDocument },
});
export const salesDocumentNoteInput = z
  .strictObject({ internalNote: z.string().trim().max(5000) })
  .meta({ id: 'SalesDocumentNoteInput' });
export const setSalesDocumentNote = defineEndpoint({
  operationId: 'setSalesDocumentNote',
  method: 'put',
  path: '/sales-documents/{id}/internal-note',
  summary: "Write the team's own note on a document, issued or not",
  group: documentGroup,
  params: documentParams,
  body: salesDocumentNoteInput,
  response: { status: 200, description: 'The document.', schema: salesDocument },
});

// Payments and receipts -----------------------------------------------------------------------

export const recordPaymentInput = z
  .strictObject({
    amount: z
      .string()
      .refine((value) => nonnegativeDecimal(value) && toUnits(value) > 0n, {
        error: 'Enter an amount above zero, with at most four decimal places.',
      })
      .meta({
        examples: ['1500.00'],
        description:
          "In the invoice's currency, in the currency's own units, and no more than is still owed.",
      }),
    paidOn: calendarDate.optional().meta({
      description: "The day the money was received. Left out: today, in the business's time zone.",
    }),
    method: z.enum(paymentMethods),
    reference: z.string().trim().min(1).max(200).nullable().default(null),
    note: z.string().trim().max(2000).default(''),
  })
  .meta({ id: 'RecordPaymentInput' });
export type RecordPaymentInput = z.input<typeof recordPaymentInput>;

export const reversePaymentInput = z
  .strictObject({
    reason: z.string().trim().min(1, { error: 'Say why the payment is reversed.' }).max(500),
  })
  .meta({ id: 'ReversePaymentInput' });

/** What a receipt prints: the payment, who it is from and for, and where the invoice stands. */
export const receipt = payment
  .extend({
    seller: sellerSnapshot,
    customer: customerSnapshot,
    invoice: z.looseObject({
      id: publicId('sales_document'),
      number: z.string(),
      status: z.enum(invoiceStatuses),
      issueDate: calendarDate.nullable(),
      dueDate: calendarDate.nullable(),
      total: money,
      amountPaid: money.meta({ description: 'As it stands now, not as it was at this payment.' }),
      balanceDue: money,
    }),
    canManage: z.boolean(),
  })
  .meta({ id: 'Receipt' });
export type Receipt = z.output<typeof receipt>;

export const paymentList = z
  .strictObject({
    items: z.array(payment),
    nextCursor: publicId('payment').nullable(),
    canManage: z.boolean(),
  })
  .meta({ id: 'PaymentList' });
export type PaymentList = z.output<typeof paymentList>;

const paymentParams = z.strictObject({ id: publicId('payment') });
const paymentGroup = 'Payments';

export const listPayments = defineEndpoint({
  operationId: 'listPayments',
  method: 'get',
  path: '/payments',
  summary: 'List payments received, newest first',
  group: paymentGroup,
  query: z.strictObject({
    invoiceId: publicId('sales_document').optional(),
    contactId: publicId('contact').optional(),
    status: z.enum(['all', ...paymentStatuses]).default('all'),
    after: publicId('payment').optional(),
    limit: pageLimit,
  }),
  response: { status: 200, description: 'A page of payments.', schema: paymentList },
});
export const recordPayment = defineEndpoint({
  operationId: 'recordPayment',
  method: 'post',
  path: '/sales-documents/{id}/payments',
  summary: 'Record a payment against an invoice; it gets a receipt number',
  group: paymentGroup,
  params: documentParams,
  body: recordPaymentInput,
  response: {
    status: 201,
    description: 'The receipt. The invoice is now partly paid or paid.',
    schema: receipt,
  },
});
export const getReceipt = defineEndpoint({
  operationId: 'getReceipt',
  method: 'get',
  path: '/payments/{id}',
  summary: 'Read a payment as its receipt',
  group: paymentGroup,
  params: paymentParams,
  response: { status: 200, description: 'The receipt.', schema: receipt },
});
export const reversePayment = defineEndpoint({
  operationId: 'reversePayment',
  method: 'post',
  path: '/payments/{id}/reverse',
  summary: 'Reverse a payment recorded by mistake; it is kept, with the reason',
  group: paymentGroup,
  params: paymentParams,
  body: reversePaymentInput,
  response: {
    status: 200,
    description: 'The reversed payment. The invoice owes that amount again.',
    schema: receipt,
  },
});

// Settings --------------------------------------------------------------------------------------

const numberPrefix = z
  .string()
  .max(12)
  .regex(/^[A-Za-z0-9/_-]*$/, {
    error: 'Use letters, digits, hyphens, underscores and slashes only.',
  })
  .meta({ examples: ['INV-'] });
const sequenceNumber = z.int().min(1).max(MAX_SEQUENCE_NUMBER);

const numbering = z.looseObject({
  prefix: z.string(),
  nextNumber: sequenceNumber.meta({ description: 'The number the next one issued gets.' }),
  lastNumber: z.int().min(0).meta({
    description: 'The highest number given out so far; 0 when none was.',
  }),
  example: z.string().meta({
    description: 'How the next number will be printed.',
    examples: ['INV-0001'],
  }),
});
const numberingInput = z.strictObject({
  prefix: numberPrefix,
  nextNumber: sequenceNumber.optional().meta({
    description:
      'Left out: unchanged. It can be moved forward, never to a number already given out.',
  }),
});

const settingsValues = {
  paymentTermsDays: z.int().min(0).max(365).meta({
    description: "Days from an invoice's issue date to its due date, when it names none.",
  }),
  quoteValidityDays: z.int().min(1).max(365).meta({
    description: "Days from a quote's issue date to its last day, when it names none.",
  }),
  defaultNotes: z.string().trim().max(5000),
  defaultTerms: z.string().trim().max(10000),
  paymentInstructions: z.string().trim().max(5000).meta({
    description: 'How to pay: bank or mobile money details, printed on every invoice.',
  }),
  taxNumber: z.string().trim().min(1).max(64).nullable(),
  defaultTaxRate: percentInput.nullable().meta({
    description: 'Percent, for a new line that names no rate of its own. Null: none.',
  }),
};

export const commerceSettings = z
  .looseObject({
    numbering: z.looseObject({ quote: numbering, invoice: numbering, receipt: numbering }),
    ...settingsValues,
    defaultTaxRate: z.string().nullable(),
    revision,
    canManage: z.boolean(),
  })
  .meta({
    id: 'CommerceSettings',
    description:
      "How the business numbers and words its quotes, invoices and receipts. Its name, address and logo are the business profile's.",
  });
export type CommerceSettings = z.output<typeof commerceSettings>;

export const updateCommerceSettingsInput = z
  .strictObject({
    numbering: z.strictObject({
      quote: numberingInput,
      invoice: numberingInput,
      receipt: numberingInput,
    }),
    ...settingsValues,
    revision,
  })
  .meta({ id: 'UpdateCommerceSettingsInput' });
export type UpdateCommerceSettingsInput = z.input<typeof updateCommerceSettingsInput>;

const settingsGroup = 'Payment settings';

export const getCommerceSettings = defineEndpoint({
  operationId: 'getCommerceSettings',
  method: 'get',
  path: '/commerce-settings',
  summary: 'Read the numbering, terms and tax settings of quotes, invoices and receipts',
  group: settingsGroup,
  response: { status: 200, description: 'The settings.', schema: commerceSettings },
});
export const updateCommerceSettings = defineEndpoint({
  operationId: 'updateCommerceSettings',
  method: 'put',
  path: '/commerce-settings',
  summary: 'Change the numbering, terms and tax settings',
  group: settingsGroup,
  body: updateCommerceSettingsInput,
  response: { status: 200, description: 'The settings.', schema: commerceSettings },
});

// Printing, sharing and sending -----------------------------------------------------

const PDF = { types: ['application/pdf'] } as const;

export const getSalesDocumentPdf = defineEndpoint({
  operationId: 'getSalesDocumentPdf',
  method: 'get',
  path: '/sales-documents/{id}/pdf',
  summary: 'Download a quote or an invoice as a PDF; a draft is marked DRAFT',
  group: documentGroup,
  params: documentParams,
  download: PDF,
  response: {
    status: 200,
    description:
      'The PDF, named after the number (INV-0007.pdf). A draft is a preview with the business as it is now.',
  },
});
export const getReceiptPdf = defineEndpoint({
  operationId: 'getReceiptPdf',
  method: 'get',
  path: '/payments/{id}/pdf',
  summary: "Download a payment's receipt as a PDF",
  group: paymentGroup,
  params: paymentParams,
  download: PDF,
  response: {
    status: 200,
    description: 'The PDF, named after the receipt number (RCT-0003.pdf).',
  },
});

export const salesDocumentLinkInput = z
  .strictObject({
    regenerate: z.boolean().default(false).meta({
      description:
        'true makes a new address and stops the old one, wherever it was sent. false, the default, answers with the address the document has, making one if it has none.',
    }),
  })
  .meta({ id: 'SalesDocumentLinkInput' });
export const createSalesDocumentLink = defineEndpoint({
  operationId: 'createSalesDocumentLink',
  method: 'post',
  path: '/sales-documents/{id}/link',
  summary: "Get an issued document's public address, or replace it with a new one",
  group: documentGroup,
  params: documentParams,
  body: salesDocumentLinkInput,
  response: { status: 200, description: 'The address.', schema: salesDocumentLink },
});

const emailAddress = z
  .string()
  .trim()
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+$/, { error: 'Enter an email address.' });
const sendValues = {
  to: emailAddress.optional().meta({
    description:
      "One of the contact's own email addresses. Left out: the customer's address on the document.",
    examples: ['maya@example.com'],
  }),
  mailboxId: publicId('mailbox').optional().meta({
    description:
      "The mailbox it is sent from. Left out: the business's first mailbox that sends conversations.",
  }),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]*$/, { error: 'Keep the subject on one line.' })
    .optional()
    .meta({ description: 'Left out: one naming the document and the business.' }),
  message: z.string().trim().min(1).max(5000).optional().meta({
    description:
      'Your own words for the customer, as plain text. The greeting, the link to the document and the business name are added around it. Left out: one line saying what is sent.',
  }),
  attachPdf: z.boolean().default(true).meta({
    description: 'Whether the PDF goes with the email as an attachment.',
  }),
};

export const sendSalesDocumentInput = z
  .strictObject({
    ...sendValues,
    issueIfDraft: z.boolean().default(false).meta({
      description:
        'true issues a draft first, in the same step, so it is sent with its number. false, the default, refuses a draft with 409.',
    }),
    revision,
  })
  .meta({ id: 'SendSalesDocumentInput' });
export type SendSalesDocumentInput = z.input<typeof sendSalesDocumentInput>;

export const sendReceiptInput = z
  .strictObject({
    ...sendValues,
    idempotencyKey: z.uuid().meta({
      description:
        'One for each press of Send: the same key sent again answers with the first send and sends nothing more.',
    }),
  })
  .meta({ id: 'SendReceiptInput' });
export type SendReceiptInput = z.input<typeof sendReceiptInput>;

const sentMessage = z
  .looseObject({
    id: publicId('message'),
    conversationId: publicId('conversation').meta({
      description: "The contact's conversation, where the email is shown like any other.",
    }),
    to: z.string(),
    status: z.enum(['queued', 'deferred']).meta({
      description:
        "queued: on its way. deferred: held by the contact's quiet hours or the mailbox's limits, and sent when they allow.",
    }),
    attachedPdf: z.boolean(),
  })
  .meta({ id: 'CommerceSentMessage' });

export const salesDocumentSend = z
  .looseObject({ document: salesDocument, message: sentMessage })
  .meta({ id: 'SalesDocumentSend' });
export type SalesDocumentSend = z.output<typeof salesDocumentSend>;
export const receiptSend = z
  .looseObject({ receipt, message: sentMessage })
  .meta({ id: 'ReceiptSend' });
export type ReceiptSend = z.output<typeof receiptSend>;

export const sendSalesDocument = defineEndpoint({
  operationId: 'sendSalesDocument',
  method: 'post',
  path: '/sales-documents/{id}/send',
  summary: 'Email a quote or an invoice to its contact, with its link and its PDF',
  group: documentGroup,
  params: documentParams,
  body: sendSalesDocumentInput,
  response: {
    status: 200,
    description:
      "The document, and the email as it was queued in the contact's conversation. It is a transactional message: it needs no marketing consent, and is refused for a suppressed address, do not contact or a withdrawn consent.",
    schema: salesDocumentSend,
  },
});
export const sendReceipt = defineEndpoint({
  operationId: 'sendReceipt',
  method: 'post',
  path: '/payments/{id}/send',
  summary: "Email a payment's receipt to the invoice's contact",
  group: paymentGroup,
  params: paymentParams,
  body: sendReceiptInput,
  response: {
    status: 200,
    description: "The receipt, and the email as it was queued in the contact's conversation.",
    schema: receiptSend,
  },
});

export const commerceEndpoints = [
  listProducts,
  createProduct,
  getProduct,
  updateProduct,
  archiveProduct,
  restoreProduct,
  deleteProduct,
  listSalesDocuments,
  createSalesDocument,
  getSalesDocument,
  updateSalesDocument,
  deleteSalesDocument,
  issueSalesDocument,
  reviseSalesDocument,
  acceptQuote,
  declineQuote,
  convertQuoteToInvoice,
  voidInvoice,
  duplicateSalesDocument,
  setSalesDocumentNote,
  listPayments,
  recordPayment,
  getReceipt,
  reversePayment,
  getCommerceSettings,
  updateCommerceSettings,
  getSalesDocumentPdf,
  getReceiptPdf,
  createSalesDocumentLink,
  sendSalesDocument,
  sendReceipt,
] as const;
