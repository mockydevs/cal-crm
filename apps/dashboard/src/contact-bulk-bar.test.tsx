// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import ContactBulkBar from './contact-bulk-bar';

const granted = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: () => Promise.resolve({ business: null, permissions: granted.permissions }),
  }),
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

function show(): void {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>
        <ContactBulkBar
          businessId="biz_test"
          slug="harbor"
          ticked={new Set(['con_1', 'con_2'])}
          everyone={undefined}
          loaded={2}
          counted={{ count: 2, exact: true }}
          list={{ q: '', createdFrom: undefined }}
          columns={['name']}
          fields={[]}
          onSelectAll={() => undefined}
          onClear={() => undefined}
          onDone={() => undefined}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

it('offers only the actions the reader’s role allows', async () => {
  granted.permissions = ['contacts.manage', 'deals.manage'];
  show();
  // Shown once the role is read.
  expect(await screen.findByRole('button', { name: 'Opportunity' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Delete' })).toBeDefined();
  for (const name of ['Send SMS', 'Send Email', 'Export', 'Add Tag', 'Add to Workflow'])
    expect(screen.queryByRole('button', { name })).toBeNull();
});

it('offers sending and exporting to a role that may do them', async () => {
  granted.permissions = ['contacts.manage', 'campaigns.send', 'contacts.export'];
  show();
  expect(await screen.findByRole('button', { name: 'Send SMS' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Send Email' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Export' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Add Tag' })).toBeNull();
});

it('offers Verify emails under More, and opens its dialog', async () => {
  granted.permissions = ['contacts.manage'];
  show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'More' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Verify emails' }));
  expect(await screen.findByRole('dialog', { name: 'Verify emails' })).toBeDefined();
});
