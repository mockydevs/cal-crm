// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { MarketplaceApp } from '@repo/contracts';
import { createClient } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketplacePage } from './marketplace';
import type { MarketplaceSearch } from './marketplace-search';
import { loadMarketplaceWords } from './marketplace-words';

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
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params: Record<string, string>;
    children: ReactNode;
    className?: string;
  }) => (
    <a
      className={className}
      href={Object.entries(params).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to,
      )}
    >
      {children}
    </a>
  ),
}));

configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 30000 });
beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

const appOf = (patch: Partial<MarketplaceApp> = {}): MarketplaceApp => ({
  id: 'mapp_01k8e2wzr0e008000000000001',
  name: 'Zap Sync',
  tagline: 'Sends new contacts to your spreadsheet',
  description: 'Keeps a sheet up to date.',
  developer: 'Northwind Labs',
  websiteUrl: 'https://zapsync.example',
  supportEmail: 'help@zapsync.example',
  iconUrl: null,
  categories: ['productivity', 'sales'],
  scopes: ['contacts.manage'],
  readGroups: [],
  webhookEvents: [],
  status: 'listed',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
  install: null,
  ...patch,
});
const zap = appOf();
const installedAt = {
  id: 'mins_01k8e2wzr0e008000000000001',
  appId: 'mapp_01k8e2wzr0e008000000000002',
  grantedScopes: ['calls.read'],
  grantedReadGroups: [],
  installedBy: 'Dana Brooks',
  installedAt: '2026-10-03T09:00:00.000Z',
};
const dialer = appOf({
  id: 'mapp_01k8e2wzr0e008000000000002',
  name: 'Dial Pad',
  tagline: 'Calls from your browser',
  developer: 'Lakeside Software',
  iconUrl: 'https://dialpad.example/icon.png',
  categories: ['communication'],
  scopes: ['calls.read'],
  install: installedAt,
});

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly business: string | null;
}
let calls: Call[];
let listed: MarketplaceApp[];
let installed: MarketplaceApp[];
let failing: boolean;
beforeEach(() => {
  calls = [];
  listed = [zap, dialer];
  installed = [dialer];
  failing = false;
});

const listCalls = () => calls.filter((call) => call.url.pathname === '/api/v1/marketplace/apps');

function open(start: MarketplaceSearch = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const fetch: typeof globalThis.fetch = (input) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://crm.test',
    );
    calls.push({ method: 'GET', url, business: null });
    if (failing)
      return Promise.resolve(
        Response.json({ type: 'about:blank', title: 'Bad Gateway', status: 502 }, { status: 502 }),
      );
    if (url.pathname === '/api/v1/marketplace/installs')
      return Promise.resolve(Response.json({ items: installed, canInstall: true }));
    const q = url.searchParams.get('q')?.toLowerCase() ?? '';
    const category = url.searchParams.get('category');
    return Promise.resolve(
      Response.json({
        items: listed.filter(
          (app) =>
            app.name.toLowerCase().includes(q) &&
            (category === null || app.categories.some((each) => each === category)),
        ),
        canInstall: true,
      }),
    );
  };
  const client = createClient({ baseUrl: '/api/v1', fetch, business: () => 'biz_test' });
  const searches: MarketplaceSearch[] = [];
  function Harness() {
    const [search, setSearch] = useState(start);
    return (
      <MarketplacePage
        client={client}
        businessId="biz_test"
        slug="harbor"
        search={search}
        onSearch={(next) => {
          searches.push(next);
          setSearch(next);
        }}
      />
    );
  }
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        <Harness />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), searches };
}

const cards = () =>
  [...screen.getByRole('list', { name: 'Apps' }).children].filter(
    (each) => each instanceof HTMLElement,
  );

