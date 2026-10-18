// A stand-in for the commerce API that keeps products, quotes, invoices, payments and the
// settings as the server does. Every request is parsed with the contract's own schema
// before it is answered, and every answer with the schema it is promised under, so a screen
// that sends or expects anything the contract does not have fails here. The arithmetic and
// the rules are the contract's own (computeDocumentTotals, allowedDocumentActions,
// invoiceStatusFor, documentSendRefusal), as on the server. It prints, shares and sends
// too: a PDF under the server's name for it, a public address, and an email that is refused
// as messaging refuses one.
import type { Page, Route } from '@playwright/test';
import {
  addDays,
  allowedDocumentActions,
  commerceSettings as settingsSchema,
  computeDocumentTotals,
  createProductInput,
  createSalesDocumentInput,
  documentSendRefusal,
  formatDocumentNumber,
  fromUnits,
  invoiceStatusFor,
  isExpired,
  isOverdue,
  listProductsQuery,
  listSalesDocumentsQuery,
  paymentList,
  printedFileName,
  product as productSchema,
  productList,
  productRevisionInput,
  receipt as receiptSchema,
  receiptSend,
  recordPaymentInput,
  reversePaymentInput,
  salesDocument as documentSchema,
  salesDocumentLink,
  salesDocumentLinkInput,
  salesDocumentList,
  salesDocumentNoteInput,
  salesDocumentRevisionInput,
  salesDocumentSend,
  sendReceiptInput,
  sendSalesDocumentInput,
  toUnits,
  updateCommerceSettingsInput,
  updateProductInput,
  updateSalesDocumentInput,
  voidInvoiceInput,
  type BusinessProfile,
  type CommerceSettings,
  type Payment,
  type Product,
  type SalesDocument,
  type SalesDocumentKind,
} from '@repo/contracts';
import type * as z from 'zod';
import { harbor } from './session';
import { idOf } from './sites-fixtures';

const at = '2026-10-12T09:00:00.000Z';
/** The day it is in the stand-in. */
export const today = '2026-10-12';

export const amina = {
  id: 'con_01h455vb4pex5vsknk084sn02q',
  name: 'Amina Otieno',
  email: 'amina@example.com',
  /** Her other address: a document can be sent to either. */
  otherEmail: 'accounts@otieno.example',
};

/** The one mailbox of the business that sends conversations. */
export const frontDesk = {
  id: 'mbx_01h455vb4pex5vsknk084sn02q',
  name: 'Front desk',
  email: 'hello@harborlights.test',
};

/** Why messaging refuses the next email, as the server's 422 names it. */
export interface MailRefusal {
  readonly path: '/to' | '/mailboxId';
  readonly code: string;
  readonly message: string;
}

export const harborProfile: BusinessProfile = {
  id: harbor.id,
  name: harbor.name,
  timezone: 'Africa/Nairobi',
  locale: 'en',
  currency: 'KES',
  address: {
    line1: '12 Harbour Road',
    line2: '',
    city: 'Mombasa',
    region: '',
    postalCode: '80100',
    country: 'KE',
  },
  logoFileId: null,
  canManage: true,
};

export function productOf(name: string, unitPrice: string, more: Partial<Product> = {}): Product {
  return {
    id: idOf('prod'),
    kind: 'service',
    name,
    description: '',
    sku: null,
    unit: 'hour',
    unitPrice,
    currency: 'KES',
    taxRate: null,
    archived: false,
    archivedAt: null,
    used: false,
    revision: 1,
    canManage: true,
    createdAt: at,
    updatedAt: at,
    ...more,
  };
}

type DocumentValues = Omit<z.output<typeof updateSalesDocumentInput>, 'revision'>;

interface Refusal {
  readonly status: number;
  readonly detail?: string;
  readonly errors?: readonly { path: string; code: string; message: string }[];
}

const problem = (route: Route, refusal: Refusal): Promise<void> =>
  route.fulfill({
    status: refusal.status,
    contentType: 'application/problem+json',
    body: JSON.stringify({
      type: 'about:blank',
      title: 'Refused',
      status: refusal.status,
      ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
      ...(refusal.errors === undefined ? {} : { errors: refusal.errors }),
    }),
  });

