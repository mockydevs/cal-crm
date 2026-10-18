// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickOf, linkOf } from '../e2e/conversation-extras-fixtures';
import { TriggerLinksPage } from './trigger-links';

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
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ params, children }: { params: { contactId: string }; children: ReactNode }) => (
    <a href={`/contacts/${params.contactId}`}>{children}</a>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const offer = linkOf(1, 'Spring Offer', 'https://harborlights.example/spring', {
  clicks: 3,
  contacts: 2,
  lastClickedAt: '2026-10-02T09:30:00.000Z',
});
const booking = linkOf(2, 'Booking page', 'https://harborlights.example/book');
const maya = clickOf(31, 'Maya Chen', '2026-10-02T09:30:00.000Z');
const gone = { ...clickOf(32, 'Jordan Reyes', '2026-10-01T08:00:00.000Z') };
gone.contact = { ...gone.contact, trashed: true };

function serve(
  links: (typeof offer)[],
  on: (operation: string, input: unknown) => unknown = () => undefined,
  canManage = true,
): void {
  server.answer = (operation, input) => {
    const own = on(operation, input);
    if (own !== undefined) return own;
    if (operation === 'listTriggerLinks')
      return { items: links, total: links.length, next: null, canManage };
    if (operation === 'listTriggerLinkClicks')
      return { items: [maya, gone], clicks: 3, contacts: 2, next: null };
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
        <TriggerLinksPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const inputOf = (operation: string): unknown =>
  server.calls.findLast((call) => call.operation === operation)?.input;

async function rowAction(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  action: string,
): Promise<void> {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}

describe('the Trigger Links page', () => {
  it('lists each link with where it goes, its merge key and its clicks', async () => {
    serve([offer, booking]);
    show();
    const row = (await screen.findByRole('rowheader', { name: 'Spring Offer' })).closest('tr');
    if (row === null) throw new Error('No row.');
    expect(
      within(row).getByRole('link', { name: 'https://harborlights.example/spring' }),
    ).toHaveProperty('target', '_blank');
    expect(within(row).getByText('{{trigger_link.spring_offer}}')).toBeTruthy();
    expect(
      within(row).getByRole('button', { name: 'Copy {{trigger_link.spring_offer}}' }),
    ).toBeTruthy();
    expect(within(row).getAllByRole('cell')[2]?.textContent).toBe('3');
    expect(within(row).getAllByRole('cell')[3]?.textContent).toBe('2');
    const unclicked = (await screen.findByRole('rowheader', { name: 'Booking page' })).closest(
      'tr',
    );
    if (unclicked === null) throw new Error('No row.');
    expect(within(unclicked).getByText('Never')).toBeTruthy();
  });

  it('creates a link, showing the key it will have', async () => {
    serve([], (operation) => (operation === 'createTriggerLink' ? booking : undefined));
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Add link' }));
    const panel = await screen.findByRole('dialog', { name: 'Add link' });
    const create = within(panel).getByRole('button', { name: 'Create link' });
    expect(create).toHaveProperty('disabled', true);
    await user.type(within(panel).getByLabelText('Name'), 'Booking page');
    expect(within(panel).getByText('{{trigger_link.booking_page}}')).toBeTruthy();
    expect(create).toHaveProperty('disabled', true);
    await user.type(within(panel).getByLabelText('Link URL'), 'https://harborlights.example/book');
    await user.click(create);
    await waitFor(() => {
      expect(inputOf('createTriggerLink')).toEqual({
        body: { name: 'Booking page', url: 'https://harborlights.example/book' },
      });
    });
    expect(await screen.findByText('Link created.')).toBeTruthy();
  });

  it('duplicates a link as a new one named after it, with its own key', async () => {
    serve([offer], (operation) => (operation === 'createTriggerLink' ? booking : undefined));
    const user = show();
    await rowAction(user, 'Spring Offer', 'Duplicate');
    const panel = await screen.findByRole('dialog', { name: 'Duplicate link' });
    expect(within(panel).getByLabelText('Name')).toHaveProperty('value', 'Copy of Spring Offer');
    expect(within(panel).getByLabelText('Link URL')).toHaveProperty(
      'value',
      'https://harborlights.example/spring',
    );
    // A copy is a new link: it gets a key of its own, from its name.
    expect(within(panel).getByText('{{trigger_link.copy_of_spring_offer}}')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Create link' }));
    await waitFor(() => {
      expect(inputOf('createTriggerLink')).toEqual({
        body: { name: 'Copy of Spring Offer', url: 'https://harborlights.example/spring' },
      });
    });
    expect(await screen.findByText('Link created.')).toBeTruthy();
  });

  it('shows what the server says is wrong with an address under the field', async () => {
    serve([offer], (operation) => {
      if (operation === 'updateTriggerLink')
        throw new ApiError({
          type: 'about:blank',
          title: 'Unprocessable Content',
          status: 422,
          errors: [{ path: '/url', code: 'invalid_url', message: 'Use a full web address.' }],
        });
      return undefined;
    });
    const user = show();
    await rowAction(user, 'Spring Offer', 'Edit');
    const panel = await screen.findByRole('dialog', { name: 'Edit link' });
    // A saved link keeps its key, whatever it is renamed to.
    expect(within(panel).getByText('{{trigger_link.spring_offer}}')).toBeTruthy();
    const url = within(panel).getByLabelText('Link URL');
    await user.clear(url);
    await user.type(url, 'harborlights');
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));
    expect(await within(panel).findByText('Use a full web address.')).toBeTruthy();
    expect(inputOf('updateTriggerLink')).toEqual({
      params: { linkId: offer.id },
      body: { name: 'Spring Offer', url: 'harborlights', revision: offer.revision },
    });
  });

  it('asks before deleting a link, and says what goes with it', async () => {
    serve([offer], (operation) => (operation === 'deleteTriggerLink' ? null : undefined));
    const user = show();
    await rowAction(user, 'Spring Offer', 'Delete');
    const asking = await screen.findByRole('dialog', { name: 'Delete Spring Offer?' });
    expect(within(asking).getByText(/click history is deleted with it/)).toBeTruthy();
    expect(within(asking).getByText(/\{\{trigger_link\.spring_offer\}\}/)).toBeTruthy();
    await user.click(within(asking).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(inputOf('deleteTriggerLink')).toEqual({ params: { linkId: offer.id } });
    });
    expect(await screen.findByText('Link deleted.')).toBeTruthy();
  });

  it('analyzes a link: who clicked, when, and the counts for a range of days', async () => {
    serve([offer, booking]);
    const user = show();
    await rowAction(user, 'Spring Offer', 'Analyze');
    const analyze = await screen.findByRole('region', { name: 'Analyze' });
    const table = await within(analyze).findByRole('table');
    expect(within(table).getByRole('link', { name: 'Maya Chen' })).toBeTruthy();
    // A contact in the trash has no page to open.
    expect(within(table).queryByRole('link', { name: /Jordan Reyes/ })).toBeNull();
    expect(within(table).getByText('(in the trash)')).toBeTruthy();
    expect(
      within(analyze).getByText('Clicks', { selector: 'dt' }).nextElementSibling?.textContent,
    ).toBe('3');
    expect(inputOf('listTriggerLinkClicks')).toEqual({
      params: { linkId: offer.id },
      query: { limit: 20 },
    });

    fireEvent.change(within(analyze).getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(within(analyze).getByLabelText('To'), { target: { value: '2026-10-02' } });
    await waitFor(() => {
      expect(inputOf('listTriggerLinkClicks')).toEqual({
        params: { linkId: offer.id },
        query: {
          limit: 20,
          from: new Date(2026, 9, 1).toISOString(),
          to: new Date(2026, 9, 3).toISOString(),
        },
      });
    });
    expect(await within(analyze).findByText('Clicks in the range')).toBeTruthy();

    // A range that ends before it starts asks for nothing.
    const asked = server.calls.length;
    fireEvent.change(within(analyze).getByLabelText('To'), { target: { value: '2026-09-01' } });
    expect(await within(analyze).findByText('The range ends before it starts.')).toBeTruthy();
    expect(server.calls.length).toBe(asked);
  });

  it('asks for a link before it analyzes anything', async () => {
    serve([offer]);
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Analyze' }));
    expect(await screen.findByText('Choose a link to see who clicked it.')).toBeTruthy();
    expect(server.calls.some((call) => call.operation === 'listTriggerLinkClicks')).toBe(false);
  });

  it('lets someone who may not manage templates read and analyze, and no more', async () => {
    serve([offer], undefined, false);
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Actions for Spring Offer' }));
    expect(await screen.findByRole('menuitem', { name: 'Analyze' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add link' })).toBeNull();
    expect(
      screen.getByText(
        'You can read trigger links. Changing them needs permission to manage templates.',
      ),
    ).toBeTruthy();
  });

  it('says so when there are no links', async () => {
    serve([]);
    show();
    expect(await screen.findByText('No links available.')).toBeTruthy();
  });
});
