// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DealDocumentsSection } from './deal-documents';

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
// The way to a Payments page, as its address.
vi.mock('./payments-links', () => ({
  PaymentsLink: ({
    splat,
    search,
    children,
  }: {
    splat: string;
    search?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a
      href={`/payments/${splat}${search === undefined ? '' : `?${new URLSearchParams(search).toString()}`}`}
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

const dealId = 'deal_01h455vb4pex5vsknk084sn02q';
const contactId = 'con_01h455vb4pex5vsknk084sn02q';
const summary = (more: object): object => ({
  id: 'sdoc_1',
  kind: 'invoice',
  status: 'sent',
  number: 'INV-0007',
  contactId,
  customerName: 'Amina Otieno',
  dealId,
  currency: 'KES',
  issueDate: '2026-10-12',
  dueDate: '2026-10-26',
  total: '5800.0000',
  amountPaid: '0.0000',
  balanceDue: '5800.0000',
  overdue: false,
  expired: false,
  ...more,
});

function serve({
  items = [],
  canManage = true,
  primaryContact = { id: contactId, trashed: false },
  refused = false,
}: {
  items?: object[];
  canManage?: boolean;
  primaryContact?: { id: string; trashed: boolean } | null;
  refused?: boolean;
} = {}): void {
  server.answer = (operation) => {
    if (operation === 'getDealDetails') return { id: dealId, primaryContact };
    if (operation === 'listSalesDocuments') {
      if (refused) throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
      return { items, nextCursor: null, canManage };
    }
    return undefined;
  };
}

async function unfold(readOnly = false): Promise<HTMLElement> {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <DealDocumentsSection businessId="biz_test" dealId={dealId} readOnly={readOnly} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  const section = screen.getByRole('region', { name: 'Quotes and invoices' });
  const heading = within(section).getByRole('button', { name: 'Quotes and invoices' });
  // Folded away, it asks the server for nothing.
  expect(heading.getAttribute('aria-expanded')).toBe('false');
  expect(server.calls).toHaveLength(0);
  await userEvent.setup().click(heading);
  expect(heading.getAttribute('aria-expanded')).toBe('true');
  return section;
}

const hrefs = (section: HTMLElement): (string | null)[] =>
  within(section)
    .getAllByRole('link')
    .map((link) => link.getAttribute('href'));

describe('DealDocumentsSection', () => {
  it("lists the opportunity's quotes and invoices with their status and total", async () => {
    serve({
      items: [
        summary({}),
        summary({ id: 'sdoc_2', kind: 'quote', status: 'draft', number: null, issueDate: null }),
      ],
    });
    const section = await unfold();
    const list = await within(section).findByRole('list', {
      name: 'Quotes and invoices of this opportunity',
    });
    const [invoice, quote] = within(list).getAllByRole('listitem');
    expect(invoice?.textContent).toContain('INV-0007');
    expect(invoice?.textContent).toContain('Sent');
    expect(invoice?.textContent).toContain('KES 5,800.00');
    expect(quote?.textContent).toContain('Draft quote');
    expect(server.calls.find((call) => call.operation === 'listSalesDocuments')?.input).toEqual({
      query: { dealId, limit: 20 },
    });
    // Each opens on its own page, and a new one is for the opportunity and its primary contact.
    expect(hrefs(section)).toEqual([
      '/payments/invoices/sdoc_1',
      '/payments/quotes/sdoc_2',
      `/payments/quotes/new?contact=${contactId}&deal=${dealId}`,
      `/payments/invoices/new?contact=${contactId}&deal=${dealId}`,
    ]);
  });

  it('says there are none yet, and still offers to start one', async () => {
    serve();
    const section = await unfold();
    expect(
      await within(section).findByText('No quote or invoice for this opportunity yet.'),
    ).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'New quote' })).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'New invoice' })).toBeTruthy();
  });

  it('asks for a primary contact before one can be started', async () => {
    serve({ primaryContact: null });
    const section = await unfold();
    expect(
      await within(section).findByText(
        'Give this opportunity a primary contact to start a quote or an invoice for it.',
      ),
    ).toBeTruthy();
    expect(within(section).queryByRole('link')).toBeNull();
  });

  const lookers: readonly [string, boolean, Parameters<typeof serve>[0]][] = [
    ['an opportunity in the trash', true, {}],
    ['someone who may not manage payments', false, { canManage: false }],
    ['a primary contact in the trash', false, { primaryContact: { id: contactId, trashed: true } }],
  ];
  it.each(lookers)('lists and starts nothing for %s', async (_, readOnly, served) => {
    serve({ items: [summary({})], ...served });
    const section = await unfold(readOnly);
    await within(section).findByText('INV-0007');
    expect(hrefs(section)).toEqual(['/payments/invoices/sdoc_1']);
  });

  it('says so to someone who may not see payments', async () => {
    serve({ refused: true });
    const section = await unfold();
    expect(
      await within(section).findByText(
        'Seeing quotes and invoices needs permission to see payments.',
      ),
    ).toBeTruthy();
  });
});
