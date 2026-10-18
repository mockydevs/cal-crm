// The catalogue of products and services, and the commerce settings, against Postgres,
// through the module's own routes.
import {
  commerceSettings,
  product as productContract,
  productList,
  salesDocument,
  type CommerceSettings,
  type Product,
} from '@repo/contracts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';

import { commerceSuite, refusalOf, type CommerceFixture } from '../test/commerce-fixtures.js';

// On the real clock, as the server runs the routes: nothing here depends on the day.
const suite = commerceSuite('real');
const { fixture, api } = suite;
let database: TestDatabase;
beforeAll(() => {
  database = suite.database;
});

const service = { kind: 'service', name: 'Event planning', unitPrice: '1500.50', currency: 'KES' };
const add = async (f: CommerceFixture, change: Record<string, unknown> = {}): Promise<Product> =>
  productContract.parse(await api(f, 'createProduct', { body: { ...service, ...change } }));
const list = async (f: CommerceFixture, query: Record<string, unknown> = {}) =>
  productList.parse(await api(f, 'listProducts', { query }));
const values = (current: Product, change: Record<string, unknown> = {}) => ({
  kind: current.kind,
  name: current.name,
  description: current.description,
  sku: current.sku,
  unit: current.unit,
  unitPrice: current.unitPrice,
  currency: current.currency,
  taxRate: current.taxRate,
  revision: current.revision,
  ...change,
});
const events = (f: CommerceFixture, like: string) =>
  database.withTenant(f.business.context, (sql) =>
    sql.query<{ type: string; subject_kind: string; actor_kind: string }>(
      'select type, subject_kind, actor_kind from events.events where type like $1 order by recorded_at, id',
      [like],
    ),
  );

it('adds a product or a service with its rate, to four places, and says who may keep it', async () => {
  const f = await fixture();
  const made = await add(f, {
    name: '  Event planning ',
    description: 'Per hour of planning.',
    sku: 'PLAN-01',
    unit: 'hour',
    taxRate: '16',
  });
  expect(made).toMatchObject({
    kind: 'service',
    name: 'Event planning',
    description: 'Per hour of planning.',
    sku: 'PLAN-01',
    unit: 'hour',
    unitPrice: '1500.5000',
    currency: 'KES',
    taxRate: '16.0000',
    archived: false,
    archivedAt: null,
    used: false,
    revision: 1,
    canManage: true,
  });
  expect(made.id).toMatch(/^prod_/);
  // Anyone in the business reads the catalogue, and is told the keeping is not theirs.
  const read = productContract.parse(
    await api(f, 'getProduct', { params: { id: made.id } }, f.withPermissions()),
  );
  expect(read).toMatchObject({ id: made.id, canManage: false });
  expect(await events(f, 'product.%')).toEqual([
    { type: 'product.created', subject_kind: 'product', actor_kind: 'user' },
  ]);
});

it('keeps one product a code, whatever its capitals, and lets many have none', async () => {
  const f = await fixture();
  await add(f, { sku: 'PLAN-01' });
  const refused = await refusalOf(
    () => add(f, { name: 'Other', sku: ' plan-01 ' }),
    ValidationError,
  );
  expect(refused.issues).toEqual([
    { path: '/sku', code: 'taken', message: 'Another product already has this code.' },
  ]);
  await add(f, { name: 'No code' });
  const other = await add(f, { name: 'No code either' });
  // Changing one to a code that is taken is refused the same way, and changes nothing.
  const clash = await refusalOf(
    () =>
      api(f, 'updateProduct', {
        params: { id: other.id },
        body: values(other, { sku: 'PLAN-01' }),
      }),
    ValidationError,
  );
  expect(clash.issues[0]).toMatchObject({ path: '/sku', code: 'taken' });
  expect((await list(f)).items.map((each) => each.sku)).toEqual(['PLAN-01', null, null]);
});

