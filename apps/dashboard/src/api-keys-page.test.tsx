// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { createApiKeyInput, type ApiKey, type CreateApiKeyInput } from '@repo/contracts';
import { createClient } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { ApiKeysPage, type KeysWorkspace } from './api-keys-page';

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

const key: ApiKey = {
  id: 'key_01m4bd9fteedat3be9bqgx2044',
  name: 'Sourcepoint',
  prefix: 'crm_live_123456789abc',
  scopes: ['contacts.manage'],
  createdAt: '2026-10-01T09:00:00.000Z',
  createdBy: 'Dana',
  lastUsedAt: null,
};
const rawKey = `crm_live_${'a'.repeat(64)}`;
const agency: KeysWorkspace = { scope: 'agency', id: 'agency-a' };
const business: KeysWorkspace = { scope: 'business', id: 'business-a' };
interface Call {
  method: string;
  business: string | null;
  body: unknown;
  url: string;
}
let calls: Call[];
let scopes: string[];
let groups: string[] | undefined;
let items: ApiKey[];
let canManage: boolean;
let failure: 'create' | 'revoke' | 'list' | undefined;
let delayedCreate: Promise<Response> | undefined;
beforeEach(() => {
  calls = [];
  scopes = ['contacts.manage', 'reports.view'];
  groups = ['Contacts', 'Reports'];
  items = [];
  canManage = true;
  failure = undefined;
  delayedCreate = undefined;
});

function open(workspace = business) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const fetch: typeof globalThis.fetch = (url, init) => {
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({
      method,
      business: headers.get('Business-Id'),
      body,
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
    });
    if (
      (method === 'POST' && failure === 'create') ||
      (method === 'DELETE' && failure === 'revoke') ||
      (method === 'GET' && failure === 'list')
    )
      return Promise.resolve(
        Response.json(
          {
            type: 'about:blank',
            title: 'Validation failed',
            status: 422,
            errors: [
              { path: '/expiresAt', code: 'future_required', message: 'Choose a later expiry.' },
            ],
          },
          { status: 422 },
        ),
      );
    if (method === 'POST')
      return (
        delayedCreate ??
        Promise.resolve(
          Response.json({ ...key, ...bodyAsInput(body), key: rawKey }, { status: 201 }),
        )
      );
    if (method === 'DELETE') {
      items = [];
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(
      Response.json({
        items,
        canManage,
        scopes,
        ...(groups === undefined ? {} : { readGroups: groups }),
      }),
    );
  };
  const view = (place: KeysWorkspace) => (
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        <ApiKeysPage
          client={createClient({
            baseUrl: '/api/v1',
            fetch,
            ...(place.scope === 'business' ? { business: () => place.id } : {}),
          })}
          workspace={place}
        />
      </I18nProvider>
    </QueryClientProvider>
  );
  const rendered = render(view(workspace));
  return {
    user: userEvent.setup(),
    queryClient,
    switchTo: (place: KeysWorkspace) => {
      rendered.rerender(view(place));
    },
  };
}
function bodyAsInput(body: unknown): CreateApiKeyInput {
  return createApiKeyInput.parse(body);
}
const creates = () => calls.filter((call) => call.method === 'POST');
async function start(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New API key' }));
  await user.type(screen.getByLabelText('Name'), 'Sourcepoint');
}

it.each([business, agency])(
  'creates a Contacts-only read-only key in $scope without delegating unrequested protected grants',
  async (place) => {
    const { user } = open(place);
    await start(user);
    await user.click(screen.getByRole('checkbox', { name: 'Contacts' }));
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    await screen.findByRole('heading', { name: 'Your new key' });
    expect(creates()).toHaveLength(1);
    expect(creates()[0]?.business).toBe(place.scope === 'business' ? 'business-a' : null);
    expect(creates()[0]?.body).toEqual({
      name: 'Sourcepoint',
      scopes: [],
      readOnly: true,
      readGroups: ['Contacts'],
    });
  },
);

it.each([
  ['payments.read', 'View payment data'],
  ['reports.view', 'View reports'],
])('delegates only the explicitly selected protected read grant %s', async (scope, label) => {
  scopes = ['contacts.manage', 'payments.read', 'reports.view'];
  const { user } = open();
  await start(user);
  expect(screen.getByRole('group', { name: 'Protected read permissions' })).toBeDefined();
  expect(screen.getByRole('checkbox', { name: 'View payment data' })).toHaveProperty(
    'checked',
    false,
  );
  expect(screen.getByRole('checkbox', { name: 'View reports' })).toHaveProperty('checked', false);
  expect(screen.queryByText('payments.read')).toBeNull();
  expect(screen.queryByText('reports.view')).toBeNull();
  await user.click(screen.getByRole('checkbox', { name: 'Contacts' }));
  await user.click(screen.getByRole('checkbox', { name: label }));
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByRole('heading', { name: 'Your new key' });
  expect(creates()[0]?.body).toEqual({
    name: 'Sourcepoint',
    scopes: [scope],
    readOnly: true,
    readGroups: ['Contacts'],
  });
});