export interface PaymentsApi {
  products: Product[];
  documents: SalesDocument[];
  payments: Payment[];
  settings: CommerceSettings;
  /** Set to have the next emails refused, as for a contact with no consent recorded. */
  mailRefusal: MailRefusal | undefined;
  /** True holds the next emails for quiet hours: they are answered as deferred. */
  quietHours: boolean;
  /** Every email taken, in order. */
  readonly emails: {
    readonly of: string;
    readonly to: string;
    readonly mailboxId: string | undefined;
    readonly subject: string | undefined;
    readonly message: string | undefined;
    readonly attachedPdf: boolean;
  }[];
  /** Every PDF handed out, by the name it was given. */
  readonly downloads: string[];
  /** Every body sent, by method and path, in order. */
  readonly sent: { readonly call: string; readonly body: unknown }[];
}

/**
 * Answers the Payments pages as the server does. `canManage: false` is someone who may only
 * look; `forbidden` someone the documents, payments and settings are refused to.
 */
export async function fakePaymentsApi(
  page: Page,
  {
    products = [],
    canManage = true,
    forbidden = false,
    profile = harborProfile,
    publicPages = true,
  }: {
    readonly products?: readonly Product[];
    readonly canManage?: boolean;
    readonly forbidden?: boolean;
    readonly profile?: BusinessProfile;
    /** False is an install that serves no public pages: no document gets a link. */
    readonly publicPages?: boolean;
  } = {},
): Promise<PaymentsApi> {
  const numbering = (prefix: string) => ({
    prefix,
    nextNumber: 1,
    lastNumber: 0,
    example: formatDocumentNumber(prefix, 1),
  });
  const api: PaymentsApi = {
    products: products.map((each) => ({ ...each, canManage })),
    documents: [],
    payments: [],
    settings: {
      numbering: {
        quote: numbering('QUO-'),
        invoice: numbering('INV-'),
        receipt: numbering('RCT-'),
      },
      paymentTermsDays: 14,
      quoteValidityDays: 30,
      defaultNotes: 'Thank you for your business.',
      defaultTerms: '',
      paymentInstructions: 'Paybill 123456, account: your invoice number.',
      taxNumber: 'P051234567X',
      defaultTaxRate: '16.0000',
      revision: 1,
      canManage,
    },
    mailRefusal: undefined,
    quietHours: false,
    emails: [],
    downloads: [],
    sent: [],
  };
  /** Each document's public address, kept through a revision as the server keeps it. */
  const links = new Map<string, { url: string; createdAt: string }>();
  let tokens = 0;
  const newLink = (id: string): { url: string; createdAt: string } => {
    tokens += 1;
    const link = {
      url: `https://crm.harborlights.test/d/${String(tokens).padStart(43, 'A')}`,
      createdAt: at,
    };
    links.set(id, link);
    return link;
  };
  /** The receipts already sent, by the key of the press that sent them. */
  const receiptSends = new Map<string, { to: string; attachedPdf: boolean }>();
  const pdf = (route: Route, name: string): Promise<void> => {
    api.downloads.push(name);
    return route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      headers: { 'content-disposition': `attachment; filename="${name}"` },
      body: Buffer.from('%PDF-1.7\n% a stand-in for the PDF the server draws\n'),
    });
  };
  /** The email as messaging would answer it: refused, or queued in the conversation. */
  const mailed = (
    of: string,
    values: {
      readonly to?: string | undefined;
      readonly mailboxId?: string | undefined;
      readonly subject?: string | undefined;
      readonly message?: string | undefined;
      readonly attachPdf: boolean;
    },
    customerEmail: string | null,
  ): { readonly refusal: Refusal } | { readonly message: Record<string, unknown> } => {
    const issue = (path: string, code: string, message: string) => ({
      refusal: { status: 422, errors: [{ path, code, message }] },
    });
    const to = values.to ?? customerEmail;
    if (to === null)
      return issue(
        '/to',
        'no_address',
        'This contact has no email address. Add one to the contact first.',
      );
    if (to !== amina.email && to !== amina.otherEmail)
      return issue(
        '/to',
        'not_contacts_address',
        "This is not one of the contact's email addresses. Add it to the contact first.",
      );
    if (values.mailboxId !== undefined && values.mailboxId !== frontDesk.id)
      return issue(
        '/mailboxId',
        'no_mailbox',
        'There is no mailbox to send from. Connect one that sends conversations in Settings, or choose another.',
      );
    if (api.mailRefusal !== undefined)
      return issue(api.mailRefusal.path, api.mailRefusal.code, api.mailRefusal.message);
    api.emails.push({
      of,
      to,
      mailboxId: values.mailboxId,
      subject: values.subject,
      message: values.message,
      attachedPdf: values.attachPdf,
    });
    return {
      message: {
        id: idOf('msg'),
        conversationId: idOf('cvn'),
        to,
        status: api.quietHours ? 'deferred' : 'queued',
        attachedPdf: values.attachPdf,
      },
    };
  };

  const take = (kind: 'quote' | 'invoice' | 'receipt'): string => {
    const counter = api.settings.numbering[kind];
    const number = formatDocumentNumber(counter.prefix, counter.nextNumber);
    api.settings = {
      ...api.settings,
      numbering: {
        ...api.settings.numbering,
        [kind]: {
          ...counter,
          lastNumber: counter.nextNumber,
          nextNumber: counter.nextNumber + 1,
          example: formatDocumentNumber(counter.prefix, counter.nextNumber + 1),
        },
      },
    };
    return number;
  };

  /** A document with everything the server works out: its amounts, flags and actions. */
  const worked = (document: SalesDocument): SalesDocument => {
    const paid = api.payments
      .filter((each) => each.invoiceId === document.id && each.status === 'recorded')
      .reduce((sum, each) => sum + toUnits(each.amount), 0n);
    const amountPaid = fromUnits(paid);
    const balanceDue = fromUnits(toUnits(document.totals.total) - paid);
    const status =
      document.kind === 'invoice' && document.status !== 'draft' && document.status !== 'void'
        ? invoiceStatusFor(document.totals.total, amountPaid)
        : document.status;
    const state = { kind: document.kind, status, dueDate: document.dueDate, balanceDue };
    return documentSchema.parse({
      ...document,
      status,
      totals: { ...document.totals, amountPaid, balanceDue },
      overdue: isOverdue(state, today),
      expired: isExpired(state, today),
      payments: api.payments.filter((each) => each.invoiceId === document.id),
      sentAt: document.sentAt ?? null,
      lastSentAt: document.lastSentAt ?? null,
      sendCount: document.sendCount ?? 0,
      // Only a document in force has a public address.
      publicLink: status === 'draft' || status === 'void' ? null : (links.get(document.id) ?? null),
      actions: allowedDocumentActions({
        kind: document.kind,
        status,
        number: document.number,
        amountPaid,
        converted: document.invoiceId !== null,
      }),
      canManage,
    });
  };
  const found = (id: string | undefined): SalesDocument => {
    const document = api.documents.find((each) => each.id === id);
    if (document === undefined) throw new Error(`No document ${String(id)} in the stand-in.`);
    return worked(document);
  };
  const put = (next: SalesDocument): SalesDocument => {
    const saved = worked({ ...next, revision: next.revision + 1, updatedAt: at });
    api.documents = api.documents.some((each) => each.id === saved.id)
      ? api.documents.map((each) => (each.id === saved.id ? saved : each))
      : [saved, ...api.documents];
    return saved;
  };
  /** The parts of a document that its lines, discount and contact decide. */
  const written = (values: DocumentValues): Partial<SalesDocument> => {
    const result = computeDocumentTotals(values);
    if (!result.ok) throw new Error('The stand-in was sent numbers the contract refuses.');
    const { totals } = result;
    return {
      contactId: values.contactId,
      dealId: values.dealId,
      currency: values.currency,
      issueDate: values.issueDate,
      dueDate: values.dueDate,
      customer: {
        name: values.contactId === amina.id ? amina.name : '',
        email: values.contactId === amina.id ? amina.email : null,
        phone: null,
        billTo: values.billTo,
        taxNumber: values.customerTaxNumber,
      },
      lines: values.lines.map((line, position) => {
        const amounts = totals.lines[position];
        if (amounts === undefined) throw new Error('A line has no amounts.');
        return {
          id: idOf('sdl'),
          position,
          productId: line.productId,
          name: line.name,
          description: line.description,
          quantity: fromUnits(toUnits(line.quantity)),
          unit: line.unit,
          unitPrice: fromUnits(toUnits(line.unitPrice)),
          discount: line.discount,
          taxRate: fromUnits(toUnits(line.taxRate ?? '0')),
          amount: amounts.amount,
          discountAmount: amounts.discount,
          taxableAmount: amounts.taxable,
          taxAmount: amounts.tax,
          total: amounts.total,
        };
      }),
      discount: values.discount,
      totals: {
        subtotal: totals.subtotal,
        lineDiscountTotal: totals.lineDiscountTotal,
        documentDiscount: totals.documentDiscount,
        discountTotal: totals.discountTotal,
        taxes: totals.taxes.map((each) => ({ ...each })),
        taxTotal: totals.taxTotal,
        total: totals.total,
        amountPaid: '0.0000',
        balanceDue: totals.total,
      },
    };
  };
  const fresh = (kind: SalesDocumentKind, parts: Partial<SalesDocument>): SalesDocument =>
    ({
      id: idOf('sdoc'),
      kind,
      status: 'draft',
      number: null,
      quoteId: null,
      invoiceId: null,
      seller: null,
      notes: '',
      terms: '',
      internalNote: '',
      overdue: false,
      expired: false,
      issuedAt: null,
      acceptedAt: null,
      declinedAt: null,
      voidedAt: null,
      voidReason: null,
      payments: [],
      actions: [],
      revision: 0,
      canManage,
      createdAt: at,
      updatedAt: at,
      ...parts,
    }) as SalesDocument;
  const seller = (): SalesDocument['seller'] => ({
    name: profile.name,
    address: profile.address,
    taxNumber: api.settings.taxNumber,
    logoFileId: profile.logoFileId,
    paymentInstructions: api.settings.paymentInstructions,
  });
  const receiptOf = (payment: Payment): unknown => {
    const invoice = found(payment.invoiceId);
    return receiptSchema.parse({
      ...payment,
      seller: invoice.seller ?? seller(),
      customer: invoice.customer,
      invoice: {
        id: invoice.id,
        number: invoice.number ?? '',
        status: invoice.status,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        total: invoice.totals.total,
        amountPaid: invoice.totals.amountPaid,
        balanceDue: invoice.totals.balanceDue,
      },
      canManage,
    });
  };
  const stale = (route: Route): Promise<void> =>
    problem(route, { status: 409, detail: 'Someone else changed it first. Reload and try again.' });
  /** A draft as it is once issued: numbered, dated and from the business as it is now. */
  const issued = (current: SalesDocument): SalesDocument => {
    const issueDate = current.issueDate ?? today;
    return {
      ...current,
      status: 'sent',
      number: current.number ?? take(current.kind),
      issueDate,
      dueDate:
        current.dueDate ??
        addDays(
          issueDate,
          current.kind === 'invoice'
            ? api.settings.paymentTermsDays
            : api.settings.quoteValidityDays,
        ),
      seller: seller(),
      issuedAt: at,
    };
  };
  const refused = (route: Route): Promise<void> =>
    problem(route, { status: 403, detail: 'You need the payments.read permission.' });

  await page.route('**/api/v1/business-profile', (route) => route.fulfill({ json: profile }));
  await page.route(/\/api\/v1\/contacts\?/, (route) =>
    route.fulfill({
      json: {
        items: [{ id: amina.id, name: amina.name, email: amina.email, phone: null, createdAt: at }],
        next: null,
        canManage: true,
      },
    }),
  );

  // Who a document started from a contact's page is for.
  await page.route(`**/api/v1/contacts/${amina.id}`, (route) =>
    route.fulfill({
      json: {
        id: amina.id,
        firstName: 'Amina',
        lastName: 'Otieno',
        name: amina.name,
        emails: [amina.email, amina.otherEmail],
        phones: [],
        timeZone: null,
        doNotContact: false,
        preferencesRevision: 'a'.repeat(64),
        createdAt: at,
        updatedAt: at,
        trashedAt: null,
        canManage: true,
      },
    }),
  );

  // The mailboxes the Send dialog offers: the one that sends conversations (session.ts
  // answers each mailbox's sending settings).
  await page.route('**/api/v1/mailboxes', (route) => {
    const server = { host: 'mail.harborlights.test', security: 'tls', username: frontDesk.email };
    return route.fulfill({
      json: {
        data: [
          {
            ...frontDesk,
            displayName: 'Harbor Lights Events',
            smtp: { ...server, port: 465 },
            imap: { ...server, port: 993 },
            status: 'active',
            createdAt: at,
          },
        ],
      },
    });
  });

  await page.route(/\/api\/v1\/products(?:[/?]|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const [, , , , id, action] = url.pathname.split('/');
    const body: unknown =
      method === 'GET' || method === 'DELETE' ? undefined : request.postDataJSON();
    if (method !== 'GET') api.sent.push({ call: `${method} ${url.pathname}`, body });
    const shown = (product: Product): unknown => productSchema.parse({ ...product, canManage });
    if (id === undefined) {
      if (method === 'POST') {
        const checked = createProductInput.safeParse(body);
        // The one refusal the pages are shown as the server words it: a number that is not one.
        if (!checked.success)
          return problem(route, {
            status: 422,
            errors: checked.error.issues.map((issue) => ({
              path: `/${issue.path.map(String).join('/')}`,
              code: 'invalid',
              message: issue.message,
            })),
          });
        const input = checked.data;
        if (
          input.sku !== null &&
          api.products.some((each) => each.sku?.toLowerCase() === input.sku?.toLowerCase())
        )
          return problem(route, {
            status: 422,
            errors: [
              { path: '/sku', code: 'taken', message: 'Another product already has this code.' },
            ],
          });
        const made = productOf(input.name, fromUnits(toUnits(input.unitPrice)), {
          ...input,
          unitPrice: fromUnits(toUnits(input.unitPrice)),
          taxRate: input.taxRate === null ? null : fromUnits(toUnits(input.taxRate)),
        });
        api.products = [...api.products, made];
        return route.fulfill({ status: 201, json: shown(made) });
      }
      const query = listProductsQuery.parse(Object.fromEntries(url.searchParams));
      const q = query.q?.toLowerCase() ?? '';
      const items = api.products
        .filter((each) => each.archived === (query.archived === 'true'))
        .filter((each) => query.kind === undefined || each.kind === query.kind)
        .filter((each) => `${each.name} ${each.sku ?? ''}`.toLowerCase().includes(q))
        .toSorted((one, other) => one.name.localeCompare(other.name));
      return route.fulfill({
        json: productList.parse({ items: items.map(shown), nextCursor: null, canManage }),
      });
    }
    const current = api.products.find((each) => each.id === id);
    if (current === undefined) return problem(route, { status: 404 });
    if (method === 'GET') return route.fulfill({ json: shown(current) });
    if (method === 'DELETE') {
      api.products = api.products.filter((each) => each.id !== id);
      return route.fulfill({ status: 204 });
    }
    const save = (next: Product): Promise<void> => {
      const saved = { ...next, revision: next.revision + 1 };
      api.products = api.products.map((each) => (each.id === id ? saved : each));
      return route.fulfill({ json: shown(saved) });
    };
    if (action === 'archive' || action === 'restore') {
      if (productRevisionInput.parse(body).revision !== current.revision) return stale(route);
      return save({
        ...current,
        archived: action === 'archive',
        archivedAt: action === 'archive' ? at : null,
      });
    }
    const { revision, ...input } = updateProductInput.parse(body);
    if (revision !== current.revision) return stale(route);
    return save({
      ...current,
      ...input,
      unitPrice: fromUnits(toUnits(input.unitPrice)),
      taxRate: input.taxRate === null ? null : fromUnits(toUnits(input.taxRate)),
    });
  });

  await page.route('**/api/v1/commerce-settings', async (route) => {
    if (forbidden) return refused(route);
    const request = route.request();
    if (request.method() === 'PUT') {
      const body: unknown = request.postDataJSON();
      api.sent.push({ call: 'PUT /api/v1/commerce-settings', body });
      const {
        revision,
        numbering: sentNumbering,
        ...values
      } = updateCommerceSettingsInput.parse(body);
      if (revision !== api.settings.revision) return stale(route);
      const counter = (kind: 'quote' | 'invoice' | 'receipt') => {
        const before = api.settings.numbering[kind];
        const nextNumber = sentNumbering[kind].nextNumber ?? before.nextNumber;
        return {
          ...before,
          prefix: sentNumbering[kind].prefix,
          nextNumber,
          example: formatDocumentNumber(sentNumbering[kind].prefix, nextNumber),
        };
      };
      for (const kind of ['quote', 'invoice', 'receipt'] as const)
        if (counter(kind).nextNumber <= api.settings.numbering[kind].lastNumber)
          return problem(route, {
            status: 422,
            errors: [
              {
                path: `/numbering/${kind}/nextNumber`,
                code: 'invalid',
                message: 'That number was already given out. Choose a later one.',
              },
            ],
          });
      api.settings = {
        ...api.settings,
        ...values,
        numbering: {
          quote: counter('quote'),
          invoice: counter('invoice'),
          receipt: counter('receipt'),
        },
        revision: revision + 1,
      };
    }
    return route.fulfill({ json: settingsSchema.parse({ ...api.settings, canManage }) });
  });

  await page.route(/\/api\/v1\/sales-documents(?:[/?]|$)/, async (route) => {
    if (forbidden) return refused(route);
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const [, , , , id, action] = url.pathname.split('/');
    const posted = request.postData();
    const body: unknown = posted === null || posted === '' ? undefined : request.postDataJSON();
    if (method !== 'GET') api.sent.push({ call: `${method} ${url.pathname}`, body });
    if (id === undefined) {
      if (method === 'POST') {
        const { kind, ...values } = createSalesDocumentInput.parse(body);
        const made = put(
          fresh(kind, {
            ...written(values),
            notes: values.notes ?? api.settings.defaultNotes,
            terms: values.terms ?? api.settings.defaultTerms,
          }),
        );
        return route.fulfill({ status: 201, json: made });
      }
      const query = listSalesDocumentsQuery.parse(Object.fromEntries(url.searchParams));
      const q = query.q?.toLowerCase() ?? '';
      const items = api.documents
        .map(worked)
        .filter((each) => query.kind === undefined || each.kind === query.kind)
        .filter((each) => query.contactId === undefined || each.contactId === query.contactId)
        .filter((each) => query.dealId === undefined || each.dealId === query.dealId)
        .filter((each) =>
          query.status === 'all'
            ? true
            : query.status === 'overdue'
              ? each.overdue
              : query.status === 'expired'
                ? each.expired
                : each.status === query.status,
        )
        .filter((each) => `${each.number ?? ''} ${each.customer.name}`.toLowerCase().includes(q))
        .map((each) => ({
          id: each.id,
          kind: each.kind,
          status: each.status,
          number: each.number,
          contactId: each.contactId,
          customerName: each.customer.name,
          dealId: each.dealId,
          currency: each.currency,
          issueDate: each.issueDate,
          dueDate: each.dueDate,
          total: each.totals.total,
          amountPaid: each.totals.amountPaid,
          balanceDue: each.totals.balanceDue,
          overdue: each.overdue,
          expired: each.expired,
          createdAt: each.createdAt,
          updatedAt: each.updatedAt,
        }));
      return route.fulfill({
        json: salesDocumentList.parse({ items, nextCursor: null, canManage }),
      });
    }
    if (!api.documents.some((each) => each.id === id)) return problem(route, { status: 404 });
    const current = found(id);
    if (method === 'GET' && action === 'pdf')
      return pdf(route, printedFileName(current.number, `${current.kind}-draft`));
    if (method === 'GET') return route.fulfill({ json: current });
    if (method === 'DELETE') {
      api.documents = api.documents.filter((each) => each.id !== id);
      return route.fulfill({ status: 204 });
    }
    if (method === 'PUT' && action === undefined) {
      const { revision, ...values } = updateSalesDocumentInput.parse(body);
      if (revision !== current.revision) return stale(route);
      return route.fulfill({
        json: put({
          ...current,
          ...written(values),
          notes: values.notes ?? current.notes,
          terms: values.terms ?? current.terms,
        }),
      });
    }
    switch (action) {
      case 'issue': {
        if (salesDocumentRevisionInput.parse(body).revision !== current.revision)
          return stale(route);
        if (current.lines.length === 0)
          return problem(route, { status: 422, detail: 'Add at least one line before issuing.' });
        return route.fulfill({ json: put(issued(current)) });
      }
      case 'internal-note': {
        const { internalNote } = salesDocumentNoteInput.parse(body);
        return route.fulfill({ json: put({ ...current, internalNote }) });
      }
      case 'link': {
        const { regenerate } = salesDocumentLinkInput.parse(body);
        if (!publicPages)
          return problem(route, {
            status: 409,
            detail:
              'This install gives documents no public address: it needs PUBLIC_INTAKE_SECRET and a PUBLIC_URL.',
          });
        if (current.status === 'draft' || current.status === 'void')
          return problem(route, { status: 409, detail: 'It has no public address as it stands.' });
        const link = regenerate
          ? newLink(current.id)
          : (links.get(current.id) ?? newLink(current.id));
        // The document is read with its address from now on.
        api.documents = api.documents.map((each) => (each.id === current.id ? worked(each) : each));
        return route.fulfill({ json: salesDocumentLink.parse(link) });
      }
      case 'send': {
        const values = sendSalesDocumentInput.parse(body);
        if (values.revision !== current.revision) return stale(route);
        const refusal = documentSendRefusal(current, values.issueIfDraft);
        if (refusal !== undefined) return problem(route, { status: 409, detail: refusal });
        // An email that is refused issues nothing: the whole step is undone on the server.
        const mail = mailed(current.id, values, current.customer.email);
        if ('refusal' in mail) return problem(route, mail.refusal);
        if (publicPages && !links.has(current.id)) newLink(current.id);
        const saved = put({
          ...(current.status === 'draft' ? issued(current) : current),
          sentAt: current.sentAt ?? at,
          lastSentAt: at,
          sendCount: (current.sendCount ?? 0) + 1,
        });
        return route.fulfill({
          json: salesDocumentSend.parse({ document: saved, message: mail.message }),
        });
      }
      case 'revise':
        return route.fulfill({ json: put({ ...current, status: 'draft' }) });
      case 'accept':
        return route.fulfill({ json: put({ ...current, status: 'accepted', acceptedAt: at }) });
      case 'decline':
        return route.fulfill({ json: put({ ...current, status: 'declined', declinedAt: at }) });
      case 'void': {
        const { reason } = voidInvoiceInput.parse(body);
        return route.fulfill({
          json: put({ ...current, status: 'void', voidedAt: at, voidReason: reason }),
        });
      }
      case 'convert':
      case 'duplicate': {
        const converting = action === 'convert';
        const copy = put(
          fresh(converting ? 'invoice' : current.kind, {
            contactId: current.contactId,
            dealId: current.dealId,
            currency: current.currency,
            issueDate: null,
            dueDate: null,
            customer: current.customer,
            lines: current.lines.map((line) => ({ ...line, id: idOf('sdl') })),
            discount: current.discount,
            totals: current.totals,
            notes: current.notes,
            terms: current.terms,
            quoteId: converting ? current.id : null,
          }),
        );
        if (converting) put({ ...current, invoiceId: copy.id });
        return route.fulfill({ status: 201, json: copy });
      }
      case 'payments': {
        const input = recordPaymentInput.parse(body);
        if (toUnits(input.amount) > toUnits(current.totals.balanceDue))
          return problem(route, {
            status: 422,
            errors: [
              {
                path: '/amount',
                code: 'overpayment',
                message: 'This is more than is still owed on the invoice.',
              },
            ],
          });
        const payment: Payment = {
          id: idOf('pay'),
          number: take('receipt'),
          invoiceId: current.id,
          invoiceNumber: current.number ?? '',
          contactId: current.contactId,
          customerName: current.customer.name,
          amount: fromUnits(toUnits(input.amount)),
          currency: current.currency,
          paidOn: input.paidOn ?? today,
          method: input.method,
          reference: input.reference,
          note: input.note,
          balanceAfter: fromUnits(toUnits(current.totals.balanceDue) - toUnits(input.amount)),
          status: 'recorded',
          reversedAt: null,
          reversalReason: null,
          createdAt: at,
        };
        api.payments = [...api.payments, payment];
        put(current);
        return route.fulfill({ status: 201, json: receiptOf(payment) });
      }
      case undefined:
      default:
        return problem(route, { status: 404 });
    }
  });

  await page.route(/\/api\/v1\/payments(?:[/?]|$)/, async (route) => {
    if (forbidden) return refused(route);
    const request = route.request();
    const url = new URL(request.url());
    const [, , , , id, action] = url.pathname.split('/');
    if (id === undefined) {
      const status = url.searchParams.get('status') ?? 'all';
      const items = api.payments
        .filter((each) => status === 'all' || each.status === status)
        .toReversed();
      return route.fulfill({ json: paymentList.parse({ items, nextCursor: null, canManage }) });
    }
    const payment = api.payments.find((each) => each.id === id);
    if (payment === undefined) return problem(route, { status: 404 });
    if (action === 'pdf') return pdf(route, printedFileName(payment.number, 'receipt'));
    if (action === 'send') {
      const body: unknown = request.postDataJSON();
      api.sent.push({ call: `POST ${url.pathname}`, body });
      const { idempotencyKey, ...values } = sendReceiptInput.parse(body);
      // The same press of Send, sent again: the first one's email, and nothing more.
      const earlier = receiptSends.get(idempotencyKey);
      if (earlier !== undefined)
        return route.fulfill({
          json: receiptSend.parse({
            receipt: receiptOf(payment),
            message: {
              id: idOf('msg'),
              conversationId: idOf('cvn'),
              to: earlier.to,
              status: 'queued',
              attachedPdf: earlier.attachedPdf,
            },
          }),
        });
      if (payment.status === 'reversed')
        return problem(route, {
          status: 409,
          detail: 'This payment was reversed, so its receipt is not sent.',
        });
      const mail = mailed(payment.id, values, found(payment.invoiceId).customer.email);
      if ('refusal' in mail) return problem(route, mail.refusal);
      const sent: Payment = {
        ...payment,
        lastSentAt: at,
        sendCount: (payment.sendCount ?? 0) + 1,
      };
      api.payments = api.payments.map((each) => (each.id === id ? sent : each));
      receiptSends.set(idempotencyKey, {
        to: String(mail.message['to']),
        attachedPdf: values.attachPdf,
      });
      return route.fulfill({
        json: receiptSend.parse({ receipt: receiptOf(sent), message: mail.message }),
      });
    }
    if (action === 'reverse') {
      const body: unknown = request.postDataJSON();
      api.sent.push({ call: `POST ${url.pathname}`, body });
      const { reason } = reversePaymentInput.parse(body);
      const reversed: Payment = {
        ...payment,
        status: 'reversed',
        reversedAt: at,
        reversalReason: reason,
      };
      api.payments = api.payments.map((each) => (each.id === id ? reversed : each));
      put(found(payment.invoiceId));
      return route.fulfill({ json: receiptOf(reversed) });
    }
    return route.fulfill({ json: receiptOf(payment) });
  });

  return api;
}
