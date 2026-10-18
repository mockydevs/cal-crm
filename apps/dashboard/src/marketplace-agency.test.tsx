// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  createMarketplaceAppInput,
  updateMarketplaceAppInput,
  type AgencyMarketplaceApp,
  type MarketplaceDelivery,
} from '@repo/contracts';
import { createClient } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgencyMarketplaceAppsPage } from './marketplace-agency';

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

configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 30000 });
beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

const zapId = 'mapp_01k8e2wzr0e008000000000001';
const appOf = (patch: Partial<AgencyMarketplaceApp> = {}): AgencyMarketplaceApp => ({
  id: zapId,
  name: 'Zap Sync',
  tagline: 'Sends new contacts to your spreadsheet',
  description: 'Keeps a sheet up to date.',
  developer: 'Northwind Labs',
  websiteUrl: 'https://zapsync.example',
  supportEmail: null,
  iconUrl: null,
  categories: ['productivity'],
  scopes: ['contacts.manage'],
  readGroups: ['Contacts'],
  status: 'draft',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
  installCount: 0,
  redirectUris: ['https://zapsync.example/oauth/callback'],
  clientSecretPrefix: null,
  clientSecretSetAt: null,
  webhookUrl: null,
  webhookEvents: [],
  webhookSecretSetAt: null,
  ...patch,
});

interface Call {
  readonly method: string;
  readonly path: string;
  readonly business: string | null;
  readonly body: unknown;
}
let calls: Call[];
let apps: AgencyMarketplaceApp[];
let deliveries: MarketplaceDelivery[];
let refusal: { readonly method: string; readonly status: number; readonly body: object } | null;
beforeEach(() => {
  calls = [];
  apps = [appOf()];
  deliveries = [];
  refusal = null;
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
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, business: new Headers(init?.headers).get('business-id'), body });
    if (refusal !== null && refusal.method === method)
      return Promise.resolve(Response.json(refusal.body, { status: refusal.status }));
    if (method === 'POST' && path.endsWith('/webhook-secret')) {
      apps = apps.map((each) =>
        each.id === zapId ? { ...each, webhookSecretSetAt: '2026-10-07T09:00:00.000Z' } : each,
      );
      return Promise.resolve(
        Response.json(
          { secret: `whsec_${'w'.repeat(43)}`, setAt: '2026-10-07T09:00:00.000Z' },
          { status: 201 },
        ),
      );
    }
    if (method === 'GET' && path.endsWith('/deliveries'))
      return Promise.resolve(Response.json({ items: deliveries }));
    if (method === 'POST' && path.endsWith('/redeliver')) {
      deliveries = deliveries.map((each) =>
        path.includes(each.id) ? { ...each, status: 'pending', attempts: 0 } : each,
      );
      return Promise.resolve(Response.json(deliveries[0]));
    }
    if (method === 'POST' && path.endsWith('/client-secret')) {
      const secret = {
        clientId: zapId,
        clientSecret: `crm_cs_${'1'.repeat(64)}`,
        clientSecretPrefix: 'crm_cs_11111111',
        clientSecretSetAt: '2026-10-06T09:00:00.000Z',
      };
      apps = apps.map((each) =>
        each.id === zapId
          ? {
              ...each,
              clientSecretPrefix: secret.clientSecretPrefix,
              clientSecretSetAt: secret.clientSecretSetAt,
            }
          : each,
      );
      return Promise.resolve(Response.json(secret, { status: 201 }));
    }
    if (method === 'POST') {
      const made = appOf({
        ...createMarketplaceAppInput.parse(body),
        id: 'mapp_01k8e2wzr0e008000000000002',
      });
      apps = [...apps, made];
      return Promise.resolve(Response.json(made, { status: 201 }));
    }
    if (method === 'PUT') {
      const saved = appOf({
        ...updateMarketplaceAppInput.parse(body),
        updatedAt: '2026-10-05T09:00:00.000Z',
      });
      apps = apps.map((each) => (path.endsWith(each.id) ? { ...saved, id: each.id } : each));
      return Promise.resolve(Response.json(saved));
    }
    return Promise.resolve(Response.json({ items: apps }));
  };
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        <AgencyMarketplaceAppsPage
          client={createClient({ baseUrl: '/api/v1', fetch })}
          agencyId="agency-a"
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup() };
}

