// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactDocuments } from './contact-documents';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: () => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer());
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
// The links are the router's: here each is an anchor that says where it goes.
vi.mock('./payments-links', () => ({
  PaymentsLink: ({
    splat,
    search,
    children,
  }: {
    splat: string;
    search?: { contact?: string };
    children: ReactNode;
  }) => (
    <a
      href={`/payments/${splat}${search?.contact === undefined ? '' : `?contact=${search.contact}`}`}
    >
      {children}
    </a>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const summary = (more: Record<string, unknown>) => ({
  id: 'sdoc_1',
  kind: 'invoice',
  status: 'sent',
  number: 'INV-0007',
  contactId: 'con_1',
  customerName: 'Amina Otieno',
  dealId: null,
  currency: 'KES',
  issueDate: '2026-10-12',
  dueDate: '2026-10-26',
  total: '5800.0000',
  amountPaid: '0.0000',
  balanceDue: '5800.0000',
  overdue: false,
  expired: false,
  createdAt: '2026-10-12T09:00:00.000Z',
  updatedAt: '2026-10-12T09:00:00.000Z',
  ...more,
});

function show(readOnly = false): void {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>
        <ContactDocuments contactId="con_1" readOnly={readOnly} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('ContactDocuments', () => {
  it("lists the contact's quotes and invoices, each opening on its own page", async () => {
    server.answer = () => ({
      items: [
        summary({ overdue: true }),
        summary({ id: 'sdoc_2', kind: 'quote', number: null, status: 'draft', issueDate: null }),
      ],
      nextCursor: 'sdoc_2',
      canManage: true,
    });
    show();
    const list = await screen.findByRole('list', { name: 'Quotes and invoices of this contact' });
    const [invoice, quote] = within(list).getAllByRole('listitem');
    expect(invoice).toBeDefined();
    expect(quote).toBeDefined();
    if (invoice === undefined || quote === undefined) return;
    expect(within(invoice).getByRole('link', { name: 'INV-0007' }).getAttribute('href')).toBe(
      '/payments/invoices/sdoc_1',
    );
    expect(invoice.textContent).toContain('Overdue');
    expect(invoice.textContent).toContain('KES 5,800.00');
    expect(invoice.textContent).toContain('Oct 12, 2026');
    expect(within(quote).getByRole('link', { name: 'Draft quote' }).getAttribute('href')).toBe(
      '/payments/quotes/sdoc_2',
    );
    expect(quote.textContent).toContain('Draft');
    expect(
      screen.getByText('This contact has more quotes and invoices than are listed here.'),
    ).toBeDefined();
    expect(server.calls).toEqual([
      { operation: 'listSalesDocuments', input: { query: { contactId: 'con_1', limit: 20 } } },
    ]);
    // Someone who may manage payments starts one for the contact from here.
    expect(screen.getByRole('link', { name: 'New quote' }).getAttribute('href')).toBe(
      '/payments/quotes/new?contact=con_1',
    );
    expect(screen.getByRole('link', { name: 'New invoice' }).getAttribute('href')).toBe(
      '/payments/invoices/new?contact=con_1',
    );
  });

  it('says there is none yet, and starts none for someone who may only look', async () => {
    server.answer = () => ({ items: [], nextCursor: null, canManage: false });
    show();
    expect(await screen.findByText('No quote or invoice for this contact yet.')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('starts none for a contact in the trash', async () => {
    server.answer = () => ({ items: [], nextCursor: null, canManage: true });
    show(true);
    expect(await screen.findByText('No quote or invoice for this contact yet.')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('tells someone who may not see payments so, in a line', async () => {
    server.answer = () => {
      throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
    };
    show();
    expect(
      await screen.findByText('Seeing quotes and invoices needs permission to see payments.'),
    ).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says when the list could not be read, with the way to try again', async () => {
    server.answer = () => {
      throw new ApiError({ type: 'about:blank', title: 'Bad request', status: 400 });
    };
    show();
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
  });
});
