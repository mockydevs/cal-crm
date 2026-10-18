// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { BusinessSummary, OAuthAuthorizationView } from '@repo/contracts';
import { createClient } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthConsentPage } from './oauth-consent';
import { authorizationRequestOf } from './oauth-consent-rules';

vi.mock('./shell/sign-in-layout', () => ({
  SignInLayout: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
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

const appId = 'mapp_01k8e2wzr0e008000000000001';
const harbor: BusinessSummary = {
  id: 'biz_01k8e2wzr0e008000000000001',
  name: 'Harbor Lights Events',
  slug: 'harbor-lights',
  status: 'active',
  city: null,
  region: null,
  timezone: 'America/New_York',
};
const cedar: BusinessSummary = {
  ...harbor,
  id: 'biz_01k8e2wzr0e008000000000002',
  name: 'Cedar Fencing',
  slug: 'cedar',
};
const closed: BusinessSummary = {
  ...harbor,
  id: 'biz_closed',
  name: 'Closed',
  status: 'suspended',
};

const request = {
  clientId: appId,
  redirectUri: 'https://zapsync.example/cb',
  responseType: 'code',
  state: '123',
  codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  codeChallengeMethod: 'S256',
};

const consentOf = (patch: Partial<OAuthAuthorizationView> = {}): OAuthAuthorizationView =>
  ({
    kind: 'consent',
    app: {
      id: appId,
      name: 'Zap Sync',
      developer: 'Northwind Labs',
      iconUrl: 'https://zapsync.example/icon.png',
      websiteUrl: null,
    },
    scopes: ['contacts.manage'],
    readGroups: ['Contacts'],
    webhookEvents: ['contact.created'],
    missingScopes: [],
    canInstall: true,
    installed: false,
    denyUrl: 'https://zapsync.example/cb?error=access_denied&state=123',
    ...patch,
  }) as OAuthAuthorizationView;

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly business: string | null;
  readonly body: unknown;
}
let calls: Call[];
let views: Record<string, OAuthAuthorizationView>;
let failure: { readonly method: string; readonly status: number; readonly detail: string } | null;
let left: string[];
beforeEach(() => {
  calls = [];
  views = { [harbor.id]: consentOf(), [cedar.id]: consentOf({ installed: true }) };
  failure = null;
  left = [];
});

function open(businesses: readonly BusinessSummary[] = [harbor, cedar]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const fetch: typeof globalThis.fetch = (input, init) => {
    const method = init?.method ?? 'GET';
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://crm.test',
    );
    const business = new Headers(init?.headers).get('business-id');
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, business, body });
    if (failure !== null && failure.method === method)
      return Promise.resolve(
        Response.json(
          { type: 'about:blank', title: 'Error', status: failure.status, detail: failure.detail },
          { status: failure.status },
        ),
      );
    if (method === 'POST')
      return Promise.resolve(
        Response.json(
          { redirectUrl: 'https://zapsync.example/cb?code=crm_ac_x&state=123' },
          { status: 201 },
        ),
      );
    return Promise.resolve(Response.json(views[business ?? ''] ?? consentOf()));
  };
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        <OAuthConsentPage
          request={request}
          businesses={businesses}
          clientIn={(businessId) =>
            createClient({ baseUrl: '/api/v1', fetch, business: () => businessId })
          }
          leave={(url) => {
            left.push(url);
          }}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup() };
}