const sent = (method: string) => calls.filter((call) => call.method === method);
const rowOf = (name: string) => {
  const row = screen.getByRole('cell', { name }).closest('tr');
  if (row === null) throw new Error(`No row for ${name}`);
  return within(row);
};

describe('the list', () => {
  it('shows each app with its status, installs and last change', async () => {
    apps = [
      appOf(),
      appOf({
        id: 'mapp_01k8e2wzr0e008000000000003',
        name: 'Dial Pad',
        status: 'listed',
        installCount: 3,
      }),
    ];
    open();
    expect(screen.getByRole('heading', { level: 1, name: 'Marketplace apps' })).toBeDefined();
    await screen.findByRole('cell', { name: 'Zap Sync' });
    expect(screen.getAllByRole('columnheader').map((each) => each.textContent)).toEqual([
      'Name',
      'Status',
      'Installs',
      'Updated',
      'Actions',
    ]);
    expect(rowOf('Zap Sync').getByText('Draft')).toBeDefined();
    expect(rowOf('Zap Sync').getByText('Oct 2, 2026')).toBeDefined();
    expect(rowOf('Dial Pad').getByText('Listed')).toBeDefined();
    expect(rowOf('Dial Pad').getByText('3')).toBeDefined();
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/api/v1/agency/marketplace/apps',
      business: null,
    });
  });

  it('says when there are no apps', async () => {
    apps = [];
    open();
    await screen.findByRole('heading', { level: 2, name: 'No apps yet' });
  });

  it('says when the list did not load, in the server’s words, and tries again', async () => {
    refusal = {
      method: 'GET',
      status: 403,
      body: { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'You may not.' },
    };
    const { user } = open();
    await screen.findByText('You may not.');
    expect(screen.queryByRole('button', { name: 'Add app' })).toBeNull();
    refusal = null;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('cell', { name: 'Zap Sync' });
  });
});