describe('All apps', () => {
  it('shows each listed app as a card that opens its page', async () => {
    open();
    expect(screen.getByRole('heading', { level: 1, name: 'App Marketplace' })).toBeDefined();
    await screen.findByText('Zap Sync');
    expect(cards()).toHaveLength(2);
    const card = cards()[0];
    if (card === undefined) throw new Error('No card');
    expect(within(card).getByText('Northwind Labs')).toBeDefined();
    expect(within(card).getByText('Sends new contacts to your spreadsheet')).toBeDefined();
    expect(within(card).getByText('ZS')).toBeDefined();
    expect(
      within(within(card).getByRole('list', { name: 'Categories' }))
        .getAllByRole('listitem')
        .map((each) => each.textContent),
    ).toEqual(['Productivity', 'Sales']);
    expect(within(card).queryByText('Installed')).toBeNull();
    expect(within(card).getByRole('link').getAttribute('href')).toBe(
      '/b/harbor/app-marketplace/mapp_01k8e2wzr0e008000000000001',
    );
    const installedCard = cards()[1];
    if (installedCard === undefined) throw new Error('No card');
    expect(within(installedCard).getByText('Installed')).toBeDefined();
    expect(calls[0]?.url.search).toBe('');
  });

  it('shows the icon, and the initials when it will not load', async () => {
    open();
    await screen.findByText('Dial Pad');
    const card = cards()[1];
    if (card === undefined) throw new Error('No card');
    const icon = card.querySelector('img');
    expect(icon?.getAttribute('src')).toBe('https://dialpad.example/icon.png');
    expect(icon?.getAttribute('alt')).toBe('');
    if (icon === null) throw new Error('No icon');
    fireEvent.error(icon);
    expect(card.querySelector('img')).toBeNull();
    expect(within(card).getByText('DP')).toBeDefined();
  });

  it('searches once typing pauses, and keeps the search in the address', async () => {
    const { user, searches } = open();
    await screen.findByText('Zap Sync');
    await user.type(screen.getByRole('searchbox', { name: 'Search apps' }), 'dial');
    await waitFor(() => {
      expect(listCalls().at(-1)?.url.searchParams.get('q')).toBe('dial');
    });
    await waitFor(() => {
      expect(cards()).toHaveLength(1);
    });
    expect(searches.at(-1)).toEqual({ q: 'dial' });
  });

  it('filters by category', async () => {
    const { user, searches } = open();
    await screen.findByText('Zap Sync');
    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'Communication' }));
    await waitFor(() => {
      expect(listCalls().at(-1)?.url.searchParams.get('category')).toBe('communication');
    });
    await waitFor(() => {
      expect(cards()).toHaveLength(1);
    });
    expect(searches.at(-1)).toEqual({ category: 'communication' });
    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'All categories' }));
    expect(searches.at(-1)).toEqual({});
  });

  it('says when the agency has listed nothing', async () => {
    listed = [];
    open();
    await screen.findByRole('heading', { level: 2, name: 'No apps yet' });
    expect(screen.getByText('Your agency hasn’t listed any apps.')).toBeDefined();
  });

  it('says when nothing matches the search', async () => {
    open({ q: 'nothing like it' });
    await screen.findByRole('heading', { level: 2, name: 'No apps match' });
    expect(screen.getByRole('searchbox', { name: 'Search apps' })).toHaveProperty(
      'value',
      'nothing like it',
    );
  });

  it('says when the list did not load, and tries again', async () => {
    failing = true;
    const { user } = open();
    await screen.findByText('The apps couldn’t be loaded.');
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Zap Sync');
  });
});

describe('Installed', () => {
  it('lists only this business’s installs, from its own list', async () => {
    const { user, searches } = open();
    await screen.findByText('Zap Sync');
    await user.click(screen.getByRole('tab', { name: 'Installed' }));
    expect(searches.at(-1)).toEqual({ tab: 'installed' });
    expect(screen.getByRole('tab', { name: 'Installed' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await waitFor(() => {
      expect(cards()).toHaveLength(1);
    });
    expect(screen.getByText('Dial Pad')).toBeDefined();
    expect(calls.some((call) => call.url.pathname === '/api/v1/marketplace/installs')).toBe(true);
    expect(screen.getByRole('tabpanel', { name: 'Installed' })).toBeDefined();
  });

  it('moves between the tabs with the arrow keys', async () => {
    const { user, searches } = open();
    await screen.findByText('Zap Sync');
    screen.getByRole('tab', { name: 'All apps' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(searches.at(-1)).toEqual({ tab: 'installed' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Installed' }));
  });

  it('finds installed apps by the search and category on the page', async () => {
    open({ tab: 'installed', q: 'zap' });
    await screen.findByRole('heading', { level: 2, name: 'No apps match' });
    cleanup();
    open({ tab: 'installed', q: 'dial', category: 'communication' });
    await screen.findByText('Dial Pad');
    expect(cards()).toHaveLength(1);
  });

  it('says when nothing is installed', async () => {
    installed = [];
    open({ tab: 'installed' });
    await screen.findByRole('heading', { level: 2, name: 'No apps installed' });
    expect(screen.getByText('Apps you install show here.')).toBeDefined();
    expect(listCalls()).toHaveLength(0);
  });

  it('says when the installs did not load', async () => {
    failing = true;
    open({ tab: 'installed' });
    await screen.findByText('The apps couldn’t be loaded.');
  });
});

it('loads its own words', async () => {
  await loadMarketplaceWords();
  expect(i18n.messages).not.toEqual({});
});