it('lists by name, a page at a time, found by name or code, of one kind, in use or archived', async () => {
  const f = await fixture();
  const chairs = await add(f, { kind: 'product', name: 'chairs', sku: 'CH-1' });
  await add(f, { name: 'Balloons' });
  await add(f, { kind: 'product', name: 'Arch', sku: 'AR-9' });
  await add(f, { name: 'balloons' });
  const names = async (query: Record<string, unknown>) =>
    (await list(f, query)).items.map((each) => each.name);

  expect((await names({})).map((name) => name.toLowerCase())).toEqual([
    'arch',
    'balloons',
    'balloons',
    'chairs',
  ]);
  // Two to a page: the second page starts after the first one's last, by name then id.
  const first = await list(f, { limit: '2' });
  expect(first.items).toHaveLength(2);
  expect(first.nextCursor).toBe(first.items[1]?.id);
  const second = await list(f, { limit: '2', after: first.nextCursor });
  expect(second.nextCursor).toBeNull();
  expect([...first.items, ...second.items].map((each) => each.name.toLowerCase())).toEqual([
    'arch',
    'balloons',
    'balloons',
    'chairs',
  ]);
  expect(new Set([...first.items, ...second.items].map((each) => each.id)).size).toBe(4);

  expect(await names({ q: 'BALL' })).toHaveLength(2);
  expect(await names({ q: 'ar-9' })).toEqual(['Arch']);
  expect(await names({ q: '%' })).toEqual([]);
  expect(await names({ kind: 'product' })).toEqual(['Arch', 'chairs']);

  const archived = productContract.parse(
    await api(f, 'archiveProduct', {
      params: { id: chairs.id },
      body: { revision: chairs.revision },
    }),
  );
  expect(archived).toMatchObject({ archived: true, revision: 2 });
  expect(archived.archivedAt).not.toBeNull();
  expect(await names({ kind: 'product' })).toEqual(['Arch']);
  expect(await names({ archived: 'true' })).toEqual(['chairs']);
  // A page that starts after a product that is gone is refused where it was asked.
  await api(f, 'deleteProduct', { params: { id: archived.id } });
  const gone = await refusalOf(() => list(f, { after: archived.id }), ValidationError);
  expect(gone.issues[0]).toMatchObject({ path: '/after', code: 'unknown_cursor' });
});

it('changes a product from the revision it was read at, and refuses a stale one', async () => {
  const f = await fixture();
  const made = await add(f);
  const changed = productContract.parse(
    await api(f, 'updateProduct', {
      params: { id: made.id },
      body: values(made, { name: 'Planning', unitPrice: '2000', taxRate: '16', unit: 'day' }),
    }),
  );
  expect(changed).toMatchObject({
    name: 'Planning',
    unitPrice: '2000.0000',
    taxRate: '16.0000',
    unit: 'day',
    revision: 2,
  });
  const stale = await refusalOf(
    () =>
      api(f, 'updateProduct', { params: { id: made.id }, body: values(made, { name: 'Late' }) }),
    ConflictError,
  );
  expect(stale.message).toBe('This product changed since you opened it. Reload before saving.');
  for (const operationId of ['archiveProduct', 'restoreProduct'])
    await refusalOf(
      () => api(f, operationId, { params: { id: made.id }, body: { revision: made.revision } }),
      ConflictError,
    );
  expect(productContract.parse(await api(f, 'getProduct', { params: { id: made.id } })).name).toBe(
    'Planning',
  );
});

it('archives and restores, refusing what is already so', async () => {
  const f = await fixture();
  const made = await add(f);
  const act = async (operationId: string, current: Product) =>
    productContract.parse(
      await api(f, operationId, {
        params: { id: current.id },
        body: { revision: current.revision },
      }),
    );
  expect((await refusalOf(() => act('restoreProduct', made), ConflictError)).message).toBe(
    'This product is not archived.',
  );
  const archived = await act('archiveProduct', made);
  expect((await refusalOf(() => act('archiveProduct', archived), ConflictError)).message).toBe(
    'This product is already archived.',
  );
  const restored = await act('restoreProduct', archived);
  expect(restored).toMatchObject({ archived: false, archivedAt: null, revision: 3 });
  expect((await events(f, 'product.%')).map((event) => event.type)).toEqual([
    'product.created',
    'product.archived',
    'product.restored',
  ]);
});

it('deletes a product no document names, and keeps one a line was taken from', async () => {
  const f = await fixture();
  const unused = await add(f, { name: 'Unused' });
  const used = await add(f, { name: 'Used' });
  const draft = salesDocument.parse(
    await api(f, 'createSalesDocument', {
      body: {
        kind: 'quote',
        contactId: f.contactId,
        currency: 'KES',
        lines: [{ productId: used.id, name: 'Used', quantity: '1', unitPrice: '10' }],
      },
    }),
  );
  expect(draft.lines[0]?.productId).toBe(used.id);
  expect(await api(f, 'deleteProduct', { params: { id: unused.id } })).toBeUndefined();
  await refusalOf(() => api(f, 'getProduct', { params: { id: unused.id } }), NotFoundError);

  const read = productContract.parse(await api(f, 'getProduct', { params: { id: used.id } }));
  expect(read.used).toBe(true);
  const kept = await refusalOf(
    () => api(f, 'deleteProduct', { params: { id: used.id } }),
    ConflictError,
  );
  expect(kept.message).toBe(
    'A quote or an invoice names this product, so it is kept. Archive it instead.',
  );
  // Archived, it stays on the document that named it; changed, the document keeps its own words.
  await api(f, 'archiveProduct', { params: { id: used.id }, body: { revision: read.revision } });
  const after = salesDocument.parse(await api(f, 'getSalesDocument', { params: { id: draft.id } }));
  expect(after.lines[0]).toMatchObject({ productId: used.id, name: 'Used', unitPrice: '10.0000' });
});

