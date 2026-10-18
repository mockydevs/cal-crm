// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Product } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ProductsPage from './payments-products';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('./shell/page', () => ({
  Page: ({
    title,
    actions,
    children,
  }: {
    title: string;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {children}
    </main>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const product = (name: string, more: Partial<Product> = {}): Product => ({
  id: `prod_${name}`,
  kind: 'service',
  name,
  description: '',
  sku: null,
  unit: 'hour',
  unitPrice: '2000.0000',
  currency: 'KES',
  taxRate: '16.0000',
  archived: false,
  archivedAt: null,
  used: false,
  revision: 3,
  canManage: true,
  createdAt: '2026-10-12T09:00:00.000Z',
  updatedAt: '2026-10-12T09:00:00.000Z',
  ...more,
});

/** A server holding these products; `on` answers the operations a test cares about. */
function serve(
  products: Product[],
  on: (operation: string, input: unknown) => unknown = () => undefined,
  canManage = true,
): void {
  server.answer = (operation, input) => {
    const own = on(operation, input);
    if (own !== undefined) return own;
    if (operation === 'listProducts') return { items: products, nextCursor: null, canManage };
    if (operation === 'getBusinessProfile') return { currency: 'KES' };
    return undefined;
  };
}

function show(): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <ProductsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const inputOf = (operation: string): unknown =>
  server.calls.findLast((call) => call.operation === operation)?.input;

describe('ProductsPage', () => {
  it('lists each product with its kind, unit, rate and tax, and what can be done to it', async () => {
    serve([
      product('Design', { sku: 'DSGN', used: true }),
      product('Poster', { kind: 'product', unit: '', taxRate: null, unitPrice: '350.5000' }),
    ]);
    show();
    const table = await screen.findByRole('table');
    const [, design, poster] = within(table).getAllByRole('row');
    if (design === undefined || poster === undefined) throw new Error('Two rows were expected.');
    expect(design.textContent).toContain('Service');
    expect(design.textContent).toContain('DSGN');
    expect(design.textContent).toContain('KES 2,000.00');
    expect(design.textContent).toContain('16%');
    expect(poster.textContent).toContain('Product');
    expect(poster.textContent).toContain('KES 350.50');
    expect(poster.textContent).toContain('Default');
    // One that a quote or an invoice names is archived, never deleted.
    expect(within(design).getByRole('button', { name: 'Edit Design' })).toBeDefined();
    expect(within(design).getByRole('button', { name: 'Archive Design' })).toBeDefined();
    expect(within(design).queryByRole('button', { name: 'Delete Design' })).toBeNull();
    expect(within(poster).getByRole('button', { name: 'Delete Poster' })).toBeDefined();
    expect(inputOf('listProducts')).toEqual({ query: { archived: 'false', limit: 50 } });
  });

  it('asks the server for a kind, for the archived ones and for what is searched', async () => {
    serve([product('Design')]);
    const user = show();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Services' }));
    await waitFor(() => {
      expect(inputOf('listProducts')).toEqual({
        query: { kind: 'service', archived: 'false', limit: 50 },
      });
    });
    await user.click(screen.getByRole('switch', { name: 'Archived' }));
    await waitFor(() => {
      expect(inputOf('listProducts')).toEqual({
        query: { kind: 'service', archived: 'true', limit: 50 },
      });
    });
    await user.type(screen.getByRole('searchbox', { name: 'Search products' }), 'des');
    await waitFor(() => {
      expect(inputOf('listProducts')).toEqual({
        query: { q: 'des', kind: 'service', archived: 'true', limit: 50 },
      });
    });
  });

  it('archives with the revision the row was read at, and says so', async () => {
    serve([product('Design')], (operation) =>
      operation === 'archiveProduct' ? product('Design', { archived: true }) : undefined,
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Archive Design' }));
    expect(await screen.findByText('Design was archived.')).toBeDefined();
    expect(inputOf('archiveProduct')).toEqual({
      params: { id: 'prod_Design' },
      body: { revision: 3 },
    });
  });

  it('restores an archived product', async () => {
    serve([product('Design', { archived: true })], (operation) =>
      operation === 'restoreProduct' ? product('Design') : undefined,
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Restore Design' }));
    expect(await screen.findByText('Design is in use again.')).toBeDefined();
  });

  it('says when someone else changed the product first, and reads the list again', async () => {
    serve([product('Design')], (operation) => {
      if (operation === 'archiveProduct')
        throw new ApiError({ type: 'about:blank', title: 'Conflict', status: 409 });
      return undefined;
    });
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Archive Design' }));
    expect(
      await screen.findByText(
        'Someone changed it since this list was read. The list is up to date now; try again.',
      ),
    ).toBeDefined();
    expect(server.calls.filter((call) => call.operation === 'listProducts').length).toBe(2);
  });

  it('deletes one that nothing names, after asking', async () => {
    serve([product('Poster')]);
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Delete Poster' }));
    const asking = await screen.findByRole('dialog', { name: 'Delete product' });
    await user.click(within(asking).getByRole('button', { name: 'Delete for good' }));
    expect(await screen.findByText('Poster was deleted.')).toBeDefined();
    expect(inputOf('deleteProduct')).toEqual({ params: { id: 'prod_Poster' } });
  });

  it('offers nothing to change to someone who may only look', async () => {
    serve([product('Design')], undefined, false);
    show();
    await screen.findByRole('table');
    expect(screen.getByText(/You can look at the products/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Add product' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Design$/ })).toBeNull();
  });

  it("says so when the catalogue may not be seen, and when it couldn't be read", async () => {
    serve([], (operation) => {
      if (operation === 'listProducts')
        throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
      return undefined;
    });
    show();
    expect(
      await screen.findByText("You don't have permission to see this business's payments."),
    ).toBeDefined();
    cleanup();
    serve([], (operation) => {
      if (operation === 'listProducts')
        throw new ApiError({ type: 'about:blank', title: 'Bad request', status: 400 });
      return undefined;
    });
    show();
    expect(await screen.findByText("The products couldn't be loaded.")).toBeDefined();
  });
});