describe('adding an app', () => {
  it('adds a draft with what the form says', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Add app' }));
    const form = within(screen.getByRole('region', { name: 'Add app' }));
    await user.type(form.getByLabelText('Name'), 'Dial Pad');
    await user.type(form.getByLabelText('Tagline'), 'Calls from your browser');
    await user.type(form.getByLabelText('Description'), 'Places calls.');
    await user.type(form.getByLabelText('Developer'), 'Lakeside Software');
    await user.type(form.getByLabelText('Website'), 'https://dialpad.example');
    await user.type(form.getByLabelText('Support email'), 'help@dialpad.example');
    await user.type(form.getByLabelText('Icon URL'), 'https://dialpad.example/icon.png');
    await user.click(form.getByRole('checkbox', { name: 'Communication' }));
    await user.click(form.getByRole('checkbox', { name: 'Read call history' }));
    await user.click(form.getByRole('checkbox', { name: 'Manage tags' }));
    await user.click(form.getByRole('checkbox', { name: 'Manage tags' }));
    await user.click(form.getByRole('button', { name: 'Add app' }));
    await screen.findByRole('cell', { name: 'Dial Pad' });
    expect(sent('POST')).toEqual([
      {
        method: 'POST',
        path: '/api/v1/agency/marketplace/apps',
        business: null,
        body: {
          name: 'Dial Pad',
          tagline: 'Calls from your browser',
          description: 'Places calls.',
          developer: 'Lakeside Software',
          websiteUrl: 'https://dialpad.example',
          supportEmail: 'help@dialpad.example',
          iconUrl: 'https://dialpad.example/icon.png',
          categories: ['communication'],
          scopes: ['calls.read'],
          readGroups: [],
          redirectUris: [],
          webhookUrl: null,
          webhookEvents: [],
        },
      },
    ]);
    expect(screen.queryByRole('region', { name: 'Add app' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(
      'Dial Pad is added as a draft. List it when businesses should see it.',
    );
  });

  it('offers only the permissions an app may ask for', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Add app' }));
    const permissions = within(screen.getByRole('group', { name: 'Permissions it asks for' }));
    expect(permissions.getByRole('checkbox', { name: 'Manage tags' })).toBeDefined();
    expect(permissions.queryByRole('checkbox', { name: 'Manage apps and API keys' })).toBeNull();
    expect(
      permissions.getByRole('checkbox', { name: 'Invite and remove team members' }),
    ).toBeDefined();
    expect(permissions.queryByRole('checkbox', { name: 'Create businesses' })).toBeNull();
  });

  it('says what is wrong under each field, in the API’s words, before sending', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Add app' }));
    const form = within(screen.getByRole('region', { name: 'Add app' }));
    await user.type(form.getByLabelText('Website'), 'http://plain.example');
    for (const category of [
      'Analytics',
      'Calendars',
      'Communication',
      'Marketing',
      'Payments',
      'Sales',
    ])
      await user.click(
        within(form.getByRole('group', { name: 'Categories' })).getByRole('checkbox', {
          name: category,
        }),
      );
    await user.click(form.getByRole('button', { name: 'Add app' }));
    await form.findByText('Give the app a name.');
    expect(form.getByText('Say who makes the app.')).toBeDefined();
    expect(form.getByText('Use an address that starts with https://.')).toBeDefined();
    expect(form.getByRole('group', { name: 'Categories' }).getAttribute('aria-describedby')).toBe(
      form.getByText('Choose at most 5 categories.').id,
    );
    expect(sent('POST')).toHaveLength(0);
    await user.click(form.getByRole('checkbox', { name: 'Sales' }));
    expect(form.queryByText('Choose at most 5 categories.')).toBeNull();
  });

  it('shows the server’s refusal under its field, and its other reasons above the buttons', async () => {
    refusal = {
      method: 'POST',
      status: 422,
      body: {
        type: 'about:blank',
        title: 'Unprocessable Content',
        status: 422,
        errors: [
          {
            path: '/scopes',
            code: 'not_allowed',
            message: 'An app can ask only for what an API key may hold.',
          },
          { path: '', code: 'other', message: 'The agency has too many apps.' },
        ],
      },
    };
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Add app' }));
    const form = within(screen.getByRole('region', { name: 'Add app' }));
    await user.type(form.getByLabelText('Name'), 'Dial Pad');
    await user.type(form.getByLabelText('Developer'), 'Lakeside Software');
    await user.click(form.getByRole('button', { name: 'Add app' }));
    await form.findByText('An app can ask only for what an API key may hold.');
    expect(form.getByRole('alert').textContent).toBe('The agency has too many apps.');
    expect(form.getByLabelText('Name')).toHaveProperty('value', 'Dial Pad');
  });

  it('says when saving failed without a reason', async () => {
    refusal = { method: 'POST', status: 502, body: {} };
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Add app' }));
    const form = within(screen.getByRole('region', { name: 'Add app' }));
    await user.type(form.getByLabelText('Name'), 'Dial Pad');
    await user.type(form.getByLabelText('Developer'), 'Lakeside Software');
    await user.click(form.getByRole('button', { name: 'Add app' }));
    expect((await form.findByRole('alert')).textContent).toBe(
      'The app wasn’t saved. Check your connection and try again.',
    );
  });

  it('closes the form on Cancel without sending', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Add app' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Add app' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add app' }));
    expect(sent('POST')).toHaveLength(0);
  });
});