it('offers no protected permission the caller does not hold', async () => {
  scopes = ['contacts.manage'];
  const { user } = open();
  await start(user);
  expect(screen.queryByRole('checkbox', { name: 'View payment data' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'View reports' })).toBeNull();
  await user.click(screen.getByRole('checkbox', { name: 'Contacts' }));
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByRole('heading', { name: 'Your new key' });
  expect(bodyAsInput(creates()[0]?.body).scopes).toEqual([]);
});

it('never carries a custom writer choice into a read-only key', async () => {
  const { user } = open();
  await start(user);
  await user.click(screen.getByRole('radio', { name: 'Custom access' }));
  await user.click(screen.getByRole('checkbox', { name: 'Contacts' }));
  await user.click(screen.getByRole('checkbox', { name: 'Add, change and trash contacts' }));
  await user.click(screen.getByRole('radio', { name: 'Read-only' }));
  expect(screen.getByRole('checkbox', { name: 'View reports' })).toHaveProperty('checked', false);
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByRole('heading', { name: 'Your new key' });
  expect(creates()[0]?.body).toEqual({
    name: 'Sourcepoint',
    scopes: [],
    readOnly: true,
    readGroups: ['Contacts'],
  });
});

it('retains an explicit protected choice after a field error and resets it on context switch', async () => {
  failure = 'create';
  const { user, switchTo } = open();
  await start(user);
  await user.click(screen.getByRole('checkbox', { name: 'Contacts' }));
  await user.click(screen.getByRole('checkbox', { name: 'View reports' }));
  fireEvent.change(screen.getByLabelText('Expiry (optional)'), {
    target: { value: '2099-05-06T12:34' },
  });
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByText('Choose a later expiry.');
  expect(screen.getByRole('checkbox', { name: 'View reports' })).toHaveProperty('checked', true);
  expect(screen.getByRole('checkbox', { name: 'Contacts' })).toHaveProperty('checked', true);
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Sourcepoint');
  expect(screen.getByLabelText('Expiry (optional)')).toHaveProperty('value', '2099-05-06T12:34');
  switchTo(agency);
  await user.click(await screen.findByRole('button', { name: 'New API key' }));
  expect(screen.getByRole('checkbox', { name: 'View reports' })).toHaveProperty('checked', false);
});

it('keeps full access explicitly all held, including protected reads and only returned groups', async () => {
  scopes = ['contacts.manage', 'payments.read', 'reports.view'];
  groups = ['Contacts', 'Lead sources'];
  const { user } = open();
  await start(user);
  await user.click(screen.getByRole('radio', { name: 'Full permitted access' }));
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByRole('heading', { name: 'Your new key' });
  expect(creates()[0]?.body).toEqual({
    name: 'Sourcepoint',
    scopes: ['contacts.manage', 'payments.read', 'reports.view'],
    readOnly: false,
    readGroups: ['Contacts', 'Lead sources'],
  });
});

it('makes a read-only key with no native write grants when the caller has only a read group', async () => {
  scopes = [];
  groups = ['Contacts'];
  const { user } = open();
  await start(user);
  await user.click(screen.getByRole('checkbox', { name: 'Contacts' }));
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByRole('heading', { name: 'Your new key' });
  expect(creates()[0]?.body).toEqual({
    name: 'Sourcepoint',
    scopes: [],
    readOnly: true,
    readGroups: ['Contacts'],
  });
});

