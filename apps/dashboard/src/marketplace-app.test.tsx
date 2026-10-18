// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { MarketplaceAppDetail } from '@repo/contracts';
import { createClient } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketplaceAppPage } from './marketplace-app';

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

const appId = 'mapp_01k8e2wzr0e008000000000001';
const installId = 'mins_01k8e2wzr0e008000000000001';
const detailOf = (patch: Partial<MarketplaceAppDetail> = {}): MarketplaceAppDetail => ({
  id: appId,
  name: 'Zap Sync',
  tagline: 'Sends new contacts to your spreadsheet',
  description: 'Keeps a sheet up to date.\nEvery new contact is a row.',
  developer: 'Northwind Labs',
  websiteUrl: 'https://zapsync.example',
  supportEmail: 'help@zapsync.example',
  iconUrl: null,
  categories: ['productivity'],
  scopes: ['contacts.manage', 'tags.manage'],
  readGroups: ['Contacts', 'Tags'],
  webhookEvents: [],
  status: 'listed',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
  install: null,
  missingScopes: [],
  canInstall: true,
  ...patch,
});
const installOf = (installedBy: string | null = 'Dana Brooks') => ({
  id: installId,
  appId,
  grantedScopes: ['contacts.manage', 'tags.manage'],
  grantedReadGroups: ['Contacts', 'Tags'],
  installedBy,
  installedAt: '2026-10-03T09:00:00.000Z',
});

interface Call {
  readonly method: string;
  readonly path: string;
  readonly business: string | null;
}
let calls: Call[];
let app: MarketplaceAppDetail;
let failure: { readonly method: string; readonly status: number; readonly detail?: string } | null;
beforeEach(() => {
  calls = [];
  app = detailOf();
  failure = null;
});

function open() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const fetch: typeof globalThis.fetch = (input, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://crm.test',
    ).pathname;
    calls.push({ method, path, business: new Headers(init?.headers).get('business-id') });
    if (failure !== null && failure.method === method) {
      const { status, detail } = failure;
      return Promise.resolve(
        Response.json(
          {
            type: 'about:blank',
            title: 'Refused',
            status,
            ...(detail === undefined ? {} : { detail }),
          },
          { status },
        ),
      );
    }
    if (method === 'POST') {
      app = { ...app, install: installOf() };
      return Promise.resolve(Response.json(installOf(), { status: 201 }));
    }
    if (method === 'DELETE') {
      app = { ...app, install: null };
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(Response.json(app));
  };
  const client = createClient({ baseUrl: '/api/v1', fetch, business: () => 'biz_test' });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        <MarketplaceAppPage client={client} businessId="biz_test" slug="harbor" appId={appId} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup() };
}

const sent = (method: string) => calls.filter((call) => call.method === method);
const section = (name: string) => screen.getByRole('region', { name });

describe('reading an app', () => {
  it('shows its overview and the permissions it asks for, in people’s words', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Zap Sync' });
    expect(screen.getByRole('link', { name: 'App Marketplace' }).getAttribute('href')).toBe(
      '/b/harbor/app-marketplace',
    );
    const overview = section('Overview');
    expect(within(overview).getByText(/Every new contact is a row\./)).toBeDefined();
    expect(within(overview).getByText('Northwind Labs')).toBeDefined();
    expect(
      within(overview).getByRole('link', { name: 'https://zapsync.example' }).getAttribute('href'),
    ).toBe('https://zapsync.example');
    expect(
      within(overview).getByRole('link', { name: 'help@zapsync.example' }).getAttribute('href'),
    ).toBe('mailto:help@zapsync.example');
    expect(within(overview).getByText('Productivity')).toBeDefined();
    const permissions = section('Permissions');
    expect(
      within(permissions)
        .getAllByRole('listitem')
        .map((each) => each.textContent),
    ).toEqual(['Add, change and trash contacts', 'Manage tags', 'Contacts', 'Tags']);
    expect(within(permissions).getByText('It may read:')).toBeDefined();
    expect(screen.getByText(/connects through the link its developer gives you/)).toBeDefined();
    expect(calls[0]).toEqual({
      method: 'GET',
      path: `/api/v1/marketplace/apps/${appId}`,
      business: 'biz_test',
    });
  });

  it('says what it does not have: a description, a website, an email, categories, permissions', async () => {
    app = detailOf({
      description: '',
      websiteUrl: null,
      supportEmail: null,
      categories: [],
      scopes: [],
    });
    open();
    await screen.findByRole('heading', { level: 1, name: 'Zap Sync' });
    const overview = section('Overview');
    expect(within(overview).getByText('No description.')).toBeDefined();
    expect(within(overview).getAllByText('None')).toHaveLength(3);
    expect(within(section('Permissions')).getByText('It asks for no permissions.')).toBeDefined();
  });

  it('says when the app is not available here', async () => {
    failure = { method: 'GET', status: 404 };
    open();
    await screen.findByRole('heading', { level: 1, name: 'App not found' });
    expect(screen.getByText('This app isn’t listed for this business.')).toBeDefined();
  });

  it('says when the app did not load, and tries again', async () => {
    failure = { method: 'GET', status: 403 };
    const { user } = open();
    await screen.findByText('The app couldn’t be loaded.');
    failure = null;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { level: 1, name: 'Zap Sync' });
  });
});