describe('changing an app', () => {
  it('edits the whole app and keeps its status', async () => {
    apps = [appOf({ status: 'listed', supportEmail: 'help@zapsync.example' })];
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Edit Zap Sync' }));
    const form = within(screen.getByRole('region', { name: 'Edit Zap Sync' }));
    expect(form.getByLabelText('Name')).toHaveProperty('value', 'Zap Sync');
    expect(form.getByRole('checkbox', { name: 'Productivity' })).toHaveProperty('checked', true);
    expect(form.getByRole('checkbox', { name: 'Add, change and trash contacts' })).toHaveProperty(
      'checked',
      true,
    );
    await user.clear(form.getByLabelText('Tagline'));
    await user.type(form.getByLabelText('Tagline'), 'Your sheet, always current');
    await user.clear(form.getByLabelText('Support email'));
    await user.click(form.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Edit Zap Sync' })).toBeNull();
    });
    expect(sent('PUT')).toEqual([
      {
        method: 'PUT',
        path: `/api/v1/agency/marketplace/apps/${zapId}`,
        business: null,
        body: {
          name: 'Zap Sync',
          tagline: 'Your sheet, always current',
          description: 'Keeps a sheet up to date.',
          developer: 'Northwind Labs',
          websiteUrl: 'https://zapsync.example',
          supportEmail: null,
          iconUrl: null,
          categories: ['productivity'],
          scopes: ['contacts.manage'],
          readGroups: ['Contacts'],
          redirectUris: ['https://zapsync.example/oauth/callback'],
          webhookUrl: null,
          webhookEvents: [],
          status: 'listed',
        },
      },
    ]);
    expect(screen.getByRole('status').textContent).toBe('Zap Sync is saved.');
  });

  it('lists, delists and returns an app to draft', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'List Zap Sync' }));
    await screen.findByText('Zap Sync is listed. Every business in your agency can install it.');
    expect(rowOf('Zap Sync').getByText('Listed')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Delist Zap Sync' }));
    await screen.findByText(
      'Zap Sync is delisted. No new installs; businesses that have it keep it until they uninstall it.',
    );
    await user.click(screen.getByRole('button', { name: 'Move Zap Sync back to draft' }));
    await screen.findByText('Zap Sync is a draft again. Only your agency sees it.');
    expect(sent('PUT').map((call) => (call.body as { status: string }).status)).toEqual([
      'listed',
      'delisted',
      'draft',
    ]);
  });

  it('says when a status change failed', async () => {
    refusal = {
      method: 'PUT',
      status: 409,
      body: { type: 'about:blank', title: 'Conflict', status: 409, detail: 'Changed elsewhere.' },
    };
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'List Zap Sync' }));
    await screen.findByText('Changed elsewhere.');
  });

  it('refuses a status change the API would refuse, without sending it', async () => {
    apps = [appOf({ scopes: ['apps.manage'] })];
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'List Zap Sync' }));
    await screen.findByText('An app can ask only for what an API key may hold.');
    expect(sent('PUT')).toHaveLength(0);
  });
});

describe('what an app reads and where it is sent back', () => {
  it('sends the groups ticked and one redirect address a line', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Edit Zap Sync' }));
    const form = within(screen.getByRole('region', { name: 'Edit Zap Sync' }));
    const reads = within(form.getByRole('group', { name: 'What it may read' }));
    expect(reads.getByRole('checkbox', { name: 'Contacts' })).toHaveProperty('checked', true);
    expect(reads.queryByRole('checkbox', { name: 'Audit log' })).toBeNull();
    await user.click(reads.getByRole('checkbox', { name: 'Tags' }));
    const redirects = form.getByLabelText('Redirect addresses');
    await user.clear(redirects);
    await user.type(redirects, 'https://zapsync.example/a{Enter}{Enter}http://localhost:3000/b');
    await user.click(form.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Zap Sync is saved.');
    expect(sent('PUT')[0]?.body).toMatchObject({
      readGroups: ['Contacts', 'Tags'],
      redirectUris: ['https://zapsync.example/a', 'http://localhost:3000/b'],
    });
  });

  it('says what is wrong with a redirect address, in the API’s words', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Edit Zap Sync' }));
    const form = within(screen.getByRole('region', { name: 'Edit Zap Sync' }));
    const redirects = form.getByLabelText('Redirect addresses');
    await user.clear(redirects);
    await user.type(redirects, 'http://zapsync.example/cb');
    await user.click(form.getByRole('button', { name: 'Save changes' }));
    await form.findByText(
      'Use an https:// address without a # part, or http://localhost for testing on your computer.',
    );
    expect(sent('PUT')).toEqual([]);
  });
});