it.each(['Full permitted access', 'Custom access'])(
  'limits %s to the returned grants and groups',
  async (mode) => {
    scopes = ['contacts.manage'];
    groups = ['Contacts'];
    const { user } = open(agency);
    await start(user);
    await user.click(screen.getByRole('radio', { name: mode }));
    expect(screen.queryByRole('checkbox', { name: 'Team' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Invite and remove team members' })).toBeNull();
    if (mode === 'Custom access') {
      await user.click(screen.getByRole('checkbox', { name: 'Contacts' }));
      await user.click(screen.getByRole('checkbox', { name: 'Add, change and trash contacts' }));
    }
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    await screen.findByRole('heading', { name: 'Your new key' });
    expect(creates()[0]?.body).toEqual({
      name: 'Sourcepoint',
      scopes: ['contacts.manage'],
      readOnly: false,
      readGroups: ['Contacts'],
    });
  },
);

it('does not offer creation or access presets when a legacy server omits its catalog', async () => {
  groups = undefined;
  const { user } = open();
  const create = await screen.findByRole('button', { name: 'New API key' });
  expect(create).toHaveProperty('disabled', true);
  expect(screen.getByText(/does not yet support API-key access policies/)).toBeDefined();
  await user.click(create);
  expect(screen.queryByRole('radio')).toBeNull();
  expect(creates()).toHaveLength(0);
});

it('retains the entered name, groups, custom writes and expiry after a targeted server error', async () => {
  failure = 'create';
  const { user } = open();
  await start(user);
  await user.click(screen.getByRole('radio', { name: 'Custom access' }));
  await user.click(screen.getByRole('checkbox', { name: 'Contacts' }));
  await user.click(screen.getByRole('checkbox', { name: 'Add, change and trash contacts' }));
  fireEvent.change(screen.getByLabelText('Expiry (optional)'), {
    target: { value: '2099-05-06T12:34' },
  });
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByText('Choose a later expiry.');
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Sourcepoint');
  expect(screen.getByRole('checkbox', { name: 'Contacts' })).toHaveProperty('checked', true);
  expect(screen.getByRole('checkbox', { name: 'Add, change and trash contacts' })).toHaveProperty(
    'checked',
    true,
  );
  expect(screen.getByLabelText('Expiry (optional)')).toHaveProperty('value', '2099-05-06T12:34');
  failure = undefined;
  fireEvent.change(screen.getByLabelText('Expiry (optional)'), {
    target: { value: '2099-05-07T12:34' },
  });
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByRole('heading', { name: 'Your new key' });
  const sent = bodyAsInput(creates()[1]?.body);
  expect(sent.expiresAt).toBe(new Date(2099, 4, 7, 12, 34).toISOString());
  expect(sent.readGroups).toEqual(['Contacts']);
  expect(sent.scopes).toEqual(['contacts.manage']);
});

it('rejects a past expiry at its field without sending and allows a corrected date', async () => {
  const { user } = open();
  await start(user);
  await user.click(screen.getByRole('checkbox', { name: 'Contacts' }));
  fireEvent.change(screen.getByLabelText('Expiry (optional)'), {
    target: { value: '2020-01-01T10:00' },
  });
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByText('Choose an expiry in the future.');
  expect(creates()).toHaveLength(0);
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Sourcepoint');
  fireEvent.change(screen.getByLabelText('Expiry (optional)'), {
    target: { value: '2099-01-01T10:00' },
  });
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByRole('heading', { name: 'Your new key' });
});

it('does not restore a corrected name error when selecting a read group', async () => {
  const { user } = open();
  await user.click(await screen.findByRole('button', { name: 'New API key' }));
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByText('Give the key a name, such as the app that uses it.');
  await user.type(screen.getByLabelText('Name'), 'Sourcepoint');
  expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).not.toBe('true');
  await user.click(screen.getByRole('checkbox', { name: 'Contacts' }));
  expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).not.toBe('true');
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByRole('heading', { name: 'Your new key' });
  expect(creates()).toHaveLength(1);
});

it('uses native validation when no read group or permission is selected', async () => {
  scopes = [];
  const { user } = open();
  await start(user);
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByText('Choose at least one permission or read group.');
  expect(creates()).toHaveLength(0);
});

it('shows per-key scope, read-only, what it reads and expiry state', async () => {
  items = [
    {
      ...key,
      name: 'Selected',
      scope: 'agency',
      readOnly: true,
      readGroups: ['Contacts'],
      expiresAt: '2020-01-01T00:00:00.000Z',
    },
    { ...key, id: 'key_01m4bd9fteedat3be9bqgx2045', name: 'Legacy' },
    {
      ...key,
      id: 'key_01m4bd9fteedat3be9bqgx2046',
      name: 'Empty reads',
      readGroups: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  ];
  open();
  await screen.findByText('Selected');
  expect(screen.getByText('Agency')).toBeDefined();
  expect(screen.getByText('Read-only')).toBeDefined();
  expect(screen.getByText(/^Reads Contacts ·/)).toBeDefined();
  expect(screen.getByText(/^Reads everything ·/)).toBeDefined();
  expect(screen.getByText('Everything (an older key without read limits)')).toBeDefined();
  expect(screen.getByText(/^Reads nothing ·/)).toBeDefined();
  expect(screen.getByText(/^Expired /)).toBeDefined();
  expect(screen.getByText(/^Expires /)).toBeDefined();
  expect(screen.getAllByText('Business')).toHaveLength(2);
});

it('copies once then removes the credential from the UI without caching or persistence', async () => {
  const { user, queryClient } = open();
  const write = vi.spyOn(Storage.prototype, 'setItem');
  await start(user);
  await user.click(screen.getByRole('checkbox', { name: 'Contacts' }));
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  expect(await screen.findByLabelText('Key')).toHaveProperty('value', rawKey);
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await user.click(screen.getByRole('button', { name: 'Copy' }));
  await screen.findByText('Copied.');
  expect(copy).toHaveBeenCalledWith(rawKey);
  expect(
    JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state),
    ),
  ).not.toContain(rawKey);
  expect(
    JSON.stringify(
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state),
    ),
  ).not.toContain(rawKey);
  await user.click(screen.getByRole('button', { name: 'I’ve copied it' }));
  expect(screen.queryByLabelText('Key')).toBeNull();
  expect(write).not.toHaveBeenCalled();
  write.mockRestore();
  copy.mockRestore();
});