describe('installing', () => {
  it('asks for consent, installs on Allow & Install, and then offers Uninstall', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Install App' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Zap Sync?' });
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((each) => each.textContent),
    ).toEqual(['Add, change and trash contacts', 'Manage tags', 'Contacts', 'Tags']);
    expect(within(dialog).getByText('Uninstalling it later disconnects it at once.')).toBeDefined();
    expect(sent('POST')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Allow & Install' }));
    await screen.findByRole('button', { name: 'Uninstall' });
    expect(sent('POST')).toEqual([
      {
        method: 'POST',
        path: `/api/v1/marketplace/apps/${appId}/install`,
        business: 'biz_test',
      },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Zap Sync is installed.');
    const installed = section('Installed');
    expect(within(installed).getByText(/^Installed by Dana Brooks on Oct 3, 2026/)).toBeDefined();
    expect(
      within(installed)
        .getAllByRole('listitem')
        .map((each) => each.textContent),
    ).toEqual(['Add, change and trash contacts', 'Manage tags', 'Contacts', 'Tags']);
    expect(screen.getByText('Installed', { selector: 'span' })).toBeDefined();
  });

  it('closes the review without installing', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Install App' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Zap Sync?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(sent('POST')).toHaveLength(0);
  });

  it('says why an install was refused, in the server’s words', async () => {
    failure = { method: 'POST', status: 409, detail: 'Zap Sync is already installed here.' };
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Install App' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Zap Sync?' });
    await user.click(within(dialog).getByRole('button', { name: 'Allow & Install' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Zap Sync is already installed here.',
    );
  });

  it('says an install failed when the server gives no reason', async () => {
    failure = { method: 'POST', status: 502 };
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Install App' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Zap Sync?' });
    await user.click(within(dialog).getByRole('button', { name: 'Allow & Install' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'The app wasn’t installed. Check your connection and try again.',
    );
  });

  it('refuses an install that asks for what the person lacks, and names it', async () => {
    app = detailOf({ missingScopes: ['tags.manage'] });
    const { user } = open();
    const install = await screen.findByRole('button', { name: 'Install App' });
    expect(install).toHaveProperty('disabled', true);
    const why = screen.getByText(/You can’t install this app/);
    expect(install.getAttribute('aria-describedby')).toBe(why.closest('[id]')?.id);
    const explanation = document.getElementById(install.getAttribute('aria-describedby') ?? '');
    if (explanation === null) throw new Error('No explanation');
    expect(within(explanation).getByRole('list').textContent).toBe('Manage tags');
    await user.click(install);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sent('POST')).toHaveLength(0);
  });

  it('offers nothing to press to someone who may not install apps', async () => {
    app = detailOf({ canInstall: false });
    open();
    await screen.findByText(/Only people who can manage apps and API keys/);
    expect(screen.queryByRole('button', { name: 'Install App' })).toBeNull();
  });

  it('offers no install of an app that is no longer listed', async () => {
    app = detailOf({ status: 'delisted' });
    open();
    await screen.findByText('This app is no longer listed, so it can’t be installed.');
    expect(screen.queryByRole('button', { name: 'Install App' })).toBeNull();
  });
});

describe('uninstalling', () => {
  it('asks first, then uninstalls and offers Install App again', async () => {
    app = detailOf({ install: installOf(null), status: 'delisted' });
    const { user } = open();
    await screen.findByText(/^Installed on Oct 3, 2026/);
    await user.click(screen.getByRole('button', { name: 'Uninstall' }));
    let dialog = await screen.findByRole('dialog', { name: 'Uninstall Zap Sync?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(sent('DELETE')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Uninstall' }));
    dialog = await screen.findByRole('dialog', { name: 'Uninstall Zap Sync?' });
    await user.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
    await screen.findByText('This app is no longer listed, so it can’t be installed.');
    expect(sent('DELETE')).toEqual([
      { method: 'DELETE', path: `/api/v1/marketplace/installs/${installId}`, business: 'biz_test' },
    ]);
    expect(screen.getByRole('status').textContent).toBe('Zap Sync is uninstalled.');
    expect(screen.queryByRole('region', { name: 'Installed' })).toBeNull();
  });

  it('says when an uninstall failed', async () => {
    app = detailOf({ install: installOf() });
    failure = { method: 'DELETE', status: 502 };
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Uninstall' }));
    const dialog = await screen.findByRole('dialog', { name: 'Uninstall Zap Sync?' });
    await user.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'The app wasn’t uninstalled. Check your connection and try again.',
    );
  });

  it('shows an install to someone who may not uninstall it, with nothing to press', async () => {
    app = detailOf({ install: installOf(), canInstall: false });
    open();
    await screen.findByText(/^Installed by Dana Brooks/);
    expect(screen.queryByRole('button', { name: 'Uninstall' })).toBeNull();
  });
});