it('keeps the catalogue to payments.manage, and one business’s products from another', async () => {
  const f = await fixture();
  const other = await fixture();
  const made = await add(f);
  const reader = f.withPermissions('payments.read');
  for (const attempt of [
    () => api(f, 'createProduct', { body: service }, reader),
    () => api(f, 'updateProduct', { params: { id: made.id }, body: values(made) }, reader),
    () => api(f, 'archiveProduct', { params: { id: made.id }, body: { revision: 1 } }, reader),
    () => api(f, 'restoreProduct', { params: { id: made.id }, body: { revision: 1 } }, reader),
    () => api(f, 'deleteProduct', { params: { id: made.id } }, reader),
  ])
    expect((await refusalOf(attempt, ForbiddenError)).permission).toBe('payments.manage');
  expect((await list(f)).items).toHaveLength(1);

  // From another business the product is not there: to read, change, archive or delete.
  expect((await list(other)).items).toEqual([]);
  for (const attempt of [
    () => api(other, 'getProduct', { params: { id: made.id } }),
    () => api(other, 'updateProduct', { params: { id: made.id }, body: values(made) }),
    () => api(other, 'archiveProduct', { params: { id: made.id }, body: { revision: 1 } }),
    () => api(other, 'restoreProduct', { params: { id: made.id }, body: { revision: 1 } }),
    () => api(other, 'deleteProduct', { params: { id: made.id } }),
  ])
    await refusalOf(attempt, NotFoundError);
  // Nor can a line of the other business name it.
  const refused = await refusalOf(
    () =>
      api(other, 'createSalesDocument', {
        body: {
          kind: 'quote',
          contactId: other.contactId,
          currency: 'KES',
          lines: [{ productId: made.id, name: 'Theirs', quantity: '1', unitPrice: '10' }],
        },
      }),
    ValidationError,
  );
  expect(refused.issues).toEqual([
    { path: '/lines/0/productId', code: 'unknown_product', message: 'This product was not found.' },
  ]);
  expect(
    productContract.parse(await api(f, 'getProduct', { params: { id: made.id } })).revision,
  ).toBe(1);
});

// Settings ---------------------------------------------------------------------------------

const readSettings = async (
  f: CommerceFixture,
  invocation = f.manager,
): Promise<CommerceSettings> =>
  commerceSettings.parse(await api(f, 'getCommerceSettings', {}, invocation));
const settingsInput = (current: CommerceSettings, change: Record<string, unknown> = {}) => ({
  numbering: {
    quote: { prefix: current.numbering.quote.prefix },
    invoice: { prefix: current.numbering.invoice.prefix },
    receipt: { prefix: current.numbering.receipt.prefix },
  },
  paymentTermsDays: current.paymentTermsDays,
  quoteValidityDays: current.quoteValidityDays,
  defaultNotes: current.defaultNotes,
  defaultTerms: current.defaultTerms,
  paymentInstructions: current.paymentInstructions,
  taxNumber: current.taxNumber,
  defaultTaxRate: current.defaultTaxRate,
  revision: current.revision,
  ...change,
});
const save = async (
  f: CommerceFixture,
  current: CommerceSettings,
  change: Record<string, unknown>,
) =>
  commerceSettings.parse(
    await api(f, 'updateCommerceSettings', { body: settingsInput(current, change) }),
  );

it('starts with defaults: three counters at one, fourteen and thirty days, nothing to print', async () => {
  const f = await fixture();
  expect(await readSettings(f)).toEqual({
    numbering: {
      quote: { prefix: 'QUO-', nextNumber: 1, lastNumber: 0, example: 'QUO-0001' },
      invoice: { prefix: 'INV-', nextNumber: 1, lastNumber: 0, example: 'INV-0001' },
      receipt: { prefix: 'RCT-', nextNumber: 1, lastNumber: 0, example: 'RCT-0001' },
    },
    paymentTermsDays: 14,
    quoteValidityDays: 30,
    defaultNotes: '',
    defaultTerms: '',
    paymentInstructions: '',
    taxNumber: null,
    defaultTaxRate: null,
    revision: 1,
    canManage: true,
  });
});