it('keeps a failed revoke in context, then resets its notice and confirmation in another workspace', async () => {
  items = [key];
  failure = 'revoke';
  const { user, switchTo } = open();
  await user.click(await screen.findByRole('button', { name: 'Revoke Sourcepoint' }));
  await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
  await screen.findByText(/The key wasn't revoked/);
  expect(screen.getByText('Sourcepoint')).toBeDefined();
  expect(calls.find((call) => call.method === 'DELETE')?.business).toBe('business-a');
  items = [{ ...key, name: 'Agency key' }];
  switchTo({ ...agency, id: business.id });
  await screen.findByText('Agency key');
  expect(screen.queryByText('Sourcepoint')).toBeNull();
  expect(screen.queryByText(/The key wasn't revoked/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirm revoke' })).toBeNull();
});

it('discards a shown credential and draft when switching businesses', async () => {
  const { user, switchTo } = open();
  await start(user);
  await user.click(screen.getByRole('checkbox', { name: 'Contacts' }));
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByLabelText('Key');
  switchTo({ scope: 'business', id: 'business-b' });
  expect(screen.queryByLabelText('Key')).toBeNull();
  await user.click(await screen.findByRole('button', { name: 'New API key' }));
  expect(screen.getByLabelText('Name')).toHaveProperty('value', '');
  await user.type(screen.getByLabelText('Name'), 'Unsent draft');
  switchTo(agency);
  expect(screen.queryByLabelText('Name')).toBeNull();
});

it('never surfaces a late creation response in the new workspace or shared cache', async () => {
  let finish: ((response: Response) => void) | undefined;
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  delayedCreate = response;
  const { user, switchTo, queryClient } = open();
  await start(user);
  await user.click(screen.getByRole('checkbox', { name: 'Contacts' }));
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await waitFor(() => {
    expect(creates()).toHaveLength(1);
  });
  switchTo(agency);
  await screen.findByRole('button', { name: 'New API key' });
  await act(async () => {
    finish?.(Response.json({ ...key, key: rawKey }, { status: 201 }));
    await response;
  });
  expect(screen.queryByLabelText('Key')).toBeNull();
  expect(
    JSON.stringify(
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state),
    ),
  ).not.toContain(rawKey);
});

it('retains a key for manual copying when clipboard access fails', async () => {
  const { user } = open();
  await start(user);
  await user.click(screen.getByRole('checkbox', { name: 'Contacts' }));
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByLabelText('Key');
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  await user.click(screen.getByRole('button', { name: 'Copy' }));
  await screen.findByText('Copying didn’t work: select the key and copy it.');
  expect(screen.getByLabelText('Key')).toHaveProperty('value', rawKey);
  copy.mockRestore();
});

it('shows keys without management actions when the caller cannot manage them', async () => {
  canManage = false;
  items = [key];
  open();
  await screen.findByText('Sourcepoint');
  expect(screen.queryByRole('button', { name: 'New API key' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Revoke Sourcepoint' })).toBeNull();
});

it('retries a failed list without exposing management actions before the catalog is known', async () => {
  failure = 'list';
  const { user } = open();
  await screen.findByText('The keys couldn’t be loaded.');
  expect(screen.queryByRole('button', { name: 'New API key' })).toBeNull();
  failure = undefined;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByRole('button', { name: 'New API key' });
});

it('revokes an agency key without selecting a business and refreshes the list', async () => {
  items = [key];
  const { user } = open(agency);
  await user.click(await screen.findByRole('button', { name: 'Revoke Sourcepoint' }));
  await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
  await screen.findByText('Key revoked. Apps using it stop working now.');
  await screen.findByText('No API keys yet.');
  expect(calls.find((call) => call.method === 'DELETE')?.business).toBeNull();
  expect(calls.find((call) => call.method === 'DELETE')?.url).toBe(
    '/api/v1/api-keys/key_01m4bd9fteedat3be9bqgx2044',
  );
});

it('updates an expiry label when the key expires while the page is open', async () => {
  items = [{ ...key, expiresAt: new Date(Date.now() + 1500).toISOString() }];
  open();
  await screen.findByText(/^Expires /);
  await screen.findByText(/^Expired /);
});
