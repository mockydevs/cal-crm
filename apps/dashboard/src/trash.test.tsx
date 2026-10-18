// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { TrashedRecord } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import { TrashPage } from './trash';

const items = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: () =>
      Promise.resolve({ items: items.list, next: null, retentionDays: 30, canPurge: true }),
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('./shell/page', () => ({
  Page: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
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
afterEach(cleanup);

const trashed = (rest: Partial<TrashedRecord>): TrashedRecord => ({
  id: 'con_01m4bd188ff82s0add91b7pz63',
  kind: 'contact',
  name: 'Janet Doe',
  trashedAt: '2026-10-08T12:00:00.000Z',
  purgeAt: '2026-11-07T12:00:00.000Z',
  mergedInto: null,
  ...rest,
});

it('shows a merged contact without Restore, with a link to the contact it went into', async () => {
  items.list = [
    trashed({ mergedInto: 'con_01m4bd9fteedat3be9bqgx2047' }),
    trashed({ id: 'con_01m4bdmgqwfgatd5ch0pqddfxm', name: 'Maya Thompson' }),
  ];
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>
        <TrashPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  const [merged, other] = within(
    await screen.findByRole('list', { name: 'In the trash' }),
  ).getAllByRole('listitem');
  if (merged === undefined || other === undefined) throw new Error('Two items were expected.');
  expect(within(merged).queryByRole('button', { name: 'Restore Janet Doe' })).toBeNull();
  expect(within(merged).getByRole('link', { name: 'the contact kept' }).getAttribute('href')).toBe(
    '/contacts/con_01m4bd9fteedat3be9bqgx2047',
  );
  expect(merged.textContent).toContain('Merged into the contact kept');
  expect(within(merged).getByRole('button', { name: 'Delete Janet Doe forever' })).toBeTruthy();
  expect(within(other).getByRole('button', { name: 'Restore Maya Thompson' })).toBeTruthy();
});
