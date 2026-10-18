// What the two suites that try every endpoint need for commerce: a product, an invoice with
// a payment on it and their like, added directly so each test pays a few statements for
// them; an input for each operation that the business's own member could send and have
// accepted; and an example of every command for the permission matrix.
import { randomUUID } from 'node:crypto';

import { parsePublicId, toPublicId } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import type { LightMyRequestResponse } from 'fastify';

export interface CommerceRecords {
  readonly product: string;
  readonly sales_document: string;
  readonly payment: string;
}

/** Who a fixture document is from, as an issue would have written it down. */
const SELLER = JSON.stringify({
  name: 'Business B only',
  address: null,
  taxNumber: null,
  logoFileId: null,
  paymentInstructions: '',
});

// Far above any number a suite's own issues reach, so the two never meet.
let numbered = 500_000;

/** A product of the business, in use or archived, by its public id. */
export async function addProduct(
  database: TestDatabase,
  businessId: string,
  archived = false,
): Promise<string> {
  const row = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into commerce.products
         (business_id, kind, name, unit_price, currency, archived_at, created_by_kind)
       values ($1, 'service', 'Business B only ' || uuidv7()::text, 100, 'KES',
               case when $2 then now() end, 'system') returning id`,
      [businessId, archived],
    ),
  );
  return toPublicId('product', row.id);
}

export type DocumentState = 'draft' | 'sent' | 'partly_paid';

/**
 * A quote or an invoice of 100.00 for the contact, with one line, as far along as asked:
 * a draft, issued, or (an invoice) with a payment of 40.00 on it. Added as the module
 * would have left it, so its commands meet what they expect.
 */
export async function addDocument(
  database: TestDatabase,
  businessId: string,
  contactId: string,
  kind: 'quote' | 'invoice',
  state: DocumentState,
  productId?: string,
): Promise<{ readonly document: string; readonly payment: string | undefined }> {
  const sequence = ++numbered;
  return database.as('crm_owner', async (sql) => {
    const document = await sql.one<{ id: string }>(
      `insert into commerce.documents
         (business_id, kind, contact_id, currency, customer_name, subtotal, total, balance_due,
          created_by_kind)
       values ($1, $2, $3, 'KES', 'Business B only', 100, 100, 100, 'system') returning id`,
      [businessId, kind, parsePublicId('contact', contactId)],
    );
    await sql.query(
      `insert into commerce.document_lines
         (business_id, document_id, position, product_id, name, quantity, unit_price, amount,
          taxable_amount)
       values ($1, $2, 0, $3, 'Business B only', 1, 100, 100, 100)`,
      [
        businessId,
        document.id,
        productId === undefined ? null : parsePublicId('product', productId),
      ],
    );
    if (state === 'draft')
      return { document: toPublicId('sales_document', document.id), payment: undefined };
    await sql.query(
      `update commerce.documents
       set status = 'sent', number = 'FX-' || $2::bigint::text, sequence_number = $2::bigint,
           seller = $3::jsonb,
           issued_at = now(), issue_date = current_date, due_date = current_date + 14
       where id = $1`,
      [document.id, sequence, SELLER],
    );
    if (state === 'sent')
      return { document: toPublicId('sales_document', document.id), payment: undefined };
    const payment = await sql.one<{ id: string }>(
      `insert into commerce.payments
         (business_id, document_id, number, sequence_number, amount, currency, paid_on, method,
          balance_after, recorded_by_kind)
       values ($1, $2, 'FX-R-' || $3::bigint::text, $3::bigint, 40, 'KES', current_date, 'cash', 60,
               'system')
       returning id`,
      [businessId, document.id, sequence],
    );
    await sql.query(
      `update commerce.documents
       set status = 'partly_paid', amount_paid = 40, balance_due = 60 where id = $1`,
      [document.id],
    );
    return {
      document: toPublicId('sales_document', document.id),
      payment: toPublicId('payment', payment.id),
    };
  });
}

/**
 * A product of the business, an invoice for the contact that names it, and a payment on
 * that invoice: everything a commerce endpoint takes by id.
 */
export async function addCommerceRecords(
  database: TestDatabase,
  businessId: string,
  contactId: string,
): Promise<CommerceRecords> {
  const product = await addProduct(database, businessId);
  const { document, payment } = await addDocument(
    database,
    businessId,
    contactId,
    'invoice',
    'partly_paid',
    product,
  );
  return { product, sales_document: document, payment: payment ?? '' };
}

/**
 * What each commerce operation is sent besides its path: an input the business's own
 * member could send and have accepted, so another business's 404 is the tenant boundary.
 */
export function commerceInputs(
  records: Readonly<Record<string, string>>,
): Readonly<Record<string, { payload?: unknown; query?: string }>> {
  return {
    updateProduct: {
      payload: {
        kind: 'service',
        name: 'Reached from A',
        unitPrice: '1',
        currency: 'KES',
        revision: 1,
      },
    },
    archiveProduct: { payload: { revision: 1 } },
    restoreProduct: { payload: { revision: 1 } },
    // B's own contact, invoice and payment, named as B's member could name them: from A
    // they find nothing.
    listSalesDocuments: { query: `?contactId=${records['contact'] ?? ''}&kind=invoice` },
    listPayments: { query: `?invoiceId=${records['sales_document'] ?? ''}` },
    updateSalesDocument: {
      payload: { contactId: records['contact'], currency: 'KES', lines: [], revision: 1 },
    },
    issueSalesDocument: { payload: { revision: 1 } },
    voidInvoice: { payload: { reason: 'Reached from A' } },
    setSalesDocumentNote: { payload: { internalNote: 'Reached from A' } },
    recordPayment: { payload: { amount: '1', method: 'cash' } },
    reversePayment: { payload: { reason: 'Reached from A' } },
    // Sharing and sending: the address of B's invoice, and B's invoice and receipt emailed,
    // each as B's member could ask.
    createSalesDocumentLink: { payload: {} },
    sendSalesDocument: { payload: { revision: 1 } },
    sendReceipt: { payload: { idempotencyKey: randomUUID() } },
  };
}

type Call = (
  method: 'POST' | 'PUT' | 'PATCH' | 'GET' | 'DELETE',
  path: string,
  options: { payload: unknown; type?: string; inBusiness: boolean },
) => Promise<LightMyRequestResponse>;

interface Example {
  readonly run: (call: Call, run: number) => Promise<LightMyRequestResponse>;
}

/**
 * An example of every commerce command, each on records added directly for that try: a
 * role that may not write an invoice could not make the one its refusal is tried on.
 */
export function commerceExamples(
  database: () => TestDatabase,
  business: () => string,
  contact: () => string,
): Readonly<Record<string, Example>> {
  const here = (payload: unknown) => ({ inBusiness: true, payload });
  const document = async (kind: 'quote' | 'invoice', state: DocumentState) =>
    addDocument(database(), business(), contact(), kind, state);
  /** A command on a document as far along as it needs, under the document's own path. */
  const on =
    (
      method: 'POST' | 'PUT' | 'DELETE',
      kind: 'quote' | 'invoice',
      state: DocumentState,
      action: string,
      payload: () => unknown = () => undefined,
    ): Example['run'] =>
    async (call) => {
      const made = await document(kind, state);
      return call(method, `/sales-documents/${made.document}${action}`, here(payload()));
    };
  const values = () => ({ contactId: contact(), currency: 'KES', lines: [] });
  /**
   * What the outbound pipeline asks before it takes an email to the contact, put on record:
   * their consent to transactional email, and no quiet hours (the contact has no time zone).
   * Gives the contact's address, which a document added directly does not carry.
   */
  const emailable = async (): Promise<string> => {
    const contactId = parsePublicId('contact', contact());
    return database().as('crm_owner', async (sql) => {
      await sql.query(
        `insert into messaging.settings (business_id, quiet_hours_enabled) values ($1, false)
         on conflict (business_id) do update set quiet_hours_enabled = false`,
        [business()],
      );
      await sql.query(
        `insert into messaging.consents
           (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
         values ($1, $2, 'email', 'transactional', 'granted', 'user', 'system')`,
        [business(), contactId],
      );
      const address = await sql.one<{ value_normalized: string }>(
        `select value_normalized from crm.contact_identities
         where business_id = $1 and contact_id = $2 and kind = 'email' order by id limit 1`,
        [business(), contactId],
      );
      return address.value_normalized;
    });
  };
  const product = (run: number) => ({
    kind: 'service',
    name: `Matrix ${String(run)}`,
    unitPrice: '10',
    currency: 'KES',
  });
  return {
    'product.create': { run: (call, run) => call('POST', '/products', here(product(run))) },
    'product.update': {
      run: async (call, run) =>
        call(
          'PUT',
          `/products/${await addProduct(database(), business())}`,
          here({ ...product(run), revision: 1 }),
        ),
    },
    'product.archive': {
      run: async (call) =>
        call(
          'POST',
          `/products/${await addProduct(database(), business())}/archive`,
          here({ revision: 1 }),
        ),
    },
    'product.restore': {
      run: async (call) =>
        call(
          'POST',
          `/products/${await addProduct(database(), business(), true)}/restore`,
          here({ revision: 1 }),
        ),
    },
    'product.delete': {
      run: async (call) =>
        call('DELETE', `/products/${await addProduct(database(), business())}`, here(undefined)),
    },
    'sales_document.create': {
      run: (call) => call('POST', '/sales-documents', here({ kind: 'quote', ...values() })),
    },
    'sales_document.update': {
      run: on('PUT', 'invoice', 'draft', '', () => ({ ...values(), revision: 1 })),
    },
    'sales_document.delete': { run: on('DELETE', 'invoice', 'draft', '') },
    'sales_document.issue': {
      run: on('POST', 'invoice', 'draft', '/issue', () => ({ revision: 1 })),
    },
    'sales_document.revise': { run: on('POST', 'quote', 'sent', '/revise') },
    'sales_document.accept': { run: on('POST', 'quote', 'sent', '/accept') },
    'sales_document.decline': { run: on('POST', 'quote', 'sent', '/decline') },
    'sales_document.convert': { run: on('POST', 'quote', 'sent', '/convert') },
    'sales_document.void': {
      run: on('POST', 'invoice', 'sent', '/void', () => ({ reason: 'Tried in the matrix.' })),
    },
    'sales_document.duplicate': { run: on('POST', 'invoice', 'sent', '/duplicate') },
    'sales_document.set_note': {
      run: on('PUT', 'invoice', 'sent', '/internal-note', () => ({ internalNote: 'Matrix' })),
    },
    'payment.record': {
      run: on('POST', 'invoice', 'sent', '/payments', () => ({ amount: '10', method: 'cash' })),
    },
    'payment.reverse': {
      run: async (call) => {
        const made = await document('invoice', 'partly_paid');
        return call(
          'POST',
          `/payments/${made.payment ?? ''}/reverse`,
          here({ reason: 'Tried in the matrix.' }),
        );
      },
    },
    // Sharing and sending. The routes are composed with the files service and what public
    // addresses are made with, as a running install composes them.
    'sales_document.link': { run: on('POST', 'invoice', 'sent', '/link', () => ({})) },
    'sales_document.send': {
      run: async (call) => {
        const to = await emailable();
        const made = await document('invoice', 'sent');
        return call('POST', `/sales-documents/${made.document}/send`, here({ revision: 1, to }));
      },
    },
    'payment.send': {
      run: async (call) => {
        const to = await emailable();
        const made = await document('invoice', 'partly_paid');
        return call(
          'POST',
          `/payments/${made.payment ?? ''}/send`,
          here({ idempotencyKey: randomUUID(), to }),
        );
      },
    },
    'commerce_settings.update': {
      run: async (call, run) => {
        // The revision the settings are at, read directly: not every role may read them.
        const [saved] = await database().as('crm_owner', (sql) =>
          sql.query<{ revision: number }>(
            'select revision from commerce.settings where business_id = $1',
            [business()],
          ),
        );
        return call(
          'PUT',
          '/commerce-settings',
          here({
            numbering: {
              quote: { prefix: 'QUO-' },
              invoice: { prefix: 'INV-' },
              receipt: { prefix: 'RCT-' },
            },
            paymentTermsDays: (run % 30) + 1,
            quoteValidityDays: 30,
            defaultNotes: '',
            defaultTerms: '',
            paymentInstructions: '',
            taxNumber: null,
            defaultTaxRate: null,
            revision: saved?.revision ?? 1,
          }),
        );
      },
    },
  };
}

/** The names of the commerce commands, which owners and admins alone may run. */
export const COMMERCE_COMMANDS: readonly string[] = Object.keys(
  commerceExamples(
    () => {
      throw new Error('Names only.');
    },
    () => '',
    () => '',
  ),
);