describe('the consent page', () => {
  it('shows the app, what it may change and read, and installs on Allow & Install', async () => {
    const { user } = open();
    expect(
      await screen.findByText('Zap Sync wants to connect to Harbor Lights Events'),
    ).toBeDefined();
    expect(screen.getByText('By Northwind Labs')).toBeDefined();
    expect(screen.getAllByRole('listitem').map((each) => each.textContent)).toEqual([
      'Add, change and trash contacts',
      'Contacts',
      'A contact is created',
    ]);
    expect(screen.getByText('It is told when:')).toBeDefined();
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/api/v1/oauth/authorize',
      business: harbor.id,
    });
    expect(new URLSearchParams(calls[0]?.search).get('state')).toBe('123');
    await user.click(screen.getByRole('button', { name: 'Allow & Install' }));
    await vi.waitFor(() => {
      expect(left).toEqual(['https://zapsync.example/cb?code=crm_ac_x&state=123']);
    });
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/v1/oauth/authorize',
      business: harbor.id,
      body: request,
    });
  });

  it('asks in the business chosen, and offers Allow where the app is installed', async () => {
    const { user } = open([harbor, cedar, closed]);
    await screen.findByText('Zap Sync wants to connect to Harbor Lights Events');
    const picker = screen.getByLabelText('Business');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((each) => each.textContent),
    ).toEqual(['Harbor Lights Events', 'Cedar Fencing']);
    await user.selectOptions(picker, cedar.id);
    expect(await screen.findByText('Zap Sync wants to connect to Cedar Fencing')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDefined();
    expect(calls.at(-1)).toMatchObject({ business: cedar.id });
  });

  it('sends the app access_denied on Cancel', async () => {
    const { user } = open([harbor]);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(left).toEqual(['https://zapsync.example/cb?error=access_denied&state=123']);
    expect(screen.queryByLabelText('Business')).toBeNull();
  });

  it('keeps Allow off for someone without every permission, or who can’t manage apps', async () => {
    views[harbor.id] = consentOf({ missingScopes: ['contacts.manage'] });
    views[cedar.id] = consentOf({ canInstall: false, scopes: [], readGroups: [] });
    const { user } = open();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'It asks for permissions you don’t have here:',
    );
    expect(screen.getByRole('button', { name: 'Allow & Install' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.selectOptions(screen.getByLabelText('Business'), cedar.id);
    expect(
      await screen.findByText('Only people who can manage apps and API keys connect apps here.'),
    ).toBeDefined();
    expect(screen.getByText('It asks to change nothing.')).toBeDefined();
    expect(screen.getByText('It reads nothing.')).toBeDefined();
  });

  it('sends a refusal back to the app only when asked to', async () => {
    views[harbor.id] = {
      kind: 'refused',
      error: 'invalid_scope',
      description: 'The app may not ask for payments.manage here.',
      redirectUrl: 'https://zapsync.example/cb?error=invalid_scope&state=123',
    };
    const { user } = open([harbor]);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The app’s request can’t be accepted: The app may not ask for payments.manage here.',
    );
    expect(left).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Back to the app' }));
    expect(left).toEqual(['https://zapsync.example/cb?error=invalid_scope&state=123']);
  });

  it('shows a link the app can’t be told about, and never leaves', async () => {
    failure = { method: 'GET', status: 422, detail: 'This link doesn’t name an app.' };
    open([harbor]);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This connection link doesn’t work.');
    expect(alert.textContent).toContain('This link doesn’t name an app.');
    expect(left).toEqual([]);
  });

  it('says when allowing failed, in the server’s words', async () => {
    failure = {
      method: 'POST',
      status: 403,
      detail: 'You can connect an app only with permissions you have.',
    };
    const { user } = open([harbor]);
    await user.click(await screen.findByRole('button', { name: 'Allow & Install' }));
    expect(
      await screen.findByText('You can connect an app only with permissions you have.'),
    ).toBeDefined();
    expect(left).toEqual([]);
  });

  it('says so when the person works in no open business', () => {
    open([closed]);
    expect(
      screen.getByText('You don’t work in a business an app could be connected to.'),
    ).toBeDefined();
    expect(calls).toEqual([]);
  });
});

describe('the address', () => {
  it('reads the OAuth parameters as the app wrote them, leaving out what is absent', () => {
    expect(
      authorizationRequestOf(
        '?client_id=mapp_x&redirect_uri=https%3A%2F%2Fa.example%2Fcb&response_type=code&state=%22123%22&scope=tags.manage+contacts.manage&code_challenge=abc&code_challenge_method=S256&other=1',
      ),
    ).toEqual({
      clientId: 'mapp_x',
      redirectUri: 'https://a.example/cb',
      responseType: 'code',
      state: '"123"',
      scope: 'tags.manage contacts.manage',
      codeChallenge: 'abc',
      codeChallengeMethod: 'S256',
    });
    expect(authorizationRequestOf('')).toEqual({});
  });
});
