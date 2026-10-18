// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { CallingSetup } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { CallingSetupCard } from './phone-system-calling';

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

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const at = '2026-10-17T12:00:00.000Z';
const account = (overrides: Partial<CallingSetup> = {}): CallingSetup => ({
  connectionId: 'smsc_01k8e2wzr0e008000000000001',
  label: 'Front desk',
  connectionStatus: 'connected',
  voiceNumbers: 1,
  setup: null,
  canSetUp: true,
  ...overrides,
});

function show(accounts: readonly CallingSetup[]) {
  let current = [...accounts];
  server.answer = (operation) => {
    if (operation === 'listCallingSetups') return { data: current };
    if (operation === 'setUpCalling') {
      current = current.map((each) => ({
        ...each,
        setup: { status: 'requested', failure: null, requestedAt: at, finishedAt: null },
        canSetUp: false,
      }));
      return current[0];
    }
    if (operation === 'getPhoneSystemSettings') return undefined;
    throw new Error(`Unexpected ${operation}`);
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <CallingSetupCard businessId="biz_test" />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

it('sets up calling on an account that has none, and shows it under way', async () => {
  show([account()]);
  const row = (await screen.findByText('Front desk')).closest('li');
  if (row === null) throw new Error('No row.');
  expect(within(row).getByText('Not set up')).toBeTruthy();
  await userEvent.click(within(row).getByRole('button', { name: 'Set up calling' }));
  expect(server.calls.filter((each) => each.operation === 'setUpCalling')).toEqual([
    { operation: 'setUpCalling', input: { params: { id: account().connectionId } } },
  ]);
  expect(await screen.findByText('Setting up…')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Set up/ })).toBeNull();
});

it('says why setting up failed and offers to try again', async () => {
  show([
    account({
      setup: {
        status: 'failed',
        failure: {
          code: 'provider_rejected',
          providerErrorCode: 20003,
          message: 'Twilio refused to create the key calling needs.',
        },
        requestedAt: at,
        finishedAt: at,
      },
    }),
  ]);
  expect(await screen.findByText('Failed')).toBeTruthy();
  expect(screen.getByText('Twilio refused to create the key calling needs.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Set up again' })).toBeTruthy();
});

it('asks the person to check Twilio when it never answered', async () => {
  show([account({ setup: { status: 'unknown', failure: null, requestedAt: at, finishedAt: at } })]);
  expect(await screen.findByText('Unconfirmed')).toBeTruthy();
  expect(screen.getByText(/look under API keys for “CRM browser calling”/)).toBeTruthy();
});

it('shows a ready account with nothing to press, and a disconnected one as needing a reconnect', async () => {
  show([
    account({
      setup: { status: 'ready', failure: null, requestedAt: at, finishedAt: at },
      canSetUp: false,
    }),
    account({
      connectionId: 'smsc_01k8e2wzr0e008000000000002',
      label: 'Old account',
      connectionStatus: 'disconnected',
      canSetUp: false,
    }),
  ]);
  expect(await screen.findByText('Ready')).toBeTruthy();
  expect(screen.getByText(/isn't connected. Connect it again/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Set up/ })).toBeNull();
});

it('says when no Twilio account is connected', async () => {
  show([]);
  expect(await screen.findByText(/No Twilio account is connected yet/)).toBeTruthy();
});