it('saves prefixes, next numbers, terms, the tax number and how to pay, from the revision read', async () => {
  const f = await fixture();
  const first = await readSettings(f);
  const saved = await save(f, first, {
    numbering: {
      quote: { prefix: 'Q/' },
      invoice: { prefix: 'HL-INV-', nextNumber: 120 },
      receipt: { prefix: '' },
    },
    paymentTermsDays: 7,
    quoteValidityDays: 21,
    defaultNotes: ' Thank you for your business. ',
    defaultTerms: 'Payment within seven days.',
    paymentInstructions: 'M-Pesa till 123456',
    taxNumber: 'P051234567X',
    defaultTaxRate: '16',
  });
  expect(saved).toMatchObject({
    numbering: {
      quote: { prefix: 'Q/', nextNumber: 1, lastNumber: 0, example: 'Q/0001' },
      invoice: { prefix: 'HL-INV-', nextNumber: 120, lastNumber: 0, example: 'HL-INV-0120' },
      receipt: { prefix: '', nextNumber: 1, lastNumber: 0, example: '0001' },
    },
    paymentTermsDays: 7,
    quoteValidityDays: 21,
    defaultNotes: 'Thank you for your business.',
    defaultTerms: 'Payment within seven days.',
    paymentInstructions: 'M-Pesa till 123456',
    taxNumber: 'P051234567X',
    defaultTaxRate: '16.0000',
    revision: 2,
  });
  expect(await readSettings(f)).toEqual(saved);
  // The revision it was first read at is stale now.
  const stale = await refusalOf(() => save(f, first, { paymentTermsDays: 30 }), ConflictError);
  expect(stale.message).toBe('These settings changed since you opened them. Reload before saving.');
  expect((await readSettings(f)).paymentTermsDays).toBe(7);
  expect(await events(f, 'commerce.%')).toEqual([
    { type: 'commerce.settings_updated', subject_kind: 'business', actor_kind: 'user' },
  ]);
});

it('never moves a counter to a number already given out, and says which', async () => {
  const f = await fixture();
  // Three invoices take 1, 2 and 3.
  for (let each = 0; each < 3; each += 1) {
    const draft = salesDocument.parse(
      await api(f, 'createSalesDocument', {
        body: {
          kind: 'invoice',
          contactId: f.contactId,
          currency: 'KES',
          lines: [{ name: 'Work', quantity: '1', unitPrice: '100' }],
        },
      }),
    );
    await api(f, 'issueSalesDocument', {
      params: { id: draft.id },
      body: { revision: draft.revision },
    });
  }
  const current = await readSettings(f);
  expect(current.numbering.invoice).toEqual({
    prefix: 'INV-',
    nextNumber: 4,
    lastNumber: 3,
    example: 'INV-0004',
  });
  for (const nextNumber of [1, 3]) {
    const refused = await refusalOf(
      () =>
        save(f, current, {
          numbering: {
            ...settingsInput(current).numbering,
            invoice: { prefix: 'INV-', nextNumber },
          },
          paymentTermsDays: 60,
        }),
      ValidationError,
    );
    expect(refused.issues).toEqual([
      {
        path: '/numbering/invoice/nextNumber',
        code: 'number_used',
        message: 'Numbers up to 3 were already given out. Choose a number above 3.',
      },
    ]);
  }
  // Nothing of a refused save is kept.
  expect(await readSettings(f)).toEqual(current);
  // Forward is allowed, and back again while nothing took a number in between.
  const forward = await save(f, current, {
    numbering: {
      ...settingsInput(current).numbering,
      invoice: { prefix: 'INV-', nextNumber: 500 },
    },
  });
  expect(forward.numbering.invoice).toMatchObject({ nextNumber: 500, lastNumber: 3 });
  const back = await save(f, forward, {
    numbering: { ...settingsInput(forward).numbering, invoice: { prefix: 'INV-', nextNumber: 4 } },
  });
  expect(back.numbering.invoice).toMatchObject({
    nextNumber: 4,
    lastNumber: 3,
    example: 'INV-0004',
  });
});

it('shows the settings to payments.read, keeps them to payments.manage, and to their business', async () => {
  const f = await fixture();
  const other = await fixture();
  const current = await readSettings(f);
  await save(f, current, { paymentInstructions: 'Ours alone', taxNumber: 'OURS' });

  const reader = f.withPermissions('payments.read');
  expect(await readSettings(f, reader)).toMatchObject({
    paymentInstructions: 'Ours alone',
    canManage: false,
  });
  expect(
    (await refusalOf(() => api(f, 'getCommerceSettings', {}, f.withPermissions()), ForbiddenError))
      .permission,
  ).toBe('payments.read');
  expect(
    (
      await refusalOf(
        () => api(f, 'updateCommerceSettings', { body: settingsInput(current) }, reader),
        ForbiddenError,
      )
    ).permission,
  ).toBe('payments.manage');
  // payments.manage includes seeing them.
  expect((await readSettings(f, f.withPermissions('payments.manage'))).canManage).toBe(true);

  expect(await readSettings(other)).toMatchObject({
    paymentInstructions: '',
    taxNumber: null,
    revision: 1,
  });
});