describe('connecting an app', () => {
  it('shows the client id, generates the secret once, and gives the authorization address', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Connection for Zap Sync' }));
    const panel = within(screen.getByRole('region', { name: 'Connect Zap Sync' }));
    expect(panel.getByLabelText('Client ID')).toHaveProperty('value', zapId);
    expect(panel.getByText('None yet. The app can’t connect until it has one.')).toBeDefined();
    expect(panel.getByLabelText('Send people here to connect')).toHaveProperty(
      'value',
      `${window.location.origin}/oauth/authorize?response_type=code&client_id=${zapId}&redirect_uri=https%3A%2F%2Fzapsync.example%2Foauth%2Fcallback&state={state}&code_challenge={S256 challenge}&code_challenge_method=S256`,
    );

    await user.click(panel.getByRole('button', { name: 'Generate client secret' }));
    expect(await panel.findByLabelText('New client secret')).toHaveProperty(
      'value',
      `crm_cs_${'1'.repeat(64)}`,
    );
    expect(panel.getByText('Copy it now: you won’t see it again.')).toBeDefined();
    expect(sent('POST')).toEqual([
      {
        method: 'POST',
        path: `/api/v1/agency/marketplace/apps/${zapId}/client-secret`,
        business: null,
        body: undefined,
      },
    ]);
    await user.click(panel.getByRole('button', { name: 'Copy New client secret' }));
    expect(await panel.findByText('Copied.')).toBeDefined();
    expect(panel.getByRole('button', { name: 'Replace client secret' })).toBeDefined();
    expect(
      panel.getByText('Replacing it stops the old one at once. Businesses stay connected.'),
    ).toBeDefined();

    await user.click(panel.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('region', { name: 'Connect Zap Sync' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Connection for Zap Sync' }));
    const again = within(screen.getByRole('region', { name: 'Connect Zap Sync' }));
    expect(again.getByText(/Starts with/).textContent).toBe(
      'Starts with crm_cs_11111111, generated Oct 6, 2026.',
    );
    expect(again.queryByLabelText('New client secret')).toBeNull();
  });

  it('asks for a redirect address first, and says when the secret wasn’t generated', async () => {
    apps = [appOf({ redirectUris: [] })];
    refusal = {
      method: 'POST',
      status: 403,
      body: {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Only a person can publish an app.',
      },
    };
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Connection for Zap Sync' }));
    const panel = within(screen.getByRole('region', { name: 'Connect Zap Sync' }));
    expect(panel.getByText('Add a redirect address with Edit first.')).toBeDefined();
    await user.click(panel.getByRole('button', { name: 'Generate client secret' }));
    expect((await panel.findByRole('alert')).textContent).toBe('Only a person can publish an app.');
  });
});

describe('the app’s webhook', () => {
  const deliveryOf = (patch: Partial<MarketplaceDelivery> = {}): MarketplaceDelivery => ({
    id: 'mdlv_01k8e2wzr0e008000000000001',
    eventType: 'contact.created',
    business: { id: 'biz_01k8e2wzr0e008000000000001', name: 'Harbor Lights Events' },
    status: 'failed',
    attempts: 6,
    lastStatus: 500,
    lastError: 'Internal Server Error',
    lastAttemptAt: '2026-10-07T10:00:00.000Z',
    nextAttemptAt: null,
    deliveredAt: null,
    createdAt: '2026-10-07T09:00:00.000Z',
    ...patch,
  });

  it('sends the address and the events chosen, and shows the server’s word on an event', async () => {
    refusal = {
      method: 'PUT',
      status: 422,
      body: {
        type: 'about:blank',
        title: 'Unprocessable Content',
        status: 422,
        errors: [
          {
            path: '/webhookEvents',
            code: 'unreadable',
            message: 'To send deal.won, let the app read Deals.',
          },
        ],
      },
    };
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Edit Zap Sync' }));
    const form = within(screen.getByRole('region', { name: 'Edit Zap Sync' }));
    await user.type(form.getByLabelText('Webhook address'), 'https://zapsync.example/hooks');
    const events = within(form.getByRole('group', { name: 'Events it is told of' }));
    await user.click(events.getByRole('checkbox', { name: 'A contact is created' }));
    await user.click(events.getByRole('checkbox', { name: 'An opportunity is won' }));
    await user.click(form.getByRole('button', { name: 'Save changes' }));
    expect(await form.findByText('To send deal.won, let the app read Deals.')).toBeDefined();
    expect(sent('PUT')[0]?.body).toMatchObject({
      webhookUrl: 'https://zapsync.example/hooks',
      webhookEvents: ['contact.created', 'deal.won'],
    });
  });

  it('asks for an address first', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Connection for Zap Sync' }));
    const panel = within(screen.getByRole('region', { name: 'Connect Zap Sync' }));
    expect(
      panel.getByText('No webhook address. Add one with Edit to tell the app of events.'),
    ).toBeDefined();
    expect(sent('GET').some((call) => call.path.endsWith('/deliveries'))).toBe(false);
  });

  it('generates the secret once, lists the deliveries, and sends one again', async () => {
    apps = [appOf({ webhookUrl: 'https://zapsync.example/hooks' })];
    deliveries = [deliveryOf()];
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Connection for Zap Sync' }));
    const panel = within(screen.getByRole('region', { name: 'Connect Zap Sync' }));
    expect(
      panel.getByText('No webhook secret yet. Nothing is sent until there is one.'),
    ).toBeDefined();
    await user.click(panel.getByRole('button', { name: 'Generate webhook secret' }));
    expect(await panel.findByLabelText('New webhook secret')).toHaveProperty(
      'value',
      `whsec_${'w'.repeat(43)}`,
    );
    expect(panel.getByRole('button', { name: 'Replace webhook secret' })).toBeDefined();

    const table = within(await panel.findByRole('table', { name: 'Latest deliveries' }));
    expect(
      table
        .getAllByRole('cell')
        .slice(1, 5)
        .map((each) => each.textContent),
    ).toEqual(['A contact is created', 'Harbor Lights Events', 'Failed', '500']);
    await user.click(
      table.getByRole('button', {
        name: 'Send A contact is created to Harbor Lights Events again',
      }),
    );
    expect(await panel.findByText('It will be sent again in a moment.')).toBeDefined();
    expect(sent('POST').at(-1)?.path).toBe(
      '/api/v1/agency/marketplace/deliveries/mdlv_01k8e2wzr0e008000000000001/redeliver',
    );
    expect(await table.findByText('Waiting')).toBeDefined();
    expect(table.queryByRole('button', { name: /Send .* again/ })).toBeNull();
  });

  it('says when nothing was sent yet, and why the last attempt failed', async () => {
    apps = [
      appOf({
        webhookUrl: 'https://zapsync.example/hooks',
        webhookSecretSetAt: '2026-10-07T09:00:00.000Z',
      }),
    ];
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Connection for Zap Sync' }));
    const panel = within(screen.getByRole('region', { name: 'Connect Zap Sync' }));
    expect(panel.getByText('The webhook secret was generated Oct 7, 2026.')).toBeDefined();
    expect(await panel.findByText('Nothing sent yet.')).toBeDefined();
    cleanup();
    deliveries = [deliveryOf({ lastStatus: null, lastError: 'The app has no webhook address.' })];
    const second = open();
    await second.user.click(await screen.findByRole('button', { name: 'Connection for Zap Sync' }));
    expect(await screen.findByText('The app has no webhook address.')).toBeDefined();
  });
});
